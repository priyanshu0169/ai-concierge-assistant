/**
 * Translate a declarative filter into Qdrant's filter language.
 *
 * This function is the entire reason `VectorFilter` exists. Callers say
 * `{ siteId, contentType }`; only this file knows about `must` clauses and
 * `match` objects. A service that built the Qdrant shape itself would have
 * embedded Qdrant in the domain even without importing anything.
 *
 * @param {import('../types.js').VectorFilter | undefined} filter
 * @returns {Record<string, unknown> | undefined} Undefined when nothing is filtered.
 */
export function toQdrantFilter(filter) {
  const conditions = Object.entries(filter ?? {})
    .filter(([, value]) => typeof value === 'string' && value !== '')
    .map(([key, value]) => ({ key, match: { value } }));

  return conditions.length === 0 ? undefined : { must: conditions };
}
