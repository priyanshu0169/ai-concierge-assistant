import { AppError, ERROR_CODES } from '@shopsage/platform';

/**
 * The failures worth repeating: a dependency that failed transiently, a
 * gateway that throttled us, a dependency that is not ready yet.
 */
/** @type {ReadonlySet<import('@shopsage/platform').ErrorCode>} */
const RETRYABLE_CODES = new Set([
  ERROR_CODES.UPSTREAM_FAILURE,
  ERROR_CODES.RATE_LIMITED,
  ERROR_CODES.SERVICE_UNAVAILABLE,
]);

/**
 * Whether a failed LLM call should be attempted again.
 *
 * Stricter than the platform default (`AppError.retryable`) in one specific way:
 * **timeouts are not retried.**
 *
 * A `TimeoutError` here means the gateway was still working when the
 * per-attempt budget ran out - the usual cause is a long generation, not a
 * transient blip. Retrying it charges for the tokens twice and multiplies the
 * customer's wait by the attempt count: at the default 60s budget, three
 * attempts is a three-minute silence in a chat window. Better to fail at 60s
 * with a fallback message. Lowering `LLM_TIMEOUT_MS` is the correct lever if
 * the gateway is genuinely slow to first byte.
 *
 * @param {unknown} error
 * @returns {boolean}
 */
export function isRetryableLlmError(error) {
  return AppError.is(error) && error.retryable && RETRYABLE_CODES.has(error.code);
}
