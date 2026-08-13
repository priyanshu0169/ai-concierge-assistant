/** @type {Readonly<Record<string, import('../types.js').LlmFinishReason>>} */
const FINISH_REASONS = Object.freeze({
  stop: 'stop',
  length: 'length',
  tool_calls: 'tool_calls',
  // The deprecated function-calling shape, still emitted by older gateways and
  // some proxies. Collapsed here so nothing downstream learns it ever existed.
  function_call: 'tool_calls',
  content_filter: 'content_filter',
});

/**
 * Map a wire finish reason onto the normalized set.
 *
 * An unrecognised value becomes `unknown` rather than an error: gateways invent
 * reasons ("eos", "end_turn", "max_tokens"), and the generated text is normally
 * still perfectly usable. Failing the whole call over a label would be a
 * self-inflicted outage.
 *
 * @param {unknown} value
 * @returns {import('../types.js').LlmFinishReason}
 */
export function toFinishReason(value) {
  return typeof value === 'string' && value in FINISH_REASONS ? FINISH_REASONS[value] : 'unknown';
}
