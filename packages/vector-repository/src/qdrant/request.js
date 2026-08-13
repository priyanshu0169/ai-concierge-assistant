import { UpstreamError, readJsonBody, sendRequest, withRetry } from '@shopsage/platform';

const MAX_BODY_LENGTH = 300;

/**
 * Operator guidance for the failures that are configuration, not code.
 *
 * @type {Readonly<Record<number, string>>}
 */
const REMEDIATION = Object.freeze({
  401: 'check QDRANT_API_KEY - it must match the value Qdrant was started with',
  403: 'check QDRANT_API_KEY - the key may be read-only',
  404: 'check QDRANT_COLLECTION, and run ingestion to create the collection if it does not exist yet',
});

/**
 * @typedef {object} QdrantContext
 * @property {import('./repository-options.js').QdrantSettings} settings
 * @property {import('@shopsage/platform').Logger} [logger]
 * @property {typeof fetch} fetchImpl
 * @property {(ms: number) => Promise<void>} [sleep]
 * @property {() => number} [random]
 */

/**
 * @typedef {object} QdrantRequest
 * @property {string} url
 * @property {string} [method] Default `GET`.
 * @property {unknown} [body]
 * @property {number[]} [expectedStatuses] Statuses to return rather than throw on.
 */

/**
 * Perform a Qdrant request, with retries.
 *
 * Retrying is safe for every operation this adapter performs, and not by
 * accident: upsert is keyed by id, delete is idempotent, and search and count are
 * reads. Nothing here appends, so a retry after an ambiguous failure cannot
 * duplicate data.
 *
 * @param {QdrantContext} context
 * @param {QdrantRequest} request
 * @returns {Promise<{ status: number, body: unknown }>}
 */
export function qdrantRequest(context, request) {
  const { settings, logger, sleep, random } = context;

  return withRetry(() => attempt(context, request), {
    maxAttempts: settings.maxAttempts,
    sleep,
    random,
    onRetry: (notice) =>
      logger?.warn('qdrant request failed, retrying', {
        attempt: notice.attempt,
        delayMs: notice.delayMs,
        err: notice.error,
      }),
  });
}

/**
 * @param {QdrantContext} context
 * @param {QdrantRequest} request
 * @returns {Promise<{ status: number, body: unknown }>}
 */
async function attempt(context, request) {
  const { settings, fetchImpl } = context;
  const { url, method = 'GET', body, expectedStatuses = [] } = request;

  const response = await sendRequest({
    url,
    method,
    headers: {
      'content-type': 'application/json',
      accept: 'application/json',
      // Absent when Qdrant runs without authentication, which is the local
      // default. Sending an empty header would be rejected outright.
      ...(settings.apiKey === undefined ? {} : { 'api-key': settings.apiKey }),
    },
    body,
    timeoutMs: settings.timeoutMs,
    label: 'Vector store request',
    fetchImpl,
  });

  if (!response.ok && !expectedStatuses.includes(response.status)) {
    throw await mapQdrantError(response);
  }

  // An expected non-2xx (404 from an existence check) has no body worth reading.
  const parsed = response.ok ? await readJsonBody(response, 'Vector store') : undefined;

  return { status: response.status, body: parsed };
}

/**
 * @param {Response} response
 * @returns {Promise<UpstreamError>}
 */
async function mapQdrantError(response) {
  const status = response.status;
  const remediation = REMEDIATION[status];

  return new UpstreamError(`Vector store returned ${status}`, {
    // 4xx is our request being wrong, and it will be wrong again. 5xx and 429
    // are the transient class.
    retryable: status >= 500 || status === 429,
    details: {
      upstreamStatus: status,
      upstreamBody: await readBodyExcerpt(response),
      ...(remediation === undefined ? {} : { remediation }),
    },
  });
}

/**
 * @param {Response} response
 * @returns {Promise<string>}
 */
async function readBodyExcerpt(response) {
  try {
    const text = (await response.text()).replace(/\s+/g, ' ').trim();

    return text.length > MAX_BODY_LENGTH ? `${text.slice(0, MAX_BODY_LENGTH)}…` : text;
  } catch {
    return '';
  }
}
