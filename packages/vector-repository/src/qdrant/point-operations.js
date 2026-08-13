import { UpstreamError, ValidationError } from '@shopsage/platform';
import { toQdrantFilter } from './filters.js';
import { RESERVED_ID_KEY, toStoreId } from './point-id.js';
import { collectionPath, qdrantUrl } from './repository-options.js';
import { qdrantRequest } from './request.js';

const DEFAULT_TOP_K = 6;
const DEFAULT_PAGE_SIZE = 256;

/**
 * Upsert points.
 *
 * `wait=true` makes the write visible before this resolves. Qdrant indexes
 * asynchronously by default, which would make an ingestion run that counts its
 * own output - or a test that reads back what it just wrote - intermittently
 * wrong in a way that looks like data loss.
 *
 * @param {import('./request.js').QdrantContext} context
 * @param {import('../types.js').VectorPoint[]} points
 * @returns {Promise<void>}
 */
export async function insert(context, points) {
  if (!Array.isArray(points)) throw new ValidationError('points must be an array');
  if (points.length === 0) return;

  const { settings } = context;

  await qdrantRequest(context, {
    url: qdrantUrl(settings, `${collectionPath(settings)}/points`, { wait: 'true' }),
    method: 'PUT',
    body: { points: points.map((point) => toWirePoint(point, settings.dimensions)) },
  });
}

/**
 * Similarity search, always scoped to one store.
 *
 * The tenant filter is applied here, from a required field, so no caller can omit
 * it. `minScore` becomes Qdrant's `score_threshold` so the store discards weak
 * matches itself rather than shipping them back to be filtered.
 *
 * @param {import('./request.js').QdrantContext} context
 * @param {import('../types.js').VectorSearchQuery} query
 * @returns {Promise<import('../types.js').VectorMatch[]>}
 */
export async function search(context, query) {
  const { settings, logger } = context;
  assertVector(query.vector, settings.dimensions);
  assertSiteId(query.siteId);

  const filter = toQdrantFilter({ ...query.filter, siteId: query.siteId });
  const limit = query.topK ?? DEFAULT_TOP_K;

  // TEMPORARY: retrieval debug instrumentation (sources: [] investigation). Remove
  // once the empty-sources cause is confirmed.
  logger?.debug('qdrant search request debug', {
    collection: settings.collection,
    siteId: query.siteId,
    filter,
    limit,
    scoreThreshold: query.minScore,
    vectorLength: query.vector.length,
  });

  const { body } = await qdrantRequest(context, {
    url: qdrantUrl(settings, `${collectionPath(settings)}/points/search`),
    method: 'POST',
    body: {
      vector: query.vector,
      limit,
      filter,
      ...(query.minScore === undefined ? {} : { score_threshold: query.minScore }),
      with_payload: true,
    },
  });

  const results = asObject(body).result;
  const raw = Array.isArray(results) ? results : [];

  // TEMPORARY: retrieval debug instrumentation (sources: [] investigation). Remove
  // once the empty-sources cause is confirmed. This is the response exactly as Qdrant
  // returned it, before `toMatch` reshapes it - already post score-filtering, since
  // `score_threshold` above is applied by Qdrant itself, not by this client.
  logger?.debug('qdrant search response debug', {
    collection: settings.collection,
    rawCount: raw.length,
    raw: raw.map(summarizeRawMatch),
  });

  return raw.map(toMatch);
}

/**
 * @param {unknown} raw
 * @returns {Record<string, unknown>}
 */
function summarizeRawMatch(raw) {
  const scored = asObject(raw);
  const payload = asObject(scored.payload);

  return {
    id: scored.id,
    score: scored.score,
    documentId: payload.documentId,
    title: payload.title,
    chunkIndex: payload.chunkIndex,
    siteId: payload.siteId,
  };
}

/**
 * Enumerate stored points, one page at a time.
 *
 * Vectors are deliberately not fetched. The callers of this are asking about
 * *state* - which chunks exist, and with what content hash - and a page of 256
 * vectors at 1536 dimensions is several megabytes of data nobody reads.
 *
 * @param {import('./request.js').QdrantContext} context
 * @param {import('../types.js').VectorListQuery} query
 * @returns {Promise<import('../types.js').VectorPage>}
 */
export async function list(context, query) {
  const { settings } = context;
  assertSiteId(query.siteId);

  const { body } = await qdrantRequest(context, {
    url: qdrantUrl(settings, `${collectionPath(settings)}/points/scroll`),
    method: 'POST',
    body: {
      filter: toQdrantFilter({ ...query.filter, siteId: query.siteId }),
      limit: query.limit ?? DEFAULT_PAGE_SIZE,
      with_payload: true,
      with_vector: false,
      ...(query.cursor === undefined ? {} : { offset: query.cursor }),
    },
  });

  const result = asObject(asObject(body).result);
  const points = Array.isArray(result.points) ? result.points : [];
  const next = result.next_page_offset;

  return {
    points: points.map(toListedPoint),
    // Qdrant reports null on the last page; the port says "absent".
    ...(next === null || next === undefined ? {} : { cursor: String(next) }),
  };
}

/**
 * Delete by id, or by filter.
 *
 * A filtered delete requires `siteId`. Without that rule, one forgotten field
 * turns "remove this store's stale content" into "remove everything", and a
 * vector store has no undo.
 *
 * @param {import('./request.js').QdrantContext} context
 * @param {import('../types.js').VectorDeleteCriteria} criteria
 * @returns {Promise<void>}
 */
export async function remove(context, criteria) {
  const { settings } = context;
  const body = toDeleteBody(criteria);

  await qdrantRequest(context, {
    url: qdrantUrl(settings, `${collectionPath(settings)}/points/delete`, { wait: 'true' }),
    method: 'POST',
    body,
  });
}

/**
 * @param {import('./request.js').QdrantContext} context
 * @param {import('../types.js').VectorFilter} [filter]
 * @returns {Promise<number>}
 */
export async function count(context, filter) {
  const { settings } = context;

  const { body } = await qdrantRequest(context, {
    url: qdrantUrl(settings, `${collectionPath(settings)}/points/count`),
    method: 'POST',
    // Exact: an approximate count is worse than useless for verifying an
    // ingestion run, which is what this method exists for.
    body: { exact: true, filter: toQdrantFilter(filter) },
  });

  const result = asObject(asObject(body).result);

  return typeof result.count === 'number' ? result.count : 0;
}

/**
 * @param {import('../types.js').VectorDeleteCriteria} criteria
 * @returns {Record<string, unknown>}
 */
function toDeleteBody(criteria) {
  const ids = criteria.ids;
  const filter = criteria.filter;

  if (Array.isArray(ids) && filter === undefined) {
    if (ids.length === 0) throw new ValidationError('delete requires at least one id');
    return { points: ids.map(toStoreId) };
  }

  if (filter !== undefined && ids === undefined) {
    assertSiteId(filter.siteId);
    return { filter: toQdrantFilter(filter) };
  }

  throw new ValidationError('delete requires exactly one of ids or filter');
}

/**
 * @param {import('../types.js').VectorPoint} point
 * @param {number} dimensions
 * @returns {Record<string, unknown>}
 */
function toWirePoint(point, dimensions) {
  assertVector(point.vector, dimensions);

  if (typeof point.id !== 'string' || point.id === '') {
    throw new ValidationError('every point requires a non-empty id');
  }

  const payload = point.payload ?? /** @type {import('../types.js').VectorPayload} */ ({});
  assertSiteId(payload.siteId);

  if (Object.hasOwn(payload, RESERVED_ID_KEY)) {
    throw new ValidationError(`${RESERVED_ID_KEY} is reserved and must not be set by a caller`);
  }

  return {
    id: toStoreId(point.id),
    vector: point.vector,
    // The caller's own id rides along in the payload so `search` can return it.
    // Without this, callers would see derived UUIDs they never supplied.
    payload: { ...payload, [RESERVED_ID_KEY]: point.id },
  };
}

/**
 * @param {unknown} raw
 * @returns {{ id: string, payload: import('../types.js').VectorPayload }}
 */
function toListedPoint(raw) {
  const point = asObject(raw);
  const payload = asObject(point.payload);
  const { [RESERVED_ID_KEY]: originalId, ...rest } = payload;

  return {
    id: typeof originalId === 'string' ? originalId : String(point.id ?? ''),
    payload: /** @type {import('../types.js').VectorPayload} */ (rest),
  };
}

/**
 * @param {unknown} raw
 * @returns {import('../types.js').VectorMatch}
 */
function toMatch(raw) {
  const scored = asObject(raw);
  const payload = asObject(scored.payload);
  const { [RESERVED_ID_KEY]: originalId, ...rest } = payload;

  return {
    // Fall back to the store's id only if the point predates the reserved key.
    id: typeof originalId === 'string' ? originalId : String(scored.id ?? ''),
    score: typeof scored.score === 'number' ? scored.score : 0,
    payload: /** @type {import('../types.js').VectorPayload} */ (rest),
  };
}

/**
 * @param {unknown} vector
 * @param {number} dimensions
 */
function assertVector(vector, dimensions) {
  if (!Array.isArray(vector) || vector.length !== dimensions) {
    throw new ValidationError(`vector must have exactly ${dimensions} dimensions`, {
      details: { received: Array.isArray(vector) ? vector.length : 0 },
    });
  }

  if (vector.some((value) => typeof value !== 'number' || !Number.isFinite(value))) {
    // NaN reaches a vector store happily and then poisons every similarity
    // score computed against it.
    throw new UpstreamError('vector contains a value that is not a finite number', {
      retryable: false,
    });
  }
}

/**
 * @param {unknown} siteId
 */
function assertSiteId(siteId) {
  if (typeof siteId !== 'string' || siteId === '') {
    throw new ValidationError('siteId is required - it is what keeps stores isolated');
  }
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
