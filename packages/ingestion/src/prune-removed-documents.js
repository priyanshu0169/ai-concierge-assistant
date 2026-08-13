import { PAYLOAD_KEYS } from './to-vector-point.js';

/**
 * A run that saw less than this fraction of what is stored is treated as partial.
 *
 * The number is a judgement, not a measurement: content shrinking by more than half
 * in one run is possible but rare, whereas a crawl cut short by a network problem is
 * common. Erring toward keeping stale content is the cheaper mistake - it answers
 * slightly out-of-date questions, where the alternative silently empties a store's
 * knowledge base and the assistant starts refusing everything.
 */
const MINIMUM_COVERAGE = 0.5;

/**
 * @typedef {object} PruneOutcome
 * @property {boolean} pruned
 * @property {number} documentsRemoved
 * @property {number} chunksRemoved
 * @property {string} [skippedReason]
 */

/**
 * Remove chunks belonging to documents the source no longer produces.
 *
 * Necessary because deletion is otherwise invisible: a page taken down stays in the
 * index and keeps answering questions, and nothing in a normal ingestion run would
 * ever notice. Retrieval has no way to tell a live answer from a deleted one.
 *
 * It is also the most dangerous operation in the pipeline, because "documents I did
 * not see" and "documents that no longer exist" are only the same thing when the run
 * was complete. Two guards, both refusing to prune rather than risking the corpus:
 *
 * - **A run with failures never prunes.** An unreachable page is not a deleted page.
 * - **A run that covered too little of what is stored never prunes.** A crawl that
 *   died after ten of five hundred pages would otherwise delete the other 490.
 *
 * @param {{
 *   store: import('@shopsage/vector-repository').VectorRepository,
 *   siteId: string,
 *   sourceId: string,
 *   seenDocumentIds: Set<string>,
 *   failures: number,
 *   logger?: import('@shopsage/platform').Logger,
 * }} input
 * @returns {Promise<PruneOutcome>}
 */
export async function pruneRemovedDocuments(input) {
  const { store, siteId, sourceId, seenDocumentIds, failures, logger } = input;

  if (failures > 0) {
    return skip(logger, 'the run had failures, so an unseen document may simply be unreachable', {
      failures,
    });
  }

  const stored = await loadStoredDocuments({ store, siteId, sourceId });

  if (stored.size === 0) return { pruned: true, documentsRemoved: 0, chunksRemoved: 0 };

  const coverage = countSeen(stored, seenDocumentIds) / stored.size;
  if (coverage < MINIMUM_COVERAGE) {
    return skip(logger, 'the run covered too little of what is stored to be trusted as complete', {
      coverage: Number(coverage.toFixed(3)),
      minimumCoverage: MINIMUM_COVERAGE,
      storedDocuments: stored.size,
      seenDocuments: seenDocumentIds.size,
    });
  }

  const removable = [...stored.entries()].filter(
    ([documentId]) => !seenDocumentIds.has(documentId),
  );
  const chunkIds = removable.flatMap(([, ids]) => ids);

  if (chunkIds.length > 0) await store.delete({ ids: chunkIds });

  logger?.info('pruned documents the source no longer produces', {
    sourceId,
    documentsRemoved: removable.length,
    chunksRemoved: chunkIds.length,
  });

  return { pruned: true, documentsRemoved: removable.length, chunksRemoved: chunkIds.length };
}

/**
 * @param {import('@shopsage/platform').Logger | undefined} logger
 * @param {string} reason
 * @param {Record<string, unknown>} fields
 * @returns {PruneOutcome}
 */
function skip(logger, reason, fields) {
  logger?.warn('skipping prune', {
    ...fields,
    reason,
    consequence: 'content removed at the source stays in the index until a clean run',
  });

  return { pruned: false, documentsRemoved: 0, chunksRemoved: 0, skippedReason: reason };
}

/**
 * @param {Map<string, string[]>} stored
 * @param {Set<string>} seen
 * @returns {number}
 */
function countSeen(stored, seen) {
  return [...stored.keys()].filter((documentId) => seen.has(documentId)).length;
}

/**
 * Every stored document for this source, as documentId → chunk ids.
 *
 * @param {{
 *   store: import('@shopsage/vector-repository').VectorRepository,
 *   siteId: string,
 *   sourceId: string,
 * }} input
 * @returns {Promise<Map<string, string[]>>}
 */
async function loadStoredDocuments(input) {
  const { store, siteId, sourceId } = input;
  /** @type {Map<string, string[]>} */
  const documents = new Map();

  /** @type {string | undefined} */
  let cursor;

  do {
    const page = await store.list({ siteId, filter: { sourceId }, cursor });

    for (const point of page.points) {
      const documentId = point.payload[PAYLOAD_KEYS.DOCUMENT_ID];
      if (typeof documentId !== 'string') continue;

      documents.set(documentId, [...(documents.get(documentId) ?? []), point.id]);
    }

    cursor = page.cursor;
  } while (cursor !== undefined);

  return documents;
}
