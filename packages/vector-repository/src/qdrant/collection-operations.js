import { collectionPath, qdrantUrl } from './repository-options.js';
import { qdrantRequest } from './request.js';

/**
 * Cosine, because the embeddings client normalizes every vector. Cosine over
 * normalized vectors is the metric BGE-M3 was trained for; using Euclidean
 * instead would not error, it would just rank slightly wrong forever.
 */
const DISTANCE = 'Cosine';

/** Qdrant answers 409 when the collection is already there. */
const ALREADY_EXISTS = 409;
const NOT_FOUND = 404;

/**
 * Create the collection if it is not already there, then ensure the tenancy
 * index exists.
 *
 * **Idempotent by design.** The ingestion CLI runs repeatedly, often against a
 * populated store, and a create that failed on "already exists" would make every
 * run after the first one require a special case.
 *
 * @param {import('./request.js').QdrantContext} context
 * @returns {Promise<void>}
 */
export async function createCollection(context) {
  const { settings } = context;

  await qdrantRequest(context, {
    url: qdrantUrl(settings, collectionPath(settings)),
    method: 'PUT',
    body: { vectors: { size: settings.dimensions, distance: DISTANCE } },
    expectedStatuses: [ALREADY_EXISTS],
  });

  for (const field of INDEXED_FIELDS) await ensureIndex(context, field);
}

/**
 * Payload fields every access pattern filters on.
 *
 * `siteId` is not an optimisation to add later: with a shared collection, every
 * single query filters on it, and unindexed Qdrant considers the whole corpus and
 * then discards most of it - a cost that grows with each store onboarded
 * (docs/adr/0006).
 *
 * `documentId` and `sourceId` are ingestion's access pattern: "what do I already
 * hold for this document?" runs once per document on every re-ingestion, and "what
 * belongs to this source?" runs once per prune.
 */
const INDEXED_FIELDS = ['siteId', 'documentId', 'sourceId'];

/**
 * @param {import('./request.js').QdrantContext} context
 * @param {string} field
 * @returns {Promise<void>}
 */
async function ensureIndex(context, field) {
  const { settings } = context;

  await qdrantRequest(context, {
    url: qdrantUrl(settings, `${collectionPath(settings)}/index`, { wait: 'true' }),
    method: 'PUT',
    body: { field_name: field, field_schema: 'keyword' },
    // Re-creating an existing index is reported as a conflict, which is the
    // normal case on every run after the first.
    expectedStatuses: [ALREADY_EXISTS],
  });
}

/**
 * @param {import('./request.js').QdrantContext} context
 * @returns {Promise<boolean>}
 */
export async function collectionExists(context) {
  const { settings } = context;

  const { status, body } = await qdrantRequest(context, {
    url: qdrantUrl(settings, `${collectionPath(settings)}/exists`),
    expectedStatuses: [NOT_FOUND],
  });

  if (status === NOT_FOUND) return false;

  const result = asObject(asObject(body).result);

  return result.exists === true;
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
