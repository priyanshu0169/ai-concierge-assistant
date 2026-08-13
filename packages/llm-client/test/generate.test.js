import assert from 'node:assert/strict';
import { TimeoutError, UpstreamError, ValidationError } from '@shopsage/platform';
import { describe, it } from 'node:test';
import { createLlmClient } from '../src/create-llm-client.js';
import {
  TEST_API_KEY,
  createFetchStub,
  createRecordingLogger,
  jsonResponse,
  testClientOptions,
} from './helpers/fake-gateway.js';

/** @type {import('../src/types.js').LlmMessage[]} */
const QUESTION = [{ role: 'user', content: 'What is your return policy?' }];

/**
 * @param {string} [content]
 * @returns {() => Response}
 */
function answer(content = 'Thirty days, unopened.') {
  return jsonResponse({
    choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 42, completion_tokens: 9, total_tokens: 51 },
  });
}

describe('generate', () => {
  it('returns a normalized completion', async () => {
    const gateway = createFetchStub(answer());
    const llm = createLlmClient(testClientOptions({ fetchImpl: gateway.fetchImpl }));

    const completion = await llm.generate(QUESTION);

    assert.deepEqual(completion, {
      content: 'Thirty days, unopened.',
      toolCalls: [],
      finishReason: 'stop',
      usage: { promptTokens: 42, completionTokens: 9, totalTokens: 51 },
    });
  });

  it('reveals nothing about the provider in what it returns', async () => {
    // The whole point of the boundary: a caller must not be able to learn which
    // model or gateway answered, or it will eventually branch on it.
    const gateway = createFetchStub(answer());
    const llm = createLlmClient(testClientOptions({ fetchImpl: gateway.fetchImpl }));

    const completion = await llm.generate(QUESTION);

    assert.deepEqual(Object.keys(completion).sort(), [
      'content',
      'finishReason',
      'toolCalls',
      'usage',
    ]);
  });

  describe('the request it sends', () => {
    it('posts to the resolved completions endpoint with a bearer credential', async () => {
      const gateway = createFetchStub(answer());
      const llm = createLlmClient(testClientOptions({ fetchImpl: gateway.fetchImpl }));

      await llm.generate(QUESTION);

      const [request] = gateway.requests;
      assert.equal(request.url, 'https://gateway.test/v1/chat/completions');
      assert.equal(request.headers.authorization, `Bearer ${TEST_API_KEY}`);
      assert.equal(request.headers['content-type'], 'application/json');
      assert.equal(request.headers.accept, 'application/json');
    });

    it('uses the api-key header when configured for Azure OpenAI', async () => {
      const gateway = createFetchStub(answer());
      const llm = createLlmClient(
        testClientOptions({ fetchImpl: gateway.fetchImpl, authStyle: 'api-key' }),
      );

      await llm.generate(QUESTION);

      assert.equal(gateway.requests[0].headers['api-key'], TEST_API_KEY);
      assert.equal(gateway.requests[0].headers.authorization, undefined);
    });

    it('does not ask for a stream', async () => {
      const gateway = createFetchStub(answer());
      const llm = createLlmClient(testClientOptions({ fetchImpl: gateway.fetchImpl }));

      await llm.generate(QUESTION);

      assert.equal(gateway.requests[0].body.stream, undefined);
    });
  });

  describe('retrying', () => {
    it('retries a 500 and succeeds', async () => {
      const gateway = createFetchStub([
        jsonResponse({ error: 'overloaded' }, { status: 500 }),
        answer(),
      ]);
      const llm = createLlmClient(testClientOptions({ fetchImpl: gateway.fetchImpl }));

      const completion = await llm.generate(QUESTION);

      assert.equal(completion.content, 'Thirty days, unopened.');
      assert.equal(gateway.requests.length, 2);
    });

    it('retries a refused connection', async () => {
      // DNS failure, refused connection, TLS failure, socket reset: `fetch`
      // rejects rather than answering, and all of them are worth one more try.
      const gateway = createFetchStub([new TypeError('fetch failed'), answer()]);
      const llm = createLlmClient(testClientOptions({ fetchImpl: gateway.fetchImpl }));

      const completion = await llm.generate(QUESTION);

      assert.equal(completion.content, 'Thirty days, unopened.');
      assert.equal(gateway.requests.length, 2);
    });

    it('retries a rate limit and honours Retry-After', async () => {
      /** @type {number[]} */
      const delays = [];
      const gateway = createFetchStub([
        jsonResponse({ error: 'slow down' }, { status: 429, headers: { 'retry-after': '2' } }),
        answer(),
      ]);

      const llm = createLlmClient(
        testClientOptions({
          fetchImpl: gateway.fetchImpl,
          sleep: (ms) => {
            delays.push(ms);
            return Promise.resolve();
          },
        }),
      );

      await llm.generate(QUESTION);

      assert.deepEqual(delays, [2000]);
    });

    it('stops after maxAttempts', async () => {
      const gateway = createFetchStub(jsonResponse({ error: 'down' }, { status: 502 }));
      const llm = createLlmClient(
        testClientOptions({ fetchImpl: gateway.fetchImpl, maxAttempts: 2 }),
      );

      await assert.rejects(() => llm.generate(QUESTION), UpstreamError);

      assert.equal(gateway.requests.length, 2);
    });

    it('does not retry a 400, because the same request will fail again', async () => {
      const gateway = createFetchStub(jsonResponse({ error: 'bad model' }, { status: 400 }));
      const llm = createLlmClient(testClientOptions({ fetchImpl: gateway.fetchImpl }));

      await assert.rejects(() => llm.generate(QUESTION), UpstreamError);

      assert.equal(gateway.requests.length, 1);
    });

    it('does not retry a 401', async () => {
      const gateway = createFetchStub(jsonResponse({ error: 'unauthorized' }, { status: 401 }));
      const llm = createLlmClient(testClientOptions({ fetchImpl: gateway.fetchImpl }));

      await assert.rejects(() => llm.generate(QUESTION), UpstreamError);

      assert.equal(gateway.requests.length, 1);
    });

    it('does not retry a timeout', async () => {
      // A timeout means the gateway was still generating when the budget ran
      // out. Retrying charges twice and multiplies the customer's wait by three.
      const gateway = createFetchStub(
        /** @type {any} */ (
          () => {
            throw new Error('unreachable');
          }
        ),
      );

      const llm = createLlmClient(
        testClientOptions({
          fetchImpl: /** @type {typeof fetch} */ (
            /** @type {unknown} */ (
              (/** @type {string} */ _url, /** @type {RequestInit} */ init) =>
                new Promise((_resolve, reject) => {
                  init.signal?.addEventListener('abort', () => reject(new Error('aborted')));
                })
            )
          ),
          timeoutMs: 20,
        }),
      );

      await assert.rejects(() => llm.generate(QUESTION), TimeoutError);
      assert.equal(gateway.requests.length, 0);
    });

    it('retries a truncated response body', async () => {
      const gateway = createFetchStub([
        () => new Response('{"choices":[', { status: 200 }),
        answer(),
      ]);
      const llm = createLlmClient(testClientOptions({ fetchImpl: gateway.fetchImpl }));

      const completion = await llm.generate(QUESTION);

      assert.equal(completion.finishReason, 'stop');
      assert.equal(gateway.requests.length, 2);
    });

    it('does not retry a 200 that carries no choices', async () => {
      const gateway = createFetchStub(jsonResponse({ error: { message: 'quota exceeded' } }));
      const llm = createLlmClient(testClientOptions({ fetchImpl: gateway.fetchImpl }));

      await assert.rejects(() => llm.generate(QUESTION), /no choices/);

      assert.equal(gateway.requests.length, 1);
    });
  });

  describe('cancellation', () => {
    it('propagates the caller signal and does not retry after an abort', async () => {
      const controller = new AbortController();

      const llm = createLlmClient(
        testClientOptions({
          fetchImpl: /** @type {typeof fetch} */ (
            /** @type {unknown} */ (
              (/** @type {string} */ _url, /** @type {RequestInit} */ init) =>
                new Promise((_resolve, reject) => {
                  init.signal?.addEventListener('abort', () =>
                    reject(new DOMException('Aborted', 'AbortError')),
                  );
                })
            )
          ),
        }),
      );

      const pending = llm.generate(QUESTION, { signal: controller.signal });
      controller.abort();

      await assert.rejects(pending, (error) => {
        // Cancellation must not be reported as a dependency outage.
        assert.ok(!(error instanceof UpstreamError));
        return true;
      });
    });
  });

  describe('validation', () => {
    it('refuses to call the gateway with no messages', async () => {
      const gateway = createFetchStub(answer());
      const llm = createLlmClient(testClientOptions({ fetchImpl: gateway.fetchImpl }));

      await assert.rejects(() => llm.generate([]), ValidationError);

      assert.equal(gateway.requests.length, 0);
    });
  });

  describe('token accounting', () => {
    it('logs the model, the token counts and the duration', async () => {
      // Cost visibility lives here so no caller needs to know the model - which
      // is the one legitimate reason anyone would ask for it.
      const { logger, records } = createRecordingLogger();
      const gateway = createFetchStub(answer());
      const llm = createLlmClient(testClientOptions({ fetchImpl: gateway.fetchImpl, logger }));

      await llm.generate(QUESTION, { metadata: { requestId: 'req-1' } });

      const record = records.find((entry) => entry.msg === 'llm completion');
      assert.ok(record, 'expected a completion record');
      assert.equal(record.model, 'test-model');
      assert.equal(record.promptTokens, 42);
      assert.equal(record.completionTokens, 9);
      assert.equal(record.totalTokens, 51);
      assert.equal(record.finishReason, 'stop');
      assert.equal(record.mode, 'generate');
      assert.equal(record.requestId, 'req-1');
      assert.equal(typeof record.durationMs, 'number');
    });

    it('warns on each retry, because a routinely retrying gateway is a problem', async () => {
      const { logger, records } = createRecordingLogger();
      const gateway = createFetchStub([
        jsonResponse({ error: 'overloaded' }, { status: 500 }),
        answer(),
      ]);
      const llm = createLlmClient(testClientOptions({ fetchImpl: gateway.fetchImpl, logger }));

      await llm.generate(QUESTION);

      const retry = records.find((entry) => entry.msg === 'llm request failed, retrying');
      assert.ok(retry, 'expected a retry record');
      assert.equal(retry.level, 'warn');
      assert.equal(retry.attempt, 1);
      assert.equal(retry.err.code, 'UPSTREAM_FAILURE');
    });

    it('never writes the credential to the log, even when the gateway echoes it', async () => {
      // The highest-value assertion in this file: a leak here is silent and
      // lands in the most widely-read storage in the system.
      const { logger, records } = createRecordingLogger();
      const gateway = createFetchStub([
        () => new Response(`Incorrect API key provided: ${TEST_API_KEY}`, { status: 500 }),
        answer(),
      ]);
      const llm = createLlmClient(testClientOptions({ fetchImpl: gateway.fetchImpl, logger }));

      await llm.generate(QUESTION);

      assert.ok(!JSON.stringify(records).includes(TEST_API_KEY));
    });
  });
});
