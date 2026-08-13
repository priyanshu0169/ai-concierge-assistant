import { sanitizeKnowledgeContext } from '@shopsage/assistant-core';
import { PAYLOAD_KEYS } from '@shopsage/ingestion';

/**
 * Satisfy `assistant-core`'s `KnowledgeRetriever` port with the two clients it takes to
 * actually do it.
 *
 * This adapter is where "retrieval is vector-based" lives, and it lives here rather than
 * in the domain deliberately. The domain asks for content relevant to a question; only
 * this file knows that answering means embedding the question and running a filtered
 * similarity search. Swapping to a keyword index, a hybrid retriever or a managed search
 * service replaces this file and nothing else.
 *
 * It also translates the stored payload back into the domain's `RetrievedChunk`. The
 * payload keys come from `@shopsage/ingestion`'s `PAYLOAD_KEYS` rather than string
 * literals: ingestion writes them and retrieval reads them, and a rename on one side
 * alone would produce citations with no title and filters that match nothing — silently.
 *
 * @param {{
 *   embeddings: import('@shopsage/embeddings-client').EmbeddingsClient,
 *   store: import('@shopsage/vector-repository').VectorRepository,
 *   logger?: import('@shopsage/platform').Logger,
 * }} dependencies
 * @returns {import('@shopsage/assistant-core').KnowledgeRetriever}
 */
export function createKnowledgeRetriever(dependencies) {
  const { embeddings, store, logger } = dependencies;

  return {
    async retrieve(query) {
      // TEMPORARY: retrieval debug instrumentation (sources: [] investigation).
      // Remove once the empty-sources cause is confirmed.
      logger?.debug('retrieval query debug', {
        text: query.text,
        siteId: query.siteId,
        topK: query.topK,
        minScore: query.minScore,
      });

      const vector = await embeddings.embedQuery(query.text);

      const matches = await store.search({
        vector,
        siteId: query.siteId,
        topK: query.topK,
        // Applied by the store, not here: a vector database can discard
        // below-threshold matches without shipping them back to be filtered.
        minScore: query.minScore,
      });

      logger?.debug('knowledge retrieved', {
        siteId: query.siteId,
        matches: matches.length,
        topScore: matches[0]?.score ?? 0,
      });

      // TEMPORARY: retrieval debug instrumentation (sources: [] investigation).
      // Remove once the empty-sources cause is confirmed. `matches` here already
      // reflects Qdrant's own score_threshold filtering - there is no separate
      // client-side score filter in this file.
      logger?.debug('post-score-filter matches debug', {
        siteId: query.siteId,
        count: matches.length,
        matches: matches.map((match) => ({
          id: match.id,
          score: match.score,
          documentId: match.payload.documentId,
          title: match.payload.title,
          chunkIndex: match.payload.chunkIndex,
          siteId: match.payload.siteId,
        })),
      });

      // Sanitized as a distinct step, and at this boundary rather than inside any one tool: what
      // the domain receives is already free of transactional values, so a tool added later cannot
      // reintroduce the leak by forgetting to ask. `toChunk` stays a pure payload translation.
      const { chunks, removed } = sanitizeKnowledgeContext(matches.map(toChunk));

      if (removed.length > 0) {
        // Categories, never the values. Worth recording because a rising rate is the signal that
        // the corpus is accumulating transactional content faster than the crawl policy expects.
        logger?.debug('dynamic values masked in retrieved knowledge', {
          siteId: query.siteId,
          categories: removed,
        });
      }

      return chunks;
    },
  };
}

/**
 * @param {import('@shopsage/vector-repository').VectorMatch} match
 * @returns {import('@shopsage/assistant-core').RetrievedChunk}
 */
function toChunk(match) {
  const payload = match.payload;
  const text = payload[PAYLOAD_KEYS.TEXT];
  const title = payload[PAYLOAD_KEYS.TITLE];
  const url = payload[PAYLOAD_KEYS.URL];
  const headingPath = payload[PAYLOAD_KEYS.HEADING_PATH];
  const contentType = payload[PAYLOAD_KEYS.CONTENT_TYPE];

  return {
    id: match.id,
    score: match.score,
    text: typeof text === 'string' ? text : '',
    title: typeof title === 'string' ? title : '',
    ...(typeof url === 'string' ? { url } : {}),
    ...(typeof headingPath === 'string' && headingPath !== '' ? { headingPath } : {}),
    ...(typeof contentType === 'string' ? { contentType } : {}),
  };
}
