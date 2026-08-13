import assert from 'node:assert/strict';
import { UpstreamError } from '@shopsage/platform';
import { describe, it } from 'node:test';
import { createLlmClient } from '../src/create-llm-client.js';
import {
  createFetchStub,
  createRecordingLogger,
  jsonResponse,
  sseResponse,
  testClientOptions,
} from './helpers/fake-gateway.js';

/** @type {import('../src/types.js').LlmMessage[]} */
const QUESTION = [{ role: 'user', content: 'Do you ship to Ireland?' }];

/**
 * @param {Record<string, unknown>} chunk
 * @returns {string}
 */
function event(chunk) {
  return `data: ${JSON.stringify(chunk)}\n\n`;
}

/**
 * @param {string} text
 * @returns {string}
 */
function textDelta(text) {
  return event({ choices: [{ index: 0, delta: { content: text } }] });
}

/**
 * @param {import('../src/types.js').LlmClient} llm
 * @param {import('../src/types.js').LlmCallOptions} [options]
 * @returns {Promise<import('../src/types.js').LlmStreamEvent[]>}
 */
async function collect(llm, options) {
  /** @type {import('../src/types.js').LlmStreamEvent[]} */
  const events = [];

  for await (const streamEvent of llm.stream(QUESTION, options)) events.push(streamEvent);

  return events;
}

describe('stream', () => {
  it('emits text deltas followed by exactly one end event', async () => {
    const gateway = createFetchStub(
      sseResponse([
        event({ choices: [{ index: 0, delta: { role: 'assistant' } }] }),
        textDelta('Yes, '),
        textDelta('we do.'),
        event({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }),
        event({
          choices: [],
          usage: { prompt_tokens: 20, completion_tokens: 4, total_tokens: 24 },
        }),
        'data: [DONE]\n\n',
      ]),
    );
    const llm = createLlmClient(testClientOptions({ fetchImpl: gateway.fetchImpl }));

    const events = await collect(llm);

    assert.deepEqual(events, [
      { type: 'delta', text: 'Yes, ' },
      { type: 'delta', text: 'we do.' },
      {
        type: 'end',
        completion: {
          content: 'Yes, we do.',
          toolCalls: [],
          finishReason: 'stop',
          usage: { promptTokens: 20, completionTokens: 4, totalTokens: 24 },
        },
      },
    ]);
  });

  it('drops the empty deltas gateways use as openers and keep-alives', async () => {
    const gateway = createFetchStub(
      sseResponse([
        event({ choices: [{ index: 0, delta: { role: 'assistant', content: '' } }] }),
        textDelta('Hello.'),
        'data: [DONE]\n\n',
      ]),
    );
    const llm = createLlmClient(testClientOptions({ fetchImpl: gateway.fetchImpl }));

    const events = await collect(llm);

    assert.equal(events.filter((entry) => entry.type === 'delta').length, 1);
  });

  it('asks for a stream and the event-stream content type', async () => {
    const gateway = createFetchStub(sseResponse(['data: [DONE]\n\n']));
    const llm = createLlmClient(testClientOptions({ fetchImpl: gateway.fetchImpl }));

    await collect(llm);

    assert.equal(gateway.requests[0].body.stream, true);
    assert.deepEqual(gateway.requests[0].body.stream_options, { include_usage: true });
    assert.equal(gateway.requests[0].headers.accept, 'text/event-stream');
  });

  it('starts nothing until the caller iterates', async () => {
    // Lazy by construction: the request belongs to the consumption, not to
    // building the iterator.
    const gateway = createFetchStub(sseResponse(['data: [DONE]\n\n']));
    const llm = createLlmClient(testClientOptions({ fetchImpl: gateway.fetchImpl }));

    const iterable = llm.stream(QUESTION);

    assert.equal(gateway.requests.length, 0);

    await collect(llm);
    assert.equal(gateway.requests.length, 1);
    assert.ok(iterable);
  });

  describe('tool calls', () => {
    it('reassembles arguments fragmented across events', async () => {
      // The messiest part of the wire format. Callers receive a finished tool
      // call and never see the fragments.
      const gateway = createFetchStub(
        sseResponse([
          event({
            choices: [
              {
                index: 0,
                delta: {
                  tool_calls: [
                    {
                      index: 0,
                      id: 'call_1',
                      function: { name: 'searchKnowledge', arguments: '' },
                    },
                  ],
                },
              },
            ],
          }),
          event({
            choices: [
              { index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: '{"que' } }] } },
            ],
          }),
          event({
            choices: [
              {
                index: 0,
                delta: { tool_calls: [{ index: 0, function: { arguments: 'ry":"returns"}' } }] },
              },
            ],
          }),
          event({ choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] }),
          'data: [DONE]\n\n',
        ]),
      );
      const llm = createLlmClient(testClientOptions({ fetchImpl: gateway.fetchImpl }));

      const events = await collect(llm);
      const last = events.at(-1);

      assert.equal(last?.type, 'end');
      assert.equal(last?.type === 'end' && last.completion.finishReason, 'tool_calls');
      assert.deepEqual(last?.type === 'end' ? last.completion.toolCalls : [], [
        { id: 'call_1', name: 'searchKnowledge', arguments: { query: 'returns' } },
      ]);
    });

    it('keeps parallel tool calls apart by index', async () => {
      const gateway = createFetchStub(
        sseResponse([
          event({
            choices: [
              {
                index: 0,
                delta: {
                  tool_calls: [
                    { index: 0, id: 'a', function: { name: 'first', arguments: '{"x":1}' } },
                    { index: 1, id: 'b', function: { name: 'second', arguments: '{"y":2}' } },
                  ],
                },
              },
            ],
          }),
          'data: [DONE]\n\n',
        ]),
      );
      const llm = createLlmClient(testClientOptions({ fetchImpl: gateway.fetchImpl }));

      const events = await collect(llm);
      const last = events.at(-1);
      const toolCalls = last?.type === 'end' ? last.completion.toolCalls : [];

      assert.deepEqual(
        toolCalls.map((call) => call.name),
        ['first', 'second'],
      );
      assert.deepEqual(toolCalls[1].arguments, { y: 2 });
    });
  });

  describe('failure', () => {
    it('retries while opening the connection', async () => {
      const gateway = createFetchStub([
        jsonResponse({ error: 'overloaded' }, { status: 503 }),
        sseResponse([textDelta('Recovered.'), 'data: [DONE]\n\n']),
      ]);
      const llm = createLlmClient(testClientOptions({ fetchImpl: gateway.fetchImpl }));

      const events = await collect(llm);

      assert.equal(gateway.requests.length, 2);
      assert.deepEqual(events[0], { type: 'delta', text: 'Recovered.' });
    });

    it('does not retry once bytes have reached the caller', async () => {
      // Replaying a partially consumed stream would duplicate text on screen
      // rather than repair anything.
      const gateway = createFetchStub([
        sseResponse([textDelta('Half an ans'), 'data: {oops\n\n']),
        sseResponse([textDelta('never used'), 'data: [DONE]\n\n']),
      ]);
      const llm = createLlmClient(testClientOptions({ fetchImpl: gateway.fetchImpl }));

      await assert.rejects(() => collect(llm), UpstreamError);

      assert.equal(gateway.requests.length, 1);
    });

    it('rejects a response with no body at all', async () => {
      const gateway = createFetchStub(() => new Response(null, { status: 200 }));
      const llm = createLlmClient(testClientOptions({ fetchImpl: gateway.fetchImpl }));

      await assert.rejects(() => collect(llm), /empty stream/);
    });
  });

  it('accounts for tokens once the stream ends', async () => {
    const { logger, records } = createRecordingLogger();
    const gateway = createFetchStub(
      sseResponse([
        textDelta('Yes.'),
        event({
          choices: [],
          usage: { prompt_tokens: 15, completion_tokens: 2, total_tokens: 17 },
        }),
        'data: [DONE]\n\n',
      ]),
    );
    const llm = createLlmClient(testClientOptions({ fetchImpl: gateway.fetchImpl, logger }));

    await collect(llm, { metadata: { requestId: 'req-9' } });

    const record = records.find((entry) => entry.msg === 'llm completion');
    assert.ok(record);
    assert.equal(record.mode, 'stream');
    assert.equal(record.totalTokens, 17);
    assert.equal(record.requestId, 'req-9');
  });

  it('reports zero usage rather than failing when a gateway omits it', async () => {
    const gateway = createFetchStub(sseResponse([textDelta('Terse.'), 'data: [DONE]\n\n']));
    const llm = createLlmClient(testClientOptions({ fetchImpl: gateway.fetchImpl }));

    const events = await collect(llm);
    const last = events.at(-1);

    assert.equal(last?.type === 'end' && last.completion.usage.totalTokens, 0);
    assert.equal(last?.type === 'end' && last.completion.content, 'Terse.');
  });
});
