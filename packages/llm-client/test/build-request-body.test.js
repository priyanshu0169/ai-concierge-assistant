import assert from 'node:assert/strict';
import { ValidationError } from '@shopsage/platform';
import { describe, it } from 'node:test';
import { resolveClientSettings } from '../src/client-options.js';
import { buildRequestBody } from '../src/wire/build-request-body.js';
import { testClientOptions } from './helpers/fake-gateway.js';

const settings = resolveClientSettings(testClientOptions());

/**
 * @param {{
 *   messages?: import('../src/types.js').LlmMessage[],
 *   callOptions?: import('../src/types.js').LlmCallOptions,
 *   stream?: boolean,
 * }} [input]
 * @returns {Record<string, any>}
 */
function build(input = {}) {
  return buildRequestBody({
    messages: input.messages ?? [{ role: 'user', content: 'Do you ship abroad?' }],
    callOptions: input.callOptions ?? {},
    settings,
    stream: input.stream ?? false,
  });
}

describe('buildRequestBody', () => {
  it('sends the configured model and sampling settings', () => {
    const body = build();

    assert.equal(body.model, 'test-model');
    assert.equal(body.temperature, 0.2);
    assert.equal(body.max_tokens, 1024);
    assert.equal(body.stream, undefined);
  });

  it('lets a single call override the sampling settings', () => {
    const body = build({ callOptions: { temperature: 0.9, maxTokens: 64 } });

    assert.equal(body.temperature, 0.9);
    assert.equal(body.max_tokens, 64);
  });

  describe('message translation', () => {
    it('maps system and user turns', () => {
      const body = build({
        messages: [
          { role: 'system', content: 'You are helpful.' },
          { role: 'user', content: 'Hello.' },
        ],
      });

      assert.deepEqual(body.messages, [
        { role: 'system', content: 'You are helpful.' },
        { role: 'user', content: 'Hello.' },
      ]);
    });

    it('re-encodes assistant tool calls as the wire expects', () => {
      // Callers hold parsed arguments; the wire wants a JSON string. Doing that
      // conversion here is the whole reason the boundary exists.
      const body = build({
        messages: [
          {
            role: 'assistant',
            toolCalls: [{ id: 'call_1', name: 'searchKnowledge', arguments: { query: 'returns' } }],
          },
        ],
      });

      assert.deepEqual(body.messages, [
        {
          role: 'assistant',
          content: null,
          tool_calls: [
            {
              id: 'call_1',
              type: 'function',
              function: { name: 'searchKnowledge', arguments: '{"query":"returns"}' },
            },
          ],
        },
      ]);
    });

    it('keeps an assistant turn without tool calls simple', () => {
      const body = build({ messages: [{ role: 'assistant', content: 'Yes, we do.' }] });

      assert.deepEqual(body.messages, [{ role: 'assistant', content: 'Yes, we do.' }]);
    });

    it('maps a tool result onto its call', () => {
      const body = build({
        messages: [{ role: 'tool', toolCallId: 'call_1', content: '{"chunks":[]}' }],
      });

      assert.deepEqual(body.messages, [
        { role: 'tool', tool_call_id: 'call_1', content: '{"chunks":[]}' },
      ]);
    });

    it('rejects a tool result that cannot be correlated', () => {
      // An unmatched tool result makes the gateway reject the whole request;
      // failing here names the actual problem.
      assert.throws(
        () => build({ messages: [{ role: 'tool', content: 'orphan' }] }),
        ValidationError,
      );
    });

    it('rejects an unknown role rather than sending it', () => {
      assert.throws(
        () =>
          build({
            messages: [/** @type {any} */ ({ role: 'function', content: 'legacy' })],
          }),
        /Unsupported message role/,
      );
    });

    it('rejects an empty conversation', () => {
      assert.throws(() => build({ messages: [] }), ValidationError);
    });
  });

  describe('tools', () => {
    const tools = [
      {
        name: 'searchKnowledge',
        description: 'Search the store knowledge base.',
        parameters: { type: 'object', properties: { query: { type: 'string' } } },
      },
    ];

    it('omits tool fields entirely when no tool is offered', () => {
      const body = build();

      assert.ok(!('tools' in body));
      assert.ok(!('tool_choice' in body));
    });

    it('wraps tool definitions and defaults the choice to auto', () => {
      const body = build({ callOptions: { tools } });

      assert.deepEqual(body.tools, [{ type: 'function', function: tools[0] }]);
      assert.equal(body.tool_choice, 'auto');
    });

    it('passes an explicit tool choice through', () => {
      const body = build({ callOptions: { tools, toolChoice: 'required' } });

      assert.equal(body.tool_choice, 'required');
    });
  });

  describe('streaming', () => {
    it('asks for usage on streams, so cost stays visible', () => {
      const body = build({ stream: true });

      assert.equal(body.stream, true);
      assert.deepEqual(body.stream_options, { include_usage: true });
    });

    it('omits stream_options for gateways that reject it', () => {
      const strict = resolveClientSettings(testClientOptions({ includeStreamUsage: false }));

      const body = buildRequestBody({
        messages: [{ role: 'user', content: 'Hi.' }],
        callOptions: {},
        settings: strict,
        stream: true,
      });

      assert.equal(body.stream, true);
      assert.ok(!('stream_options' in body));
    });
  });
});
