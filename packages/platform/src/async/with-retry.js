import { AppError } from '../errors/app-error.js';

const DEFAULT_MAX_ATTEMPTS = 3;
const DEFAULT_BASE_DELAY_MS = 250;
const DEFAULT_MAX_DELAY_MS = 8000;

/**
 * @typedef {object} RetryNotice
 * @property {number} attempt The attempt that just failed, 1-based.
 * @property {number} delayMs How long we will wait before the next attempt.
 * @property {unknown} error Why the attempt failed.
 */

/**
 * @typedef {object} WithRetryOptions
 * @property {number} [maxAttempts] Total attempts including the first. Default 3.
 * @property {number} [baseDelayMs] Backoff base. Default 250ms.
 * @property {number} [maxDelayMs] Backoff ceiling. Default 8000ms.
 * @property {(error: unknown) => boolean} [isRetryable] Default: an `AppError` marked retryable.
 * @property {(notice: RetryNotice) => void} [onRetry] Observation hook. Must not throw.
 * @property {AbortSignal} [signal] Abandons remaining attempts once aborted.
 * @property {(ms: number) => Promise<void>} [sleep] Injection seam for tests.
 * @property {() => number} [random] Injection seam for deterministic jitter.
 */

/**
 * @typedef {object} RetrySettings
 * @property {number} maxAttempts
 * @property {number} baseDelayMs
 * @property {number} maxDelayMs
 * @property {(error: unknown) => boolean} isRetryable
 * @property {(notice: RetryNotice) => void} onRetry
 * @property {AbortSignal | undefined} signal
 * @property {(ms: number) => Promise<void>} sleep
 * @property {() => number} random
 */

/**
 * Retry an operation with exponential backoff and jitter.
 *
 * Two decisions are worth knowing about before using this:
 *
 * - **The caller decides what is retryable, not this function.** The default
 *   (`AppError.retryable`) is a sensible floor, but retry-worthiness is a
 *   policy that belongs to the caller: a 60-second LLM timeout and a refused
 *   TCP connection are both "retryable" in the abstract and only one of them is
 *   worth repeating in a customer-facing request path.
 * - **There is no overall budget here.** Wrap each attempt in `withTimeout` and
 *   the worst case is `maxAttempts * timeoutMs` plus backoff. That is explicit
 *   by design: a hidden global deadline that cancels an attempt mid-flight
 *   produces failures nobody can attribute.
 *
 * The operation receives the attempt number so it can be logged or varied.
 *
 * @template T
 * @param {(attempt: number) => Promise<T>} operation
 * @param {WithRetryOptions} [options]
 * @returns {Promise<T>} The first successful result.
 * @throws The last error, once attempts are exhausted or the error is not retryable.
 */
export async function withRetry(operation, options = {}) {
  const settings = resolveSettings(options);

  for (let attempt = 1; ; attempt += 1) {
    try {
      return await operation(attempt);
    } catch (error) {
      if (!shouldRetry({ attempt, error, settings })) throw error;

      const delayMs = nextDelayMs({ attempt, error, settings });
      settings.onRetry({ attempt, delayMs, error });
      await settings.sleep(delayMs);

      // Cancellation during the backoff window must not spend another attempt.
      if (settings.signal?.aborted === true) throw error;
    }
  }
}

/**
 * @param {WithRetryOptions} options
 * @returns {RetrySettings}
 */
function resolveSettings(options) {
  return {
    maxAttempts: options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS,
    baseDelayMs: options.baseDelayMs ?? DEFAULT_BASE_DELAY_MS,
    maxDelayMs: options.maxDelayMs ?? DEFAULT_MAX_DELAY_MS,
    isRetryable: options.isRetryable ?? isRetryableError,
    onRetry: options.onRetry ?? (() => {}),
    signal: options.signal,
    sleep: options.sleep ?? sleepFor,
    random: options.random ?? Math.random,
  };
}

/**
 * @param {{ attempt: number, error: unknown, settings: RetrySettings }} input
 * @returns {boolean}
 */
function shouldRetry(input) {
  const { attempt, error, settings } = input;

  if (attempt >= settings.maxAttempts) return false;
  if (settings.signal?.aborted === true) return false;

  return settings.isRetryable(error);
}

/**
 * Default retry predicate: the error taxonomy already carries the answer.
 *
 * @param {unknown} error
 * @returns {boolean}
 */
function isRetryableError(error) {
  return AppError.is(error) && error.retryable;
}

/**
 * @param {{ attempt: number, error: unknown, settings: RetrySettings }} input
 * @returns {number}
 */
function nextDelayMs(input) {
  const { attempt, error, settings } = input;
  const { baseDelayMs, maxDelayMs, random } = settings;

  // An upstream that told us when to come back knows better than our guess.
  const requested = requestedDelayMs(error);
  if (requested !== undefined) return Math.min(requested, maxDelayMs);

  const window = Math.min(baseDelayMs * 2 ** (attempt - 1), maxDelayMs);

  // Equal jitter: half the window fixed, half random. Full jitter can produce
  // near-zero delays, which hammers a struggling dependency immediately; no
  // jitter at all synchronises every instance into the same retry wave.
  return Math.round(window / 2 + random() * (window / 2));
}

/**
 * @param {unknown} error
 * @returns {number | undefined} Milliseconds, if the error carried a hint.
 */
function requestedDelayMs(error) {
  if (!AppError.is(error)) return undefined;

  const seconds = error.retryAfterSeconds;

  return typeof seconds === 'number' && Number.isFinite(seconds) && seconds >= 0
    ? seconds * 1000
    : undefined;
}

/**
 * Deliberately not `unref`ed: an in-flight backoff is work still owed to a
 * caller, and letting the event loop drain through it would strand the promise.
 *
 * @param {number} ms
 * @returns {Promise<void>}
 */
function sleepFor(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
