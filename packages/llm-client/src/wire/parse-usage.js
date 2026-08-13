/** @type {import('../types.js').LlmUsage} */
export const EMPTY_USAGE = Object.freeze({
  promptTokens: 0,
  completionTokens: 0,
  totalTokens: 0,
});

/**
 * Normalize a wire `usage` object.
 *
 * Absent usage becomes zeroes rather than `undefined`, so cost accounting and
 * context-budget arithmetic never have to branch on presence. The distinction
 * that matters operationally - "the gateway reported nothing" versus "nothing
 * was spent" - is visible anyway: a completion with content and zero tokens is
 * unmistakable in the logs.
 *
 * @param {unknown} raw
 * @returns {import('../types.js').LlmUsage}
 */
export function parseUsage(raw) {
  if (raw === null || typeof raw !== 'object') return EMPTY_USAGE;

  const usage = /** @type {Record<string, unknown>} */ (raw);
  const promptTokens = toCount(usage.prompt_tokens);
  const completionTokens = toCount(usage.completion_tokens);
  const reportedTotal = toCount(usage.total_tokens);

  return {
    promptTokens,
    completionTokens,
    // Some gateways omit the total; deriving it is safer than reporting zero
    // spend on a call that clearly cost something.
    totalTokens: reportedTotal > 0 ? reportedTotal : promptTokens + completionTokens,
  };
}

/**
 * @param {unknown} value
 * @returns {number}
 */
function toCount(value) {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.round(value) : 0;
}
