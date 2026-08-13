import { asObject } from './as-object.js';
import { toFinishReason } from './finish-reason.js';
import { EMPTY_USAGE, parseUsage } from './parse-usage.js';
import { createToolCallAccumulator } from './tool-call-accumulator.js';

/**
 * @typedef {object} CompletionAccumulator
 * @property {(chunk: Record<string, unknown>) => string} accept Returns this chunk's text delta.
 * @property {() => import('../types.js').LlmCompletion} toCompletion
 */

/**
 * Fold streamed chunks into the same `LlmCompletion` that `generate()` returns.
 *
 * State lives in a closure rather than in a passed-around object because the
 * coding standard forbids mutating a parameter's properties - and because a
 * half-assembled completion is not something any other module should be able to
 * reach into.
 *
 * @returns {CompletionAccumulator}
 */
export function createCompletionAccumulator() {
  const toolCalls = createToolCallAccumulator();
  let content = '';
  /** @type {import('../types.js').LlmFinishReason} */
  let finishReason = 'unknown';
  /** @type {import('../types.js').LlmUsage} */
  let usage = EMPTY_USAGE;

  return {
    accept(chunk) {
      // With `stream_options.include_usage` the final chunk carries usage and an
      // empty `choices` array, so usage is read before anything else.
      if (chunk.usage !== undefined && chunk.usage !== null) usage = parseUsage(chunk.usage);

      const choice = asObject(Array.isArray(chunk.choices) ? chunk.choices[0] : undefined);
      if (choice.finish_reason !== undefined && choice.finish_reason !== null) {
        finishReason = toFinishReason(choice.finish_reason);
      }

      const delta = asObject(choice.delta);
      toolCalls.accept(delta.tool_calls);

      const text = typeof delta.content === 'string' ? delta.content : '';
      content += text;

      return text;
    },

    toCompletion() {
      return { content, toolCalls: toolCalls.toToolCalls(), finishReason, usage };
    },
  };
}
