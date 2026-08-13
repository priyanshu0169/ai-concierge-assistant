import assert from 'node:assert/strict';
import { UpstreamError } from '@shopsage/platform';
import { after, before, describe, it } from 'node:test';
import { createApp } from '../src/app.js';
import { createHealthService } from '../src/health/health-service.js';
import { readJson, readSseEvents, startTestServer } from './helpers/start-test-server.js';
import {
  buildTestConfig,
  createSilentLogger,
  createStubAssistant,
  createStubAuthentication,
} from './helpers/test-doubles.js';

/**
 * Tests the **SSE surface** of `/v1/chat/stream`: framing, event order, headers, and which
 * failures are status codes versus events.
 *
 * The conversation manager is stubbed. What happens inside a turn belongs to
 * `assistant-core` and is tested there; what is left here is the wire protocol, which is
 * the part a widget depends on and the part no unit test can see.
 *
 * @param {Parameters<typeof createStubAssistant>[0]} [script]
 * @param {Record<string, string | undefined>} [env]
 * @param {Record<string, unknown>} [features]
 */
function buildStreamApp(script, env, features) {
  const config = buildTestConfig({ env, features });
  const assistant = createStubAssistant(script);

  return {
    assistant,
    authentication: createStubAuthentication(),
    app: createApp({
      config,
      logger: createSilentLogger(),
      healthService: createHealthService({ serviceName: 'test', version: '0.1.0-test' }),
      assistant,
      authentication: createStubAuthentication(),
    }),
  };
}

/**
 * @param {import('./helpers/start-test-server.js').TestServer} server
 * @param {unknown} body
 * @returns {Promise<Response>}
 */
function postStream(server, body) {
  return server.request('/v1/chat/stream', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

describe('POST /v1/chat/stream', () => {
  /** @type {import('./helpers/start-test-server.js').TestServer} */
  let server;
  /** @type {ReturnType<typeof createStubAssistant>} */
  let assistant;

  before(async () => {
    const built = buildStreamApp({
      answer: 'Thirty days, unopened.',
      deltas: ['Thirty ', 'days, ', 'unopened.'],
      sources: [{ title: 'Returns policy', url: 'https://example.com/help/returns' }],
    });
    assistant = built.assistant;
    server = await startTestServer(built.app);
  });

  after(async () => {
    await server.close();
  });

  describe('framing', () => {
    it('answers as an event stream', async () => {
      const response = await postStream(server, { message: 'Returns?' });

      assert.equal(response.status, 200);
      assert.match(response.headers.get('content-type') ?? '', /^text\/event-stream/);
      await response.text();
    });

    it('tells every proxy in the path not to buffer or transform it', async () => {
      // Nginx buffers proxied responses by default, which holds every event until the
      // response ends. The symptom is a stream that works locally and not in production,
      // with nothing in any log to explain it.
      const response = await postStream(server, { message: 'Returns?' });

      assert.match(response.headers.get('cache-control') ?? '', /no-cache/);
      assert.match(response.headers.get('cache-control') ?? '', /no-transform/);
      assert.equal(response.headers.get('x-accel-buffering'), 'no');
      await response.text();
    });

    it('emits start first and done last', async () => {
      const events = await readSseEvents(await postStream(server, { message: 'Returns?' }));

      assert.equal(events.at(0)?.name, 'start');
      assert.equal(events.at(-1)?.name, 'done');
      assert.equal(events.filter((event) => event.name === 'done').length, 1);
    });

    it('carries the conversation id in start, before any model call', async () => {
      // A client that loses the connection immediately still holds the id it needs to
      // continue, which it could not reconstruct from a half-received answer.
      const events = await readSseEvents(await postStream(server, { message: 'Returns?' }));

      assert.deepEqual(Object.keys(events[0].data).sort(), ['conversationId', 'messageId']);
      assert.equal(typeof events[0].data.conversationId, 'string');
    });

    it('streams the answer as separate delta events', async () => {
      const events = await readSseEvents(await postStream(server, { message: 'Returns?' }));
      const deltas = events.filter((event) => event.name === 'delta');

      assert.equal(deltas.length, 3);
      assert.equal(deltas.map((event) => event.data.text).join(''), 'Thirty days, unopened.');
    });
  });

  describe('the done event', () => {
    it('is the same shape POST /v1/chat returns', async () => {
      // One serializer for both endpoints, so the two cannot drift into different shapes
      // for the same answer.
      const events = await readSseEvents(await postStream(server, { message: 'Returns?' }));
      const done = events.at(-1)?.data;

      assert.deepEqual(Object.keys(done).sort(), [
        'answer',
        'conversationId',
        'finishReason',
        'messageId',
        'sources',
      ]);
    });

    it('carries the citations', async () => {
      const events = await readSseEvents(await postStream(server, { message: 'Returns?' }));

      assert.deepEqual(events.at(-1)?.data.sources, [
        { title: 'Returns policy', url: 'https://example.com/help/returns' },
      ]);
    });

    it('repeats the ids from start, so a client may ignore start entirely', async () => {
      const events = await readSseEvents(await postStream(server, { message: 'Returns?' }));

      assert.equal(events.at(-1)?.data.conversationId, events[0].data.conversationId);
      assert.equal(events.at(-1)?.data.messageId, events[0].data.messageId);
    });
  });

  describe('what it does not publish', () => {
    it('never leaks the grounded flag or token usage', async () => {
      const body = await (await postStream(server, { message: 'Returns?' })).text();

      assert.ok(!body.includes('grounded'));
      assert.ok(!body.includes('usage'));
      assert.ok(!body.includes('Tokens'));
    });
  });

  describe('correlation', () => {
    it('forwards the request id to the domain', async () => {
      await (await postStream(server, { message: 'Correlate me.' })).text();

      assert.equal(typeof assistant.requests.at(-1)?.metadata?.requestId, 'string');
    });

    it('passes a supplied conversation id through', async () => {
      await (await postStream(server, { conversationId: 'c_abc', message: 'And abroad?' })).text();

      assert.equal(assistant.requests.at(-1)?.conversationId, 'c_abc');
    });

    it('supplies an abort signal, so a closed tab stops the gateway billing', async () => {
      await (await postStream(server, { message: 'Hi.' })).text();

      assert.ok(assistant.requests.at(-1)?.signal instanceof AbortSignal);
    });
  });

  describe('failures that are still status codes', () => {
    /**
     * @param {unknown} body
     * @returns {Promise<any>}
     */
    async function rejectedBody(body) {
      const response = await postStream(server, body);
      const parsed = await readJson(response);

      assert.equal(response.status, 400);
      assert.equal(parsed.error.code, 'VALIDATION_FAILED');
      // Not an event stream: nothing was sent, so the envelope still applies.
      assert.match(response.headers.get('content-type') ?? '', /application\/json/);

      return parsed;
    }

    it('rejects a missing message with a JSON envelope, not an error event', async () => {
      await rejectedBody({});
    });

    it('rejects an oversized message', async () => {
      await rejectedBody({ message: 'x'.repeat(2001) });
    });

    it('rejects an unknown field', async () => {
      await rejectedBody({ message: 'Hi.', temperature: 2 });
    });

    it('does not reach the domain on an invalid request', async () => {
      const before = assistant.requests.length;

      await postStream(server, { message: '' });

      assert.equal(assistant.requests.length, before);
    });

    it('404s when the store has not enabled streaming', async () => {
      // A capability a store has not enabled does not exist for that store; the
      // alternative advertises a feature the caller cannot use.
      const built = buildStreamApp(undefined, undefined, { streaming: false });
      const disabled = await startTestServer(built.app);

      try {
        const response = await postStream(disabled, { message: 'Hi.' });

        assert.equal(response.status, 404);
        assert.equal((await readJson(response)).error.code, 'NOT_FOUND');
        assert.equal(built.assistant.requests.length, 0);
      } finally {
        await disabled.close();
      }
    });

    it('reports a failure before the first event as a real status code', async () => {
      // The reason the stream opens lazily rather than on construction: a turn that dies
      // before it starts is an ordinary 502, which proxies and monitoring understand.
      const built = buildStreamApp(
        { error: new UpstreamError('gateway unreachable') },
        { NODE_ENV: 'production' },
      );
      const failing = await startTestServer(built.app);

      try {
        const response = await postStream(failing, { message: 'Hi.' });

        assert.equal(response.status, 502);
        assert.equal((await readJson(response)).error.code, 'UPSTREAM_FAILURE');
      } finally {
        await failing.close();
      }
    });
  });

  describe('failures that can only be events', () => {
    it('reports a mid-stream failure as an error event, masked', async () => {
      // The 200 is already on the wire by then. Asserted under production, because that is
      // where the masking guarantee has to hold.
      const built = buildStreamApp(
        {
          deltas: ['Thirty ', 'days'],
          errorAfter: 1,
        },
        { NODE_ENV: 'production' },
      );
      const failing = await startTestServer(built.app);

      try {
        const response = await postStream(failing, { message: 'Hi.' });
        const events = await readSseEvents(response);
        const last = events.at(-1);

        assert.equal(response.status, 200);
        assert.equal(last?.name, 'error');
        assert.match(last?.data.error.message, /An unexpected error occurred/);
        assert.ok(!last?.data.error.stack);
        // The text sent before the failure stands; it was already rendered.
        assert.equal(events.filter((event) => event.name === 'delta').length, 1);
        assert.equal(events.filter((event) => event.name === 'done').length, 0);
      } finally {
        await failing.close();
      }
    });

    it('does not leak the internal message into the error event', async () => {
      const built = buildStreamApp(
        { deltas: ['a', 'b'], errorAfter: 1 },
        { NODE_ENV: 'production' },
      );
      const failing = await startTestServer(built.app);

      try {
        const body = await (await postStream(failing, { message: 'Hi.' })).text();

        assert.ok(!body.includes('gateway died mid-stream'));
      } finally {
        await failing.close();
      }
    });
  });

  it('rejects a GET on the streaming endpoint', async () => {
    assert.equal((await server.request('/v1/chat/stream')).status, 404);
  });
});
