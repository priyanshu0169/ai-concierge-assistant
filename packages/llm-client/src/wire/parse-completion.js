import { UpstreamError } from '@shopsage/platform';
import { asObject } from './as-object.js';
import { toFinishReason } from './finish-reason.js';
import { parseToolCalls } from './parse-tool-calls.js';
import { parseUsage } from './parse-usage.js';

/**
 * Normalize a non-streamed chat-completions response body.
 *
 * Only the first choice is read. `n > 1` is never requested, and quietly
 * discarding extra choices is better than exposing an array that would push a
 * provider concept into every caller's type.
 *
 * @param {unknown} raw Parsed JSON response body.
 * @returns {import('../types.js').LlmCompletion}
 * @throws {UpstreamError} If the response carries no usable choice.
 */
export function parseCompletion(raw) {
  const body = asObject(raw);
  const choices = Array.isArray(body.choices) ? body.choices : [];

  if (choices.length === 0) {
    // Not retryable: a gateway that answers 200 with no choices is usually
    // reporting an error in a non-standard envelope, and it will do so again on
    // every attempt while billing for each one.
    throw new UpstreamError('LLM gateway returned no choices', { retryable: false });
  }

  const choice = asObject(choices[0]);
  const message = asObject(choice.message);

  return {
    // Null content is normal on a tool-only turn.
    content: typeof message.content === 'string' ? message.content : '',
    toolCalls: parseToolCalls(message.tool_calls),
    finishReason: toFinishReason(choice.finish_reason),
    usage: parseUsage(body.usage),
  };
}
