import {
  ServiceUnavailableError,
  UpstreamError,
  readJsonBody,
  sendRequest,
} from '@shopsage/platform';
import { toUpstreamError } from './upstream-error.js';

const HEALTH_TIMEOUT_MS = 3000;

/**
 * TEI's documented failure statuses.
 *
 * The retryable set is small on purpose. 413 and 422 are decided by the *input*: an
 * oversized client batch and an untokenizable string produce the same failure every
 * time, and retrying only delays the report. 429 means the model is genuinely busy,
 * which backoff is exactly the right answer to.
 *
 * @type {Readonly<Record<number, { retryable: boolean, remediation?: string }>>}
 */
const TEI_STATUSES = Object.freeze({
  413: { retryable: false, remediation: 'lower EMBEDDING_BATCH_SIZE' },
  422: {
    retryable: false,
    remediation: 'input could not be tokenized; check for empty or binary text',
  },
  424: { retryable: false, remediation: 'the model failed on this input; check EMBEDDING_MODEL' },
  429: { retryable: true },
});

/**
 * A self-hosted HuggingFace Text Embeddings Inference server.
 *
 * Kept as a first-class option, not as legacy. It is the answer whenever content may
 * not leave the network, when a multilingual open model is wanted, or when per-token
 * cost matters more than operating a service - and switching to it is a change of
 * `EMBEDDING_PROVIDER`, not of code.
 *
 * @type {import('./types.js').EmbeddingsProvider}
 */
export const teiProvider = {
  name: 'tei',

  embedRequest({ settings, inputs }) {
    return {
      url: resolve(settings.baseUrl, 'embed'),
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: {
        inputs,
        // Sent explicitly rather than relying on the service default. Cosine
        // similarity over unnormalized vectors is not cosine similarity, and a
        // default that changed between releases would degrade retrieval silently.
        normalize: true,
        // An over-long input is shortened rather than rejected: availability over
        // completeness, and the reason chunking is sized against `maxInputTokens`.
        truncate: true,
      },
    };
  },

  readEmbeddings(body) {
    if (!Array.isArray(body)) {
      throw new UpstreamError('Embeddings service returned an unexpected body', {
        retryable: false,
      });
    }

    return body.map((vector) => (Array.isArray(vector) ? vector : []));
  },

  mapError({ response }) {
    const known = TEI_STATUSES[response.status];

    return toUpstreamError({
      response,
      retryable: known?.retryable ?? response.status >= 500,
      remediation: known?.remediation,
    });
  },

  async health({ settings, fetchImpl }) {
    const response = await sendRequest({
      url: resolve(settings.baseUrl, 'info'),
      timeoutMs: HEALTH_TIMEOUT_MS,
      label: 'Embeddings health check',
      fetchImpl,
    });

    if (!response.ok) {
      throw new ServiceUnavailableError('Embeddings service is not ready', {
        details: { upstreamStatus: response.status },
      });
    }

    const info = asObject(await readJsonBody(response, 'Embeddings service'));
    const model = typeof info.model_id === 'string' ? info.model_id : '';

    assertExpectedModel(model, settings.model);

    return {
      model,
      maxInputTokens: typeof info.max_input_length === 'number' ? info.max_input_length : 0,
    };
  },
};

/**
 * Fail readiness when the service is serving different weights than configured.
 *
 * The silent-corruption case: someone changes `EMBEDDING_MODEL` and the container keeps
 * serving the old model. Both services are up, every URL probe passes, and vectors from
 * two models end up in one collection producing similarity scores that look plausible
 * and mean nothing.
 *
 * @param {string} reported
 * @param {string} expected
 */
function assertExpectedModel(reported, expected) {
  // Only compare when the service actually told us. A locally mounted model reports a
  // path rather than a repository id, and refusing to start over that is a false alarm.
  if (reported === '' || reported.toLowerCase() === expected.toLowerCase()) return;

  throw new ServiceUnavailableError('Embeddings service is running an unexpected model', {
    details: {
      expected,
      reported,
      remediation:
        'align EMBEDDING_MODEL with the running service, then re-create the collection and re-ingest - vectors from two models are not comparable',
    },
  });
}

/**
 * @param {string} baseUrl
 * @param {string} pathname
 * @returns {string}
 */
function resolve(baseUrl, pathname) {
  const url = new URL(baseUrl);
  url.pathname = `${url.pathname.replace(/\/+$/, '')}/${pathname}`;

  return url.toString();
}

/**
 * @param {unknown} value
 * @returns {Record<string, unknown>}
 */
function asObject(value) {
  return value !== null && typeof value === 'object'
    ? /** @type {Record<string, unknown>} */ (value)
    : {};
}
