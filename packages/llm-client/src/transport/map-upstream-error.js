import { UpstreamError, sanitizeUpstreamText } from '@shopsage/platform';

/** A broken gateway must not be able to stall a request by withholding a body. */
const BODY_READ_TIMEOUT_MS = 2000;

const TOO_MANY_REQUESTS = 429;
const REQUEST_TIMEOUT = 408;

/**
 * Operator guidance for the failures that are almost always misconfiguration.
 *
 * Naming environment variables here is intentional: this package owns them
 * (docs/adr/0005), and "LLM gateway returned 404" without "check LLM_MODEL"
 * sends people reading the wrong logs.
 */
/**
 * 401 mentions the model, not just the credential, because gateways that do
 * per-team model access control answer 401 - not 403 or 404 - for a model the
 * key is simply not entitled to use. Verified against LiteLLM, which replies
 * `team not allowed to access model` with status 401. Pointing only at
 * `LLM_API_KEY` there sends an operator to rotate a credential that is fine.
 *
 * @type {Readonly<Record<number, string>>}
 */
const REMEDIATION = Object.freeze({
  401: 'check LLM_API_KEY, then LLM_MODEL (some gateways answer 401 for a model the key may not use), then LLM_AUTH_STYLE if the gateway is Azure OpenAI',
  403: 'check that LLM_API_KEY is permitted to use LLM_MODEL',
  404: 'check LLM_BASE_URL and LLM_MODEL',
});

/**
 * Translate a failed HTTP response into ShopSage's error taxonomy.
 *
 * Every outcome is an `UpstreamError`, including rate limiting. A gateway's 429
 * is *not* the customer's 429: surfacing it as one would tell a customer they
 * are being throttled when they are not, and `RateLimitError` exposes its
 * `details` to the caller - which here would publish the gateway's status and
 * error body to a browser. As a masked 502 the operator still gets everything
 * in the logs, and `retryAfterSeconds` still drives the backoff.
 *
 * @param {{ response: Response, apiKey: string }} input
 * @returns {Promise<UpstreamError>}
 */
export async function mapUpstreamError(input) {
  const { response, apiKey } = input;
  const status = response.status;

  /** @type {Record<string, unknown>} */
  const details = {
    upstreamStatus: status,
    upstreamBody: sanitizeUpstreamText(await readBodySafely(response), apiKey),
    ...(REMEDIATION[status] === undefined ? {} : { remediation: REMEDIATION[status] }),
  };

  if (status === TOO_MANY_REQUESTS) {
    return new UpstreamError('LLM gateway rate limited the request', {
      details,
      retryable: true,
      retryAfterSeconds: parseRetryAfter(response.headers.get('retry-after')),
    });
  }

  return new UpstreamError(`LLM gateway returned ${status}`, {
    details,
    // 4xx means our request was wrong and will be wrong again. 5xx and 408 are
    // the transient class.
    retryable: status >= 500 || status === REQUEST_TIMEOUT,
  });
}

/**
 * Read an error body without inheriting the gateway's willingness to hang.
 *
 * Cancelling the body is what enforces the deadline; `withTimeout` cannot, since
 * `Response.text()` takes no signal.
 *
 * @param {Response} response
 * @returns {Promise<string>}
 */
async function readBodySafely(response) {
  const timer = setTimeout(() => {
    void response.body?.cancel().catch(() => {});
  }, BODY_READ_TIMEOUT_MS);
  timer.unref?.();

  try {
    return await response.text();
  } catch {
    // A diagnostic detail is never worth failing a request over.
    return '';
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Parse `Retry-After`, which is specified as either seconds or an HTTP date.
 *
 * No sanity ceiling is applied: `withRetry` clamps to its own `maxDelayMs`, so a
 * hostile header cannot stall a request here.
 *
 * @param {string | null} value
 * @returns {number | undefined}
 */
function parseRetryAfter(value) {
  if (value === null || value.trim() === '') return undefined;

  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds;

  const timestamp = Date.parse(value);
  if (Number.isNaN(timestamp)) return undefined;

  return Math.max(0, Math.round((timestamp - Date.now()) / 1000));
}
