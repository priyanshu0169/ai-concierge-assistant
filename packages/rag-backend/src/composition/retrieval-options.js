import { ConfigurationError } from '@shopsage/platform';

/**
 * Map the environment onto the retrieval clients' options.
 *
 * The same seam as `llm-options.js`, for the same reason: the clients take plain
 * options and know nothing about ShopSage's environment schema, so this file is the
 * single translation between the two.
 *
 * @param {import('@shopsage/platform').EnvConfig} env
 * @returns {import('@shopsage/embeddings-client').EmbeddingsClientOptions}
 */
export function toEmbeddingsClientOptions(env) {
  assertEmbeddingsConfigured(env);

  return {
    provider: env.EMBEDDING_PROVIDER,
    baseUrl: /** @type {string} */ (env.EMBEDDING_BASE_URL),
    apiKey: env.EMBEDDING_API_KEY,
    authStyle: env.EMBEDDING_AUTH_STYLE,
    model: env.EMBEDDING_MODEL,
    dimensions: env.EMBEDDING_DIMENSIONS,
    batchSize: env.EMBEDDING_BATCH_SIZE,
    timeoutMs: env.EMBEDDING_TIMEOUT_MS,
    queryPrefix: env.EMBEDDING_QUERY_PREFIX,
  };
}

/**
 * Require what has no defensible default, and only that.
 *
 * `EMBEDDING_BASE_URL` always: neither a gateway address nor a self-hosted service
 * address can be guessed, and getting it wrong produces a 404 that reads like a missing
 * model.
 *
 * `EMBEDDING_API_KEY` only for the `openai` provider. A hosted endpoint without a
 * credential is a misconfiguration worth catching at boot rather than on the first
 * customer question; a self-hosted service on a private network legitimately has none,
 * and demanding one there would mean inventing a dummy value.
 *
 * @param {import('@shopsage/platform').EnvConfig} env
 * @throws {ConfigurationError}
 */
function assertEmbeddingsConfigured(env) {
  /** @type {string[]} */
  const missing = [];

  if (env.EMBEDDING_BASE_URL === undefined) missing.push('EMBEDDING_BASE_URL');
  if (env.EMBEDDING_PROVIDER === 'openai' && env.EMBEDDING_API_KEY === undefined) {
    missing.push('EMBEDDING_API_KEY');
  }

  if (missing.length === 0) return;

  throw new ConfigurationError('Embeddings configuration is incomplete', {
    details: {
      missing,
      provider: env.EMBEDDING_PROVIDER,
      remediation:
        env.EMBEDDING_PROVIDER === 'openai'
          ? 'the gateway usually serves embeddings too, so these are often the same values as LLM_BASE_URL and LLM_API_KEY'
          : 'point EMBEDDING_BASE_URL at the self-hosted embeddings service',
    },
  });
}

/**
 * @param {import('@shopsage/platform').EnvConfig} env
 * @returns {import('@shopsage/vector-repository').QdrantRepositoryOptions}
 */
export function toVectorRepositoryOptions(env) {
  return {
    url: env.QDRANT_URL,
    collection: env.QDRANT_COLLECTION,
    // Deliberately the *same* value the embeddings client is given. A collection built
    // for one width and fed vectors of another is the failure this pairing exists to
    // prevent, and it is silent unless both sides agree here.
    dimensions: env.EMBEDDING_DIMENSIONS,
    apiKey: env.QDRANT_API_KEY,
    timeoutMs: env.QDRANT_TIMEOUT_MS,
  };
}
