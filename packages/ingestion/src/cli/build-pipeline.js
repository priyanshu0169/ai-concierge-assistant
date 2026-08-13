import { createSourceRegistry } from '@shopsage/content-model';
import { createEmbeddingsClient } from '@shopsage/embeddings-client';
import { createLogger, loadConfig } from '@shopsage/platform';
import { WEBSITE_SOURCE_TYPE, createWebsiteSource } from '@shopsage/scraper';
import { createQdrantRepository } from '@shopsage/vector-repository';

/**
 * The ingestion entry point's composition root.
 *
 * The same role `build-application.js` plays for the backend, and the same rule: this
 * is the only file here allowed to read the environment or construct a dependency.
 *
 * It differs from the backend's in one deliberate way — **no LLM client**. Ingestion
 * never calls a model, so it must not require gateway credentials to run. That is the
 * whole reason `LLM_*` is mandatory in the backend's composition root rather than in
 * the shared environment schema (docs/adr/0013), and this is the entry point that
 * would otherwise have been forced to carry a credential it never uses.
 *
 * The source registry is handed its factories here too, so `content-model` stays free
 * of any source implementation and a new source kind is one line in this file.
 *
 * @param {{ env?: Record<string, string | undefined>, verbose?: boolean }} [options]
 */
export async function buildPipeline(options = {}) {
  const config = await loadConfig({ env: options.env });
  const { env, siteProfile } = config;

  const logger = createLogger({
    level: options.verbose === true ? 'debug' : env.LOG_LEVEL,
    format: env.LOG_FORMAT,
    name: 'shopsage-ingestion',
    bindings: { siteId: siteProfile.identity.siteId },
  });

  const embeddings = createEmbeddingsClient({
    provider: env.EMBEDDING_PROVIDER,
    baseUrl: requireValue(env.EMBEDDING_BASE_URL, 'EMBEDDING_BASE_URL'),
    apiKey: env.EMBEDDING_API_KEY,
    authStyle: env.EMBEDDING_AUTH_STYLE,
    model: env.EMBEDDING_MODEL,
    dimensions: env.EMBEDDING_DIMENSIONS,
    batchSize: env.EMBEDDING_BATCH_SIZE,
    timeoutMs: env.EMBEDDING_TIMEOUT_MS,
    queryPrefix: env.EMBEDDING_QUERY_PREFIX,
    logger: logger.child({ component: 'embeddings-client' }),
  });

  const store = createQdrantRepository({
    url: env.QDRANT_URL,
    collection: env.QDRANT_COLLECTION,
    dimensions: env.EMBEDDING_DIMENSIONS,
    apiKey: env.QDRANT_API_KEY,
    timeoutMs: env.QDRANT_TIMEOUT_MS,
    logger: logger.child({ component: 'vector-repository' }),
  });

  const registry = createSourceRegistry({ [WEBSITE_SOURCE_TYPE]: createWebsiteSource });

  return { config, logger, embeddings, store, registry };
}

/**
 * @param {string | undefined} value
 * @param {string} name
 * @returns {string}
 */
function requireValue(value, name) {
  if (value === undefined) {
    throw new Error(`${name} is required. Ingestion cannot embed without an embeddings endpoint.`);
  }

  return value;
}
