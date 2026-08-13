import { AppError } from '../errors/app-error.js';
import { UpstreamError } from '../errors/errors.js';
import { withTimeout } from '../async/with-timeout.js';

/**
 * @typedef {object} SendRequestOptions
 * @property {string} url
 * @property {string} [method] Default `GET`.
 * @property {Record<string, string>} [headers]
 * @property {unknown} [body] JSON-encoded unless it is already a string.
 * @property {number} timeoutMs
 * @property {AbortSignal} [signal] Caller cancellation.
 * @property {string} label Names the dependency in timeout and transport errors.
 * @property {typeof fetch} [fetchImpl] Injection seam for tests.
 */

/**
 * Perform one outbound HTTP request under a time budget.
 *
 * The mechanics every outbound adapter needs and none of the semantics any of
 * them differ on. It guarantees exactly two things:
 *
 * - The request is cancelled - not merely abandoned - when the budget elapses.
 * - Every transport failure arrives already classified as an `AppError`, so a
 *   retry predicate can be a pure function of the error.
 *
 * It deliberately does **not** interpret the status code. What a 409 or a 422
 * means is vendor semantics, and that belongs to the adapter that knows the
 * vendor. The response body is left unread for the same reason: some callers
 * need parsed JSON, some need the raw byte stream.
 *
 * @param {SendRequestOptions} options
 * @returns {Promise<Response>} The response, whatever its status, body unread.
 * @throws {import('../errors/errors.js').TimeoutError} If the budget elapses.
 * @throws {UpstreamError} On a transport-level failure.
 */
export async function sendRequest(options) {
  const {
    url,
    method = 'GET',
    headers,
    body,
    timeoutMs,
    signal,
    label,
    fetchImpl = fetch,
  } = options;

  /** @type {RequestInit} */
  const init = {
    method,
    headers,
    ...(body === undefined ? {} : { body: typeof body === 'string' ? body : JSON.stringify(body) }),
  };

  try {
    return await withTimeout(
      (timeoutSignal) => fetchImpl(url, { ...init, signal: timeoutSignal }),
      { timeoutMs, signal, label },
    );
  } catch (error) {
    throw toTransportError(error, { label, signal });
  }
}

/**
 * @param {unknown} error
 * @param {{ label: string, signal?: AbortSignal }} context
 * @returns {unknown}
 */
function toTransportError(error, context) {
  // Already classified: a TimeoutError from withTimeout passes straight through.
  if (AppError.is(error)) return error;

  // Cancellation is not a dependency failure. Reclassifying it would report an
  // outage every time a caller gave up early.
  if (context.signal?.aborted === true) return error;

  // DNS failure, refused connection, TLS failure, socket reset: all transient
  // enough to be worth another attempt, and indistinguishable here anyway.
  return new UpstreamError(`${context.label} is unreachable`, {
    cause: error,
    retryable: true,
  });
}
