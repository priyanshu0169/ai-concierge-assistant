import assert from 'node:assert/strict';
import { UpstreamError, ValidationError } from '@shopsage/platform';
import { after, before, describe, it } from 'node:test';
import { createApp } from '../src/app.js';
import { createHealthService } from '../src/health/health-service.js';
import { readJson, startTestServer } from './helpers/start-test-server.js';
import {
  buildTestConfig,
  createSilentLogger,
  createStubAssistant,
  createStubAuthentication,
} from './helpers/test-doubles.js';

/**
 * Tests the **HTTP surface** of `/v1/chat` and nothing else.
 *
 * The conversation manager is stubbed on purpose. What happens inside a turn — whether a
 * tool is called, how sources are ranked, what an empty answer becomes — belongs to
 * `assistant-core` and is tested there, without an Express app in the way. What is left
 * here is the contract: shape, status codes, validation, and the error envelope.
 *
 * @param {Parameters<typeof createStubAssistant>[0]} [script]
 * @param {Record<string, string | undefined>} [env]
 */
function buildChatApp(script, env) {
  const config = buildTestConfig({ env });
  const assistant = createStubAssistant(script);

  const app = createApp({
    config,
    logger: createSilentLogger(),
    healthService: createHealthService({ serviceName: 'test', version: '0.1.0-test' }),
    assistant,
    authentication: createStubAuthentication(),
  });

  return { app, assistant };
}

/**
 * @param {import('./helpers/start-test-server.js').TestServer} server
 * @param {unknown} body
 * @returns {Promise<Response>}
 */
function postChat(server, body) {
  return server.request('/v1/chat', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

describe('POST /v1/chat', () => {
  /** @type {import('./helpers/start-test-server.js').TestServer} */
  let server;
  /** @type {ReturnType<typeof createStubAssistant>} */
  let assistant;

  before(async () => {
    const built = buildChatApp({
      answer: 'Thirty days, unopened.',
      sources: [{ title: 'Returns policy', url: 'https://example.com/help/returns' }],
    });
    assistant = built.assistant;
    server = await startTestServer(built.app);
  });

  after(async () => {
    await server.close();
  });

  it('answers with the published contract shape, unchanged since Stage 2', async () => {
    const response = await postChat(server, { message: 'What is your return policy?' });
    const body = await readJson(response);

    assert.equal(response.status, 200);
    assert.deepEqual(Object.keys(body).sort(), [
      'answer',
      'conversationId',
      'finishReason',
      'messageId',
      'sources',
    ]);
    assert.equal(body.answer, 'Thirty days, unopened.');
  });

  it('now returns populated sources', async () => {
    // The visible difference Stage 6 makes: `sources` was always present and always
    // empty; it is now the citations behind the answer.
    const body = await readJson(await postChat(server, { message: 'Returns?' }));

    assert.deepEqual(body.sources, [
      { title: 'Returns policy', url: 'https://example.com/help/returns' },
    ]);
  });

  it('does not leak the grounded flag, which is an operational signal', async () => {
    // Logged for whoever watches how often answers rest on retrieved content. A browser
    // has no use for it, and publishing it invites a client to branch on it.
    const serialized = JSON.stringify(await readJson(await postChat(server, { message: 'Hi.' })));

    assert.ok(!serialized.includes('grounded'));
  });

  it('never reports token usage to the caller', async () => {
    const serialized = JSON.stringify(await readJson(await postChat(server, { message: 'Hi.' })));

    assert.ok(!serialized.includes('usage'));
    assert.ok(!serialized.includes('Tokens'));
  });

  it('forwards the request id, so gateway logs correlate with access logs', async () => {
    await postChat(server, { message: 'Correlate me.' });

    const last = assistant.requests.at(-1);
    assert.equal(typeof last?.metadata?.requestId, 'string');
  });

  it('passes a supplied conversation id through to the domain', async () => {
    await postChat(server, { conversationId: 'c_existing-1', message: 'And abroad?' });

    assert.equal(assistant.requests.at(-1)?.conversationId, 'c_existing-1');
  });

  it('leaves conversation id generation to the domain when none is supplied', async () => {
    await postChat(server, { message: 'Hello.' });

    assert.equal(assistant.requests.at(-1)?.conversationId, undefined);
  });

  describe('validation', () => {
    /**
     * @param {unknown} body
     * @returns {Promise<any>}
     */
    async function rejectedBody(body) {
      const response = await postChat(server, body);
      const parsed = await readJson(response);

      assert.equal(response.status, 400);
      assert.equal(parsed.error.code, 'VALIDATION_FAILED');

      return parsed;
    }

    it('rejects a missing message', async () => {
      await rejectedBody({});
    });

    it('rejects a whitespace-only message', async () => {
      await rejectedBody({ message: '   ' });
    });

    it('rejects a message beyond the profile ceiling', async () => {
      await rejectedBody({ message: 'x'.repeat(2001) });
    });

    it('rejects a conversation id that is not an opaque token', async () => {
      await rejectedBody({ conversationId: '../../etc/passwd', message: 'Hi.' });
    });

    it('rejects an unknown field rather than ignoring it', async () => {
      await rejectedBody({ message: 'Hi.', temperature: 2 });
    });

    it('reports which field failed without echoing what was sent', async () => {
      const body = await rejectedBody({ message: '' });
      const paths = body.error.details.issues.map(
        (/** @type {{ path: string }} */ issue) => issue.path,
      );

      assert.deepEqual(paths, ['message']);
    });

    it('does not reach the domain on an invalid request', async () => {
      const before = assistant.requests.length;

      await postChat(server, { message: '' });

      assert.equal(assistant.requests.length, before);
    });
  });

  describe('failure', () => {
    it('masks a gateway failure as a 502 and keeps the detail in the logs', async () => {
      // Asserted against NODE_ENV=production, because that is where the guarantee has
      // to hold: outside production the envelope also carries a stack, and a stack
      // contains the internal message by definition.
      const built = buildChatApp(
        {
          error: new UpstreamError('LLM gateway returned 401 for model some-model', {
            details: { upstreamStatus: 401, remediation: 'check LLM_API_KEY' },
          }),
        },
        { NODE_ENV: 'production' },
      );
      const failing = await startTestServer(built.app);

      try {
        const response = await postChat(failing, { message: 'Hello.' });
        const body = await readJson(response);
        const serialized = JSON.stringify(body);

        assert.equal(response.status, 502);
        assert.equal(body.error.code, 'UPSTREAM_FAILURE');
        assert.match(body.error.message, /An unexpected error occurred/);
        assert.equal(body.error.details, undefined);
        assert.equal(body.error.stack, undefined);

        for (const leak of ['401', 'some-model', 'LLM_API_KEY', 'gateway']) {
          assert.ok(!serialized.includes(leak), `error envelope leaked ${leak}`);
        }
      } finally {
        await failing.close();
      }
    });

    it('passes a caller error through as a 400', async () => {
      const built = buildChatApp({
        error: new ValidationError('At least one message is required'),
      });
      const failing = await startTestServer(built.app);

      try {
        assert.equal((await postChat(failing, { message: 'Hello.' })).status, 400);
      } finally {
        await failing.close();
      }
    });
  });

  it('rejects a GET on the chat endpoint', async () => {
    assert.equal((await server.request('/v1/chat')).status, 404);
  });
});
