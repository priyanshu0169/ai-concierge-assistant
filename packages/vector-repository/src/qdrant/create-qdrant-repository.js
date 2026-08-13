import { ServiceUnavailableError, sendRequest } from '@shopsage/platform';
import { collectionExists, createCollection } from './collection-operations.js';
import { count, insert, list, remove, search } from './point-operations.js';
import { qdrantUrl, resolveQdrantSettings } from './repository-options.js';

/** A readiness answer must be about now, so a slow check is a failed one. */
const HEALTH_TIMEOUT_MS = 3000;

/**
 * Construct the Qdrant-backed `VectorRepository`.
 *
 * This is the only file in the repository that knows Qdrant exists, and the
 * object it returns is the port from `types.js` and nothing more. Swapping to
 * pgvector or another store means writing a sibling of this directory and
 * changing one line in the composition root.
 *
 * Plain HTTP rather than the Qdrant SDK, for the same reasons as the LLM client:
 * one fewer vendor release cycle to track, and `fetch` is the injection seam that
 * makes every operation testable without a running database.
 *
 * @param {import('../types.js').QdrantRepositoryOptions} options
 * @returns {import('../types.js').VectorRepository}
 * @throws {import('@shopsage/platform').ConfigurationError} On invalid settings.
 */
export function createQdrantRepository(options) {
  const settings = resolveQdrantSettings(options);

  /** @type {import('./request.js').QdrantContext} */
  const context = {
    settings,
    logger: options.logger,
    fetchImpl: options.fetchImpl ?? fetch,
    sleep: options.sleep,
    random: options.random,
  };

  return {
    createCollection: () => createCollection(context),
    collectionExists: () => collectionExists(context),
    insert: (points) => insert(context, points),
    search: (query) => search(context, query),
    list: (query) => list(context, query),
    delete: (criteria) => remove(context, criteria),
    count: (filter) => count(context, filter),
    health: () => checkHealth(context),
  };
}

/**
 * Report whether the store is ready to serve.
 *
 * Uses Qdrant's own `/readyz`, which reports shard readiness - a node that is up
 * but still loading shards would answer other requests with errors, so
 * "reachable" is not the question worth asking.
 *
 * Collection existence is deliberately **not** checked. A missing collection is
 * the correct state before the first ingestion run, and failing readiness on it
 * would mean a fresh deployment could never become ready enough to be ingested
 * into. It becomes part of readiness in Stage 6, when retrieval depends on it.
 *
 * @param {import('./request.js').QdrantContext} context
 * @returns {Promise<void>}
 */
async function checkHealth(context) {
  const { settings, fetchImpl } = context;

  const response = await sendRequest({
    url: qdrantUrl(settings, 'readyz'),
    timeoutMs: HEALTH_TIMEOUT_MS,
    label: 'Vector store health check',
    fetchImpl,
  });

  if (!response.ok) {
    throw new ServiceUnavailableError('Vector store is not ready', {
      details: { upstreamStatus: response.status },
    });
  }
}
