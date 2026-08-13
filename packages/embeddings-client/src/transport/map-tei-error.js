import { UpstreamError } from '@shopsage/platform';

const MAX_BODY_LENGTH = 300;

/**
 * TEI's documented failure statuses, and whether repeating the request could
 * plausibly help.
 *
 * The retryable set is small on purpose. 413 and 422 are decided by the *input*:
 * an oversized client batch and an untokenizable string produce the same failure
 * every time, and retrying only delays the report. 429 means the model is
 * genuinely busy, which backoff is exactly the right answer to.
 *
 * @type {Readonly<Record<number, { retryable: boolean, remediation?: string }>>}
 */
const TEI_STATUSES = Object.freeze({
  413: { retryable: false, remediation: 'lower EMBEDDINGS_BATCH_SIZE' },
  422: {
    retryable: false,
    remediation: 'input could not be tokenized; check for empty or binary text',
  },
  424: { retryable: false, remediation: 'the model failed on this input; check EMBEDDING_MODEL' },
  429: { retryable: true },
});

/**
 * Translate a failed TEI response into ShopSage's error taxonomy.
 *
 * The body is truncated and stripped of newlines. No credential is involved -
 * TEI is unauthenticated on a private network - but an error body still reaches
 * log storage, and a multi-line one would break one-record-per-line parsing.
 *
 * @param {Response} response
 * @returns {Promise<UpstreamError>}
 */
export async function mapTeiError(response) {
  const status = response.status;
  const known = TEI_STATUSES[status];
  const retryable = known?.retryable ?? status >= 500;

  return new UpstreamError(`Embeddings service returned ${status}`, {
    retryable,
    details: {
      upstreamStatus: status,
      upstreamBody: await readBodyExcerpt(response),
      ...(known?.remediation === undefined ? {} : { remediation: known.remediation }),
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
    // A diagnostic detail is never worth failing a request over.
    return '';
  }
}
