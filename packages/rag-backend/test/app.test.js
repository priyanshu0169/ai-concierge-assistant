import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { createApp } from '../src/app.js';
import { createHealthService } from '../src/health/health-service.js';
import { readJson, startTestServer } from './helpers/start-test-server.js';
import {
  buildTestConfig,
  createSilentLogger,
  createStubAssistant,
  createStubAuthentication,
  createStubProbe,
} from './helpers/test-doubles.js';

/**
 * @param {{ probeStatus?: 'up' | 'down', env?: Record<string, string | undefined> }} [options]
 * @returns {import('express').Express}
 */
function buildApp(options = {}) {
  const { probeStatus = 'up', env } = options;
  const config = buildTestConfig({ env });

  const healthService = createHealthService({
    serviceName: config.env.SERVICE_NAME,
    version: '0.1.0-test',
    probes: [createStubProbe('qdrant', probeStatus), createStubProbe('embeddings', 'up')],
  });

  return createApp({
    config,
    logger: createSilentLogger(),
    healthService,
    assistant: createStubAssistant(),
    authentication: createStubAuthentication(),
  });
}

describe('backend HTTP surface', () => {
  /** @type {import('./helpers/start-test-server.js').TestServer} */
  let server;

  before(async () => {
    server = await startTestServer(buildApp());
  });

  after(async () => {
    await server.close();
  });

  describe('GET /health', () => {
    it('returns liveness', async () => {
      const response = await server.request('/health');
      const body = await readJson(response);

      assert.equal(response.status, 200);
      assert.equal(body.status, 'ok');
      assert.equal(body.service, 'shopsage-backend');
      assert.equal(body.version, '0.1.0-test');
      assert.equal(typeof body.uptimeSeconds, 'number');
    });

    it('forbids caching, so an orchestrator never acts on a stale answer', async () => {
      const response = await server.request('/health');

      assert.equal(response.headers.get('cache-control'), 'no-store');
    });
  });

  describe('GET /health/ready', () => {
    it('returns 200 and per-dependency detail when all dependencies are up', async () => {
      const response = await server.request('/health/ready');
      const body = await readJson(response);

      assert.equal(response.status, 200);
      assert.equal(body.status, 'ok');
      assert.deepEqual(
        body.checks.map((/** @type {{ name: string }} */ check) => check.name),
        ['qdrant', 'embeddings'],
      );
    });

    it('returns 503 when a dependency is down', async () => {
      const degraded = await startTestServer(buildApp({ probeStatus: 'down' }));

      try {
        const response = await degraded.request('/health/ready');
        const body = await readJson(response);

        assert.equal(response.status, 503);
        assert.equal(body.status, 'degraded');
      } finally {
        await degraded.close();
      }
    });
  });

  describe('GET /health/info', () => {
    it('reflects the loaded site profile rather than anything hard-coded', async () => {
      const response = await server.request('/health/info');
      const body = await readJson(response);

      assert.equal(response.status, 200);
      assert.deepEqual(body.site, {
        siteId: 'test-store',
        companyName: 'Test Store',
        assistantName: 'Helper',
      });
      assert.equal(body.localization.locale, 'en-GB');
      assert.equal(body.localization.currency, 'GBP');
    });

    it('lists only the features the profile enabled', async () => {
      const response = await server.request('/health/info');
      const body = await readJson(response);

      assert.deepEqual(body.enabledFeatures.sort(), [
        'knowledgeSearch',
        'productSearch',
        'streaming',
      ]);
    });

    it('never exposes a secret or a dependency URL', async () => {
      const response = await server.request('/health/info');
      const serialized = JSON.stringify(await readJson(response));

      for (const forbidden of ['API_KEY', 'TOKEN', 'qdrant', 'systemPrompt']) {
        assert.ok(!serialized.includes(forbidden), `/health/info leaked ${forbidden}`);
      }
    });
  });

  describe('correlation', () => {
    it('generates a request id and echoes it', async () => {
      const response = await server.request('/health');
      const requestId = response.headers.get('x-request-id');

      assert.match(requestId ?? '', /^[0-9a-f-]{36}$/);
    });

    it('continues a trace started upstream', async () => {
      const response = await server.request('/health', {
        headers: { 'x-request-id': 'storefront-abc-123' },
      });

      assert.equal(response.headers.get('x-request-id'), 'storefront-abc-123');
    });

    it('replaces an inbound id that could poison the logs', async () => {
      const response = await server.request('/health', {
        headers: { 'x-request-id': 'a'.repeat(400) },
      });

      assert.match(response.headers.get('x-request-id') ?? '', /^[0-9a-f-]{36}$/);
    });
  });

  describe('errors', () => {
    it('returns the standard envelope for an unknown route', async () => {
      const response = await server.request('/does-not-exist');
      const body = await readJson(response);

      assert.equal(response.status, 404);
      assert.equal(body.error.code, 'NOT_FOUND');
      assert.match(body.error.message, /Route not found: GET \/does-not-exist/);
      assert.equal(body.error.requestId, response.headers.get('x-request-id'));
    });

    it('rejects a malformed JSON body as a client error, not a server error', async () => {
      const response = await server.request('/health', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{ "message": ',
      });
      const body = await readJson(response);

      assert.equal(response.status, 400);
      assert.equal(body.error.code, 'VALIDATION_FAILED');
    });

    it('rejects an oversized body', async () => {
      const response = await server.request('/health', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ message: 'x'.repeat(200_000) }),
      });

      assert.equal(response.status, 413);
    });
  });

  describe('browser integration', () => {
    it('does not advertise the server implementation', async () => {
      const response = await server.request('/health');

      assert.equal(response.headers.get('x-powered-by'), null);
    });

    it('allows the storefront origin through CORS', async () => {
      const restricted = await startTestServer(
        buildApp({ env: { CORS_ALLOWED_ORIGINS: 'https://shop.example.com' } }),
      );

      try {
        const allowed = await restricted.request('/health', {
          headers: { origin: 'https://shop.example.com' },
        });
        const blocked = await restricted.request('/health', {
          headers: { origin: 'https://evil.example.com' },
        });

        assert.equal(
          allowed.headers.get('access-control-allow-origin'),
          'https://shop.example.com',
        );
        assert.equal(blocked.headers.get('access-control-allow-origin'), null);
      } finally {
        await restricted.close();
      }
    });

    it('never permits credentialed cross-origin requests', async () => {
      const response = await server.request('/health', {
        headers: { origin: 'https://shop.example.com' },
      });

      assert.equal(response.headers.get('access-control-allow-credentials'), null);
    });
  });
});
