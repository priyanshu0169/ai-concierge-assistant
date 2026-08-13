import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createApp } from '../src/app.js';
import { createHealthService } from '../src/health/health-service.js';
import { readJson, startTestServer, until } from './helpers/start-test-server.js';
import {
  buildTestConfig,
  createSilentLogger,
  createStubAssistant,
  createStubAuthentication,
  createStubProbe,
} from './helpers/test-doubles.js';

/**
 * The rate limiter as a client experiences it: status codes, headers, and which routes it
 * applies to. The algorithm itself is tested in `rate-limit.test.js` against a fake clock.
 *
 * @param {Record<string, string | undefined>} [env]
 * @param {Parameters<typeof createStubAssistant>[0]} [script]
 */
function buildLimitedApp(env, script) {
  const config = buildTestConfig({ env });
  const assistant = createStubAssistant(script);

  return {
    assistant,
    app: createApp({
      config,
      logger: createSilentLogger(),
      healthService: createHealthService({
        serviceName: 'test',
        version: '0.1.0-test',
        probes: [createStubProbe('qdrant', 'up')],
      }),
      assistant,
      authentication: createStubAuthentication(),
    }),
  };
}

/**
 * @param {import('./helpers/start-test-server.js').TestServer} server
 * @param {string} [path]
 */
const ask = (server, path = '/v1/chat') =>
  server.request(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ message: 'Hello.' }),
  });

describe('rate limiting', () => {
  it('permits requests inside the limit', async () => {
    const server = await startTestServer(buildLimitedApp({ RATE_LIMIT_MAX_REQUESTS: '3' }).app);

    try {
      for (let i = 0; i < 3; i += 1) {
        assert.equal((await ask(server)).status, 200);
      }
    } finally {
      await server.close();
    }
  });

  it('refuses with 429 past the limit', async () => {
    const server = await startTestServer(buildLimitedApp({ RATE_LIMIT_MAX_REQUESTS: '2' }).app);

    try {
      await ask(server);
      await ask(server);
      const response = await ask(server);
      const body = await readJson(response);

      assert.equal(response.status, 429);
      assert.equal(body.error.code, 'RATE_LIMITED');
      assert.match(body.error.message, /Too many requests/);
    } finally {
      await server.close();
    }
  });

  it('sends Retry-After on a refusal', async () => {
    // The one part of an error that belongs in a header: clients, proxies and browsers
    // act on it automatically.
    const server = await startTestServer(
      buildLimitedApp({ RATE_LIMIT_MAX_REQUESTS: '1', RATE_LIMIT_WINDOW_MS: '60000' }).app,
    );

    try {
      await ask(server);
      const response = await ask(server);

      assert.ok(Number(response.headers.get('retry-after')) > 0);
    } finally {
      await server.close();
    }
  });

  it('reports the budget on a successful response too', async () => {
    // So a client can slow down before it is refused, rather than discovering the limit
    // by hitting it.
    const server = await startTestServer(buildLimitedApp({ RATE_LIMIT_MAX_REQUESTS: '5' }).app);

    try {
      const response = await ask(server);

      assert.equal(response.headers.get('ratelimit-limit'), '5');
      assert.equal(response.headers.get('ratelimit-remaining'), '4');
      assert.ok(response.headers.get('ratelimit-reset') !== null);
    } finally {
      await server.close();
    }
  });

  it('never throttles the health endpoints', async () => {
    // An orchestrator polls readiness on a fixed interval. Throttling it would make a
    // healthy instance report a false outage and be pulled from the load balancer —
    // turning a protection into the outage it exists to prevent.
    const server = await startTestServer(buildLimitedApp({ RATE_LIMIT_MAX_REQUESTS: '1' }).app);

    try {
      for (let i = 0; i < 5; i += 1) {
        assert.equal((await server.request('/health')).status, 200);
        assert.equal((await server.request('/health/ready')).status, 200);
      }
    } finally {
      await server.close();
    }
  });

  it('counts the streaming endpoint against the same budget', async () => {
    // Otherwise the cheaper-to-abuse endpoint is the unlimited one.
    const server = await startTestServer(buildLimitedApp({ RATE_LIMIT_MAX_REQUESTS: '1' }).app);

    try {
      await ask(server, '/v1/chat');

      assert.equal((await ask(server, '/v1/chat/stream')).status, 429);
    } finally {
      await server.close();
    }
  });

  it('counts a rejected request against the budget', async () => {
    // A malformed request still costs parsing and a round trip, so a flood of 400s must
    // not be free.
    const server = await startTestServer(buildLimitedApp({ RATE_LIMIT_MAX_REQUESTS: '2' }).app);

    try {
      const invalid = () =>
        server.request('/v1/chat', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({}),
        });

      assert.equal((await invalid()).status, 400);
      assert.equal((await invalid()).status, 400);
      assert.equal((await invalid()).status, 429);
    } finally {
      await server.close();
    }
  });

  it('can be turned off, and then sends no headers', async () => {
    const server = await startTestServer(
      buildLimitedApp({ RATE_LIMIT_ENABLED: 'false', RATE_LIMIT_MAX_REQUESTS: '1' }).app,
    );

    try {
      await ask(server);
      const response = await ask(server);

      assert.equal(response.status, 200);
      assert.equal(response.headers.get('ratelimit-limit'), null);
    } finally {
      await server.close();
    }
  });
});

describe('stream concurrency', () => {
  it('refuses a client holding too many streams at once, with 429', async () => {
    // A stream is held, not spent: a client well inside its request rate can still keep
    // several LLM generations running.
    const built = buildLimitedApp(
      { MAX_CONCURRENT_STREAMS_PER_CLIENT: '1', RATE_LIMIT_MAX_REQUESTS: '100' },
      { deltas: ['slow'], holdMs: 200 },
    );
    const server = await startTestServer(built.app);

    try {
      const first = ask(server, '/v1/chat/stream');
      // Wait for the first request to actually hold its slot, rather than guessing how long
      // that takes: the stub records a request only once its generator starts, which is
      // after `acquire()`.
      await until(() => built.assistant.requests.length === 1, { label: 'the first stream' });
      const second = await ask(server, '/v1/chat/stream');

      assert.equal(second.status, 429);
      assert.equal((await readJson(second)).error.details.scope, 'client');

      await (await first).text();
    } finally {
      await server.close();
    }
  });

  it('releases the slot when the stream finishes', async () => {
    const built = buildLimitedApp(
      { MAX_CONCURRENT_STREAMS_PER_CLIENT: '1', RATE_LIMIT_MAX_REQUESTS: '100' },
      { deltas: ['a'] },
    );
    const server = await startTestServer(built.app);

    try {
      await (await ask(server, '/v1/chat/stream')).text();

      assert.equal((await ask(server, '/v1/chat/stream')).status, 200);
    } finally {
      await server.close();
    }
  });

  it('answers 503, not 429, when the service as a whole is full', async () => {
    // Not any one client's fault. A well-behaved customer must not be told they are
    // being throttled when the service is simply at capacity.
    const built = buildLimitedApp(
      {
        MAX_CONCURRENT_STREAMS: '1',
        MAX_CONCURRENT_STREAMS_PER_CLIENT: '5',
        RATE_LIMIT_MAX_REQUESTS: '100',
      },
      { deltas: ['slow'], holdMs: 200 },
    );
    const server = await startTestServer(built.app);

    try {
      const first = ask(server, '/v1/chat/stream');
      await until(() => built.assistant.requests.length === 1, { label: 'the first stream' });
      const second = await ask(server, '/v1/chat/stream');

      assert.equal(second.status, 503);
      const body = await readJson(second);
      assert.equal(body.error.code, 'SERVICE_UNAVAILABLE');
      assert.equal(body.error.details.scope, 'service');
      assert.ok(Number(second.headers.get('retry-after')) > 0);

      await (await first).text();
    } finally {
      await server.close();
    }
  });

  it('does not limit the buffered endpoint by concurrency', async () => {
    // It does not hold a connection, so the request rate is the right control for it.
    const server = await startTestServer(
      buildLimitedApp({ MAX_CONCURRENT_STREAMS: '1', RATE_LIMIT_MAX_REQUESTS: '100' }).app,
    );

    try {
      const responses = await Promise.all([ask(server), ask(server), ask(server)]);

      assert.deepEqual(
        responses.map((response) => response.status),
        [200, 200, 200],
      );
    } finally {
      await server.close();
    }
  });
});
