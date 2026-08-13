import { UpstreamError, sanitizeUpstreamText } from '@shopsage/platform';

/**
 * Build a classified error from a failed embeddings response.
 *
 * Shared by every provider because the *packaging* is identical - read a bounded
 * excerpt, strip any credential from it, attach the status and a remediation. What
 * differs, and stays with each provider, is the judgement: which statuses are worth
 * retrying and what an operator should check.
 *
 * The body is sanitized even for a provider with no credential. A self-hosted service
 * has none to leak, but its error body still reaches log storage, and a multi-line one
 * would break one-record-per-line parsing.
 *
 * @param {{
 *   response: Response,
 *   apiKey?: string,
 *   retryable: boolean,
 *   remediation?: string,
 * }} input
 * @returns {Promise<UpstreamError>}
 */
export async function toUpstreamError(input) {
  const { response, apiKey, retryable, remediation } = input;

  return new UpstreamError(`Embeddings service returned ${response.status}`, {
    retryable,
    retryAfterSeconds: parseRetryAfter(response.headers.get('retry-after')),
    details: {
      upstreamStatus: response.status,
      upstreamBody: sanitizeUpstreamText(await readBodySafely(response), apiKey),
      ...(remediation === undefined ? {} : { remediation }),
    },
  });
}

/**
 * @param {Response} response
 * @returns {Promise<string>}
 */
async function readBodySafely(response) {
  try {
    return await response.text();
  } catch {
    // A diagnostic detail is never worth failing a request over.
    return '';
  }
}

/**
 * @param {string | null} value
 * @returns {number | undefined}
 */
function parseRetryAfter(value) {
  if (value === null || value.trim() === '') return undefined;

  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds;

  const timestamp = Date.parse(value);

  return Number.isNaN(timestamp)
    ? undefined
    : Math.max(0, Math.round((timestamp - Date.now()) / 1000));
}
