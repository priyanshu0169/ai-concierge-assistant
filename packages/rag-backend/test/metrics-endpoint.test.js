import assert from 'node:assert/strict';
import { ConfigurationError, createMetricsRegistry } from '@shopsage/platform';
import { after, before, describe, it } from 'node:test';
import { createApp } from '../src/app.js';
import { buildMetrics } from '../src/composition/build-metrics.js';
import { createHealthService } from '../src/health/health-service.js';
import { createInstruments } from '../src/observability/create-instruments.js';
import { readJson, startTestServer } from './helpers/start-test-server.js';
import {
  buildTestConfig,
  createSilentLogger,
  createStubAssistant,
  createStubAuthentication,
} from './helpers/test-doubles.js';

const TOKEN = 'a-long-enough-metrics-token';

/** @param {{ withMetrics?: boolean }} [options] */
function buildMetricsApp(options = {}) {
  const config = buildTestConfig({ env: { RATE_LIMIT_ENABLED: 'false' } });
  const registry = createMetricsRegistry({ constantLabels: { site: 'test-store' } });
  const metrics = {
    instruments: createInstruments(registry),
    render: registry.render,
    token: TOKEN,
  };

  const app = createApp({
    config,
    logger: createSilentLogger(),
    healthService: createHealthService({ serviceName: 'test', version: '0.1.0-test' }),
    assistant: createStubAssistant(),
    authentication: createStubAuthentication(),
    ...(options.withMetrics === false ? {} : { metrics }),
  });

  return { app, registry };
}

describe('GET /metrics', () => {
  /** @type {import('./helpers/start-test-server.js').TestServer} */
  let server;

  before(async () => {
    server = await startTestServer(buildMetricsApp().app);
  });

  after(() => server?.close());

  it('serves the exposition format to a scraper with the token', async () => {
    const response = await server.request('/metrics', {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    const body = await response.text();

    assert.equal(response.status, 200);
    // The format's own version, which stricter agents content-negotiate on.
    assert.match(String(response.headers.get('content-type')), /version=0\.0\.4/u);
    assert.match(body, /# TYPE shopsage_http_requests_total counter/u);
  });

  it('refuses a request with no credential', async () => {
    const response = await server.request('/metrics');
    const body = await readJson(response);

    assert.equal(response.status, 401);
    assert.equal(body.error.code, 'UNAUTHORIZED');
  });

  it('refuses a wrong credential, and says nothing about why', async () => {
    const response = await server.request('/metrics', {
      headers: { authorization: 'Bearer not-the-right-token-at-all' },
    });
    const body = await readJson(response);

    assert.equal(response.status, 401);
    // A scraper misconfiguration is diagnosed from the scraper's logs; naming the wrong part helps
    // somebody guessing more than it helps an operator.
    assert.ok(!JSON.stringify(body).includes(TOKEN));
    assert.ok(!/length|prefix|expected/iu.test(body.error.message));
  });

  it('refuses a credential of a different length without throwing', async () => {
    // `timingSafeEqual` throws on a length mismatch rather than returning false, so the length is
    // compared first. Without that this is a 500.
    const response = await server.request('/metrics', { headers: { authorization: 'Bearer x' } });

    assert.equal(response.status, 401);
  });

  it('records the requests it served', async () => {
    const built = buildMetricsApp();
    const own = await startTestServer(built.app);

    try {
      await own.request('/health');
      await own.request('/health');
      await own.request('/v1/config');

      const body = await (
        await own.request('/metrics', { headers: { authorization: `Bearer ${TOKEN}` } })
      ).text();

      assert.match(body, /shopsage_http_requests_total\{[^}]*route="\/health"[^}]*\} 2/u);
      assert.match(body, /shopsage_http_requests_total\{[^}]*route="\/v1\/config"[^}]*\} 1/u);
      assert.match(
        body,
        /shopsage_http_request_duration_ms_count\{[^}]*route="\/health"[^}]*\} 2/u,
      );
    } finally {
      await own.close();
    }
  });

  it('collapses an unknown path to `other`, so a caller cannot create series', async () => {
    const built = buildMetricsApp();
    const own = await startTestServer(built.app);

    try {
      for (const path of ['/aaa1', '/aaa2', '/aaa3']) await own.request(path);

      const body = await (
        await own.request('/metrics', { headers: { authorization: `Bearer ${TOKEN}` } })
      ).text();

      // The most important assertion here. A metric labelled with a raw path lets anybody who can send a
      // request create unbounded series that never expire, and the monitoring system falls over before
      // the service does.
      assert.match(body, /shopsage_http_requests_total\{[^}]*route="other"[^}]*\} 3/u);
      assert.ok(!body.includes('aaa1'));
    } finally {
      await own.close();
    }
  });

  it('carries the site label onto every series', async () => {
    const body = await (
      await server.request('/metrics', { headers: { authorization: `Bearer ${TOKEN}` } })
    ).text();

    // One Prometheus can scrape several stores' deployments and still tell them apart.
    assert.match(body, /site="test-store"/u);
  });

  it('publishes no customer text, conversation id or subject', async () => {
    const built = buildMetricsApp();
    const own = await startTestServer(built.app);

    try {
      await own.request('/v1/chat', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ message: 'my order is ORD-100482 and I am ps_somebody' }),
      });

      const body = await (
        await own.request('/metrics', { headers: { authorization: `Bearer ${TOKEN}` } })
      ).text();

      assert.ok(!body.includes('ORD-100482'));
      assert.ok(!body.includes('ps_somebody'));
      assert.ok(!body.includes('c_'));
    } finally {
      await own.close();
    }
  });
});

describe('when metrics are disabled', () => {
  it('does not mount the endpoint at all', async () => {
    const server = await startTestServer(buildMetricsApp({ withMetrics: false }).app);

    try {
      // 404, not 401. There is no endpoint, which is honest — and it means a disabled feature does no
      // work rather than doing its work behind a gate.
      assert.equal((await server.request('/metrics')).status, 404);
    } finally {
      await server.close();
    }
  });
});

describe('composing metrics', () => {
  it('returns nothing when the flag is off', () => {
    const config = buildTestConfig({ env: { METRICS_ENABLED: 'false' } });

    assert.equal(buildMetrics(config, createSilentLogger()), undefined);
  });

  it('refuses to boot with metrics on and no token', () => {
    const config = buildTestConfig({ env: { METRICS_ENABLED: 'true' } });

    assert.throws(
      () => buildMetrics(config, createSilentLogger()),
      (error) => {
        assert.ok(error instanceof ConfigurationError);
        // Serving it open would publish token spend and traffic volume silently, which is the worst
        // combination. The same rule as CONVERSATION_STORE: where a wrong guess is invisible, refuse.
        assert.match(error.message, /METRICS_TOKEN is required/u);

        return true;
      },
    );
  });

  it('rejects a token short enough to guess', () => {
    assert.throws(
      () => buildTestConfig({ env: { METRICS_ENABLED: 'true', METRICS_TOKEN: 'short' } }),
      (/** @type {any} */ error) => {
        // The schema rejects it, so the variable is named in `details` rather than in the message - the
        // env parser reports every invalid variable at once and keeps the message generic.
        assert.match(JSON.stringify(error.details), /METRICS_TOKEN/u);

        return true;
      },
    );
  });

  it('builds instruments when configured', () => {
    const config = buildTestConfig({
      env: { METRICS_ENABLED: 'true', METRICS_TOKEN: TOKEN },
    });
    const built = buildMetrics(config, createSilentLogger());

    assert.ok(built);
    assert.equal(built.token, TOKEN);
    assert.match(built.render(), /# TYPE shopsage_http_requests_total counter/u);
  });
});
