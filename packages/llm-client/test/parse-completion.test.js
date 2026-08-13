import assert from 'node:assert/strict';
import { UpstreamError } from '@shopsage/platform';
import { describe, it } from 'node:test';
import { parseCompletion } from '../src/wire/parse-completion.js';

/**
 * @param {Record<string, unknown>} message
 * @param {Record<string, unknown>} [extra]
 * @returns {Record<string, unknown>}
 */
function responseWith(message, extra = {}) {
  return { choices: [{ index: 0, message, finish_reason: 'stop' }], ...extra };
}

describe('parseCompletion', () => {
  it('normalizes an ordinary answer', () => {
    const completion = parseCompletion(
      responseWith(
        { role: 'assistant', content: 'We ship worldwide.' },
        { usage: { prompt_tokens: 30, completion_tokens: 8, total_tokens: 38 } },
      ),
    );

    assert.deepEqual(completion, {
      content: 'We ship worldwide.',
      toolCalls: [],
      finishReason: 'stop',
      usage: { promptTokens: 30, completionTokens: 8, totalTokens: 38 },
    });
  });

  it('turns null content into an empty string', () => {
    // Normal on a tool-only turn. Callers should never have to null-check text.
    const completion = parseCompletion(responseWith({ role: 'assistant', content: null }));

    assert.equal(completion.content, '');
  });

  it('reads only the first choice', () => {
    const completion = parseCompletion({
      choices: [
        { message: { content: 'first' }, finish_reason: 'stop' },
        { message: { content: 'second' }, finish_reason: 'stop' },
      ],
    });

    assert.equal(completion.content, 'first');
  });

  describe('finish reason', () => {
    /**
     * @param {unknown} raw
     * @returns {string}
     */
    const reasonFor = (raw) =>
      parseCompletion({ choices: [{ message: { content: 'x' }, finish_reason: raw }] })
        .finishReason;

    it('passes the known reasons through', () => {
      assert.equal(reasonFor('stop'), 'stop');
      assert.equal(reasonFor('length'), 'length');
      assert.equal(reasonFor('content_filter'), 'content_filter');
      assert.equal(reasonFor('tool_calls'), 'tool_calls');
    });

    it('collapses the deprecated function_call reason', () => {
      assert.equal(reasonFor('function_call'), 'tool_calls');
    });

    it('degrades an invented reason to unknown instead of failing', () => {
      // Gateways emit "eos", "end_turn", "max_tokens". The text is still usable,
      // so a label we do not recognise must not become an outage.
      assert.equal(reasonFor('end_turn'), 'unknown');
      assert.equal(reasonFor(null), 'unknown');
      assert.equal(reasonFor(undefined), 'unknown');
    });
  });

  describe('usage', () => {
    it('defaults to zeroes when the gateway reports nothing', () => {
      const completion = parseCompletion(responseWith({ content: 'x' }));

      assert.deepEqual(completion.usage, {
        promptTokens: 0,
        completionTokens: 0,
        totalTokens: 0,
      });
    });

    it('derives a missing total rather than reporting zero spend', () => {
      const completion = parseCompletion(
        responseWith({ content: 'x' }, { usage: { prompt_tokens: 12, completion_tokens: 5 } }),
      );

      assert.equal(completion.usage.totalTokens, 17);
    });

    it('ignores nonsense counts', () => {
      const completion = parseCompletion(
        responseWith({ content: 'x' }, { usage: { prompt_tokens: -4, completion_tokens: 'many' } }),
      );

      assert.deepEqual(completion.usage, {
        promptTokens: 0,
        completionTokens: 0,
        totalTokens: 0,
      });
    });
  });

  describe('tool calls', () => {
    /**
     * @param {unknown} toolCalls
     * @returns {import('../src/types.js').LlmCompletion}
     */
    const parseWithToolCalls = (toolCalls) =>
      parseCompletion({
        choices: [
          { message: { content: null, tool_calls: toolCalls }, finish_reason: 'tool_calls' },
        ],
      });

    it('parses the arguments into an object', () => {
      const completion = parseWithToolCalls([
        {
          id: 'call_abc',
          type: 'function',
          function: { name: 'searchKnowledge', arguments: '{"query":"return policy"}' },
        },
      ]);

      assert.deepEqual(completion.toolCalls, [
        { id: 'call_abc', name: 'searchKnowledge', arguments: { query: 'return policy' } },
      ]);
    });

    it('treats an empty argument string as no arguments', () => {
      const completion = parseWithToolCalls([
        { id: 'c1', function: { name: 'ping', arguments: '' } },
      ]);

      assert.deepEqual(completion.toolCalls[0].arguments, {});
    });

    it('accepts arguments a non-conforming gateway already parsed', () => {
      const completion = parseWithToolCalls([
        { id: 'c1', function: { name: 'ping', arguments: { deep: true } } },
      ]);

      assert.deepEqual(completion.toolCalls[0].arguments, { deep: true });
    });

    it('synthesizes an id when the gateway omits one', () => {
      // Without an id the tool result cannot be correlated and the next request
      // is rejected, stranding the tool loop.
      const completion = parseWithToolCalls([{ function: { name: 'ping', arguments: '{}' } }]);

      assert.equal(completion.toolCalls[0].id, 'call_0');
    });

    it('rejects truncated argument JSON without retrying it', () => {
      // The usual cause is max_tokens cutting the JSON in half, which repeats
      // identically on a retry while charging again.
      assert.throws(
        () => parseWithToolCalls([{ id: 'c1', function: { name: 'ping', arguments: '{"q":' } }]),
        (error) => {
          assert.ok(error instanceof UpstreamError);
          assert.equal(error.retryable, false);
          assert.deepEqual(error.details, { toolName: 'ping' });
          return true;
        },
      );
    });

    it('never puts the malformed arguments in the error, because they carry customer text', () => {
      try {
        parseWithToolCalls([
          { id: 'c1', function: { name: 'ping', arguments: '{"email":"a@b.com' } },
        ]);
        assert.fail('expected an UpstreamError');
      } catch (error) {
        assert.ok(
          !JSON.stringify(/** @type {UpstreamError} */ (error).details).includes('a@b.com'),
        );
      }
    });

    it('rejects a tool call with no name', () => {
      assert.throws(() => parseWithToolCalls([{ id: 'c1', function: {} }]), UpstreamError);
    });

    it('rejects arguments that decode to something other than an object', () => {
      assert.throws(
        () => parseWithToolCalls([{ id: 'c1', function: { name: 'ping', arguments: '[1,2]' } }]),
        UpstreamError,
      );
    });
  });

  describe('unusable responses', () => {
    it('rejects a response with no choices, and does not retry it', () => {
      // A 200 with no choices is usually an error in a non-standard envelope: it
      // will repeat on every attempt, and each one is billable.
      for (const body of [{}, { choices: [] }, null, 'not json at all']) {
        assert.throws(
          () => parseCompletion(body),
          (error) => {
            assert.ok(error instanceof UpstreamError);
            assert.equal(error.retryable, false);
            assert.equal(error.expose, false);
            return true;
          },
        );
      }
    });

    it('survives a choice with no message', () => {
      const completion = parseCompletion({ choices: [{ finish_reason: 'stop' }] });

      assert.equal(completion.content, '');
      assert.deepEqual(completion.toolCalls, []);
    });
  });
});
