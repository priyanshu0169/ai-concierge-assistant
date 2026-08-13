import {
  ServiceUnavailableError,
  UpstreamError,
  readJsonBody,
  sendRequest,
} from '@shopsage/platform';
import { toUpstreamError } from './upstream-error.js';

/** A readiness answer must be about now, so a slow check is a failed one. */
const HEALTH_TIMEOUT_MS = 3000;

const TOO_MANY_REQUESTS = 429;
const REQUEST_TIMEOUT = 408;

/**
 * Statuses where an operator is being told something specific.
 *
 * 401 names the model as well as the credential: gateways that do per-team model
 * access control answer 401 - not 403 - for a model the key may not use, and pointing
 * only at the key sends someone to rotate a credential that was fine. Learned the hard
 * way against this project's own gateway; see docs/adr/0012.
 *
 * @type {Readonly<Record<number, string>>}
 */
const REMEDIATION = Object.freeze({
  401: 'check EMBEDDING_API_KEY, then EMBEDDING_MODEL - some gateways answer 401 for a model the key may not use',
  403: 'check that EMBEDDING_API_KEY is permitted to use EMBEDDING_MODEL',
  404: 'check EMBEDDING_BASE_URL and EMBEDDING_MODEL',
});

/**
 * Any endpoint speaking the OpenAI embeddings wire format.
 *
 * An internal AI gateway, LiteLLM, Azure OpenAI, OpenAI itself, or a self-hosted
 * server that exposes the compatible route - the client cannot tell them apart, and
 * nothing above this file learns which one answered.
 *
 * @type {import('./types.js').EmbeddingsProvider}
 */
export const openAiProvider = {
  name: 'openai',

  embedRequest({ settings, inputs }) {
    return {
      url: resolve(settings.baseUrl, 'embeddings'),
      headers: {
        'content-type': 'application/json',
        accept: 'application/json',
        ...authHeaders(settings),
      },
      body: {
        model: settings.model,
        input: inputs,
        // Explicit: some gateways default to base64, which would arrive as strings
        // and fail the dimension check with a baffling message.
        encoding_format: 'float',
      },
    };
  },

  readEmbeddings(body) {
    const envelope = asObject(body);
    const data = envelope.data;

    if (!Array.isArray(data)) {
      throw new UpstreamError('Embeddings service returned no data array', { retryable: false });
    }

    // Sorted by the index the provider assigned. The specification does not promise
    // response order, and `index` exists precisely so a caller does not have to trust
    // it - a silently reordered batch would attach every vector to the wrong chunk.
    return [...data]
      .map((entry, position) => ({ entry: asObject(entry), position }))
      .sort((left, right) => indexOf(left) - indexOf(right))
      .map(({ entry }) => entry.embedding)
      .map((embedding) => (Array.isArray(embedding) ? embedding : []));
  },

  mapError({ response, settings }) {
    const status = response.status;

    return toUpstreamError({
      response,
      apiKey: settings.apiKey,
      // 4xx is our request being wrong and will be wrong again; 429 and 5xx are the
      // transient class.
      retryable: status >= 500 || status === TOO_MANY_REQUESTS || status === REQUEST_TIMEOUT,
      remediation: REMEDIATION[status],
    });
  },

  async health({ settings, fetchImpl }) {
    const response = await sendRequest({
      url: resolve(settings.baseUrl, 'models'),
      headers: { accept: 'application/json', ...authHeaders(settings) },
      timeoutMs: HEALTH_TIMEOUT_MS,
      label: 'Embeddings health check',
      fetchImpl,
    });

    // Model discovery is optional in the wire format. A gateway without it is not
    // unhealthy, so reachability is all we can honestly assert.
    if (response.status === 404 || response.status === 405) {
      return { model: settings.model, maxInputTokens: 0 };
    }

    if (!response.ok) {
      throw new ServiceUnavailableError('Embeddings service is not ready', {
        details: { upstreamStatus: response.status },
      });
    }

    assertModelAvailable(await readJsonBody(response, 'Embeddings service'), settings.model);

    // The wire format reports no input limit, so chunking cannot be sized from it the
    // way it can with a self-hosted service.
    return { model: settings.model, maxInputTokens: 0 };
  },
};

/**
 * Fail readiness when the configured model is not on offer.
 *
 * The same class of failure the self-hosted provider guards against: a model name that
 * does not resolve produces vectors from something else, or no vectors at all, and
 * either way the corpus and the queries stop being comparable. Catching it at
 * readiness beats catching it on a customer's first question.
 *
 * @param {unknown} body
 * @param {string} expected
 */
function assertModelAvailable(body, expected) {
  const data = asObject(body).data;
  if (!Array.isArray(data)) return;

  const available = data.map((entry) => asObject(entry).id).filter((id) => typeof id === 'string');

  // An empty list means the gateway does not enumerate; that is not evidence of absence.
  if (available.length === 0 || available.includes(expected)) return;

  throw new ServiceUnavailableError('Embeddings service does not offer the configured model', {
    details: {
      expected,
      available: available.slice(0, 20),
      remediation: 'align EMBEDDING_MODEL with a model the gateway exposes',
    },
  });
}

/**
 * @param {import('../client-options.js').EmbeddingsSettings} settings
 * @returns {Record<string, string>}
 */
function authHeaders(settings) {
  if (settings.apiKey === undefined) return {};

  return settings.authStyle === 'api-key'
    ? { 'api-key': settings.apiKey }
    : { authorization: `Bearer ${settings.apiKey}` };
}

/**
 * @param {{ entry: Record<string, unknown>, position: number }} item
 * @returns {number}
 */
function indexOf(item) {
  return typeof item.entry.index === 'number' ? item.entry.index : item.position;
}

/**
 * Join a path onto the base URL, preserving any path the base already carries.
 *
 * `new URL('embeddings', base)` would discard it, breaking every gateway whose API
 * base ends in `/v1`.
 *
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
