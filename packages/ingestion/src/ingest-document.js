import { chunkDocument } from './chunking/chunk-document.js';
import { PAYLOAD_KEYS, toVectorPoint } from './to-vector-point.js';

/**
 * @typedef {object} DocumentOutcome
 * @property {number} chunksTotal
 * @property {number} chunksEmbedded Chunks that changed and were re-embedded.
 * @property {number} chunksSkipped Unchanged, so not embedded.
 * @property {number} chunksDeleted Trailing chunks left over from a longer version.
 */

/**
 * Chunk one document, embed only what changed, and store it.
 *
 * The skip path is the point of this function. Embedding is the expensive step -
 * metered on a hosted backend, slow on a self-hosted one - and most of a corpus is
 * unchanged between runs. So the sequence is: chunk, ask the store what it already
 * holds for this document, compare hashes, and embed only the difference.
 *
 * Two details that make it correct rather than merely fast:
 *
 * - **Chunk ids are positional** (`documentId#0`, `#1`, …), so a changed chunk
 *   overwrites its predecessor instead of accumulating beside it.
 * - **Trailing chunks are deleted** when a page gets shorter. Without that, the tail
 *   of the old version stays in the index and keeps answering questions - stale
 *   content that nothing else would ever notice.
 *
 * @param {{
 *   document: import('@shopsage/content-model').Document,
 *   settings: import('@shopsage/platform').SiteProfile['ingestion'],
 *   embeddings: import('@shopsage/embeddings-client').EmbeddingsClient,
 *   store: import('@shopsage/vector-repository').VectorRepository,
 *   logger?: import('@shopsage/platform').Logger,
 *   force?: boolean,
 * }} input
 * @returns {Promise<DocumentOutcome>}
 */
export async function ingestDocument(input) {
  const { document, settings, embeddings, store, logger, force = false } = input;

  const chunks = chunkDocument({ document, settings });
  const stored = await loadStoredHashes({ store, document });

  const changed = force
    ? chunks
    : chunks.filter((chunk) => stored.get(chunk.id) !== chunk.contentHash);

  if (changed.length > 0) {
    const vectors = await embeddings.embedDocuments(changed.map((chunk) => chunk.text));
    const ingestedAt = new Date().toISOString();

    await store.insert(
      changed.map((chunk, position) =>
        toVectorPoint({ chunk, document, vector: vectors[position], ingestedAt }),
      ),
    );
  }

  const orphans = [...stored.keys()].filter((id) => !chunks.some((chunk) => chunk.id === id));
  if (orphans.length > 0) await store.delete({ ids: orphans });

  logger?.debug('document ingested', {
    documentId: document.id,
    url: document.url,
    chunks: chunks.length,
    embedded: changed.length,
    deleted: orphans.length,
  });

  return {
    chunksTotal: chunks.length,
    chunksEmbedded: changed.length,
    chunksSkipped: chunks.length - changed.length,
    chunksDeleted: orphans.length,
  };
}

/**
 * What the store already holds for this document, as id → content hash.
 *
 * A document produces tens of chunks at most, so one page is almost always enough;
 * the loop is there for the pathological case rather than the normal one.
 *
 * @param {{
 *   store: import('@shopsage/vector-repository').VectorRepository,
 *   document: import('@shopsage/content-model').Document,
 * }} input
 * @returns {Promise<Map<string, string>>}
 */
async function loadStoredHashes(input) {
  const { store, document } = input;
  /** @type {Map<string, string>} */
  const hashes = new Map();

  /** @type {string | undefined} */
  let cursor;

  do {
    const page = await store.list({
      siteId: document.siteId,
      filter: { documentId: document.id },
      cursor,
    });

    for (const point of page.points) {
      const hash = point.payload[PAYLOAD_KEYS.CONTENT_HASH];
      hashes.set(point.id, typeof hash === 'string' ? hash : '');
    }

    cursor = page.cursor;
  } while (cursor !== undefined);

  return hashes;
}
