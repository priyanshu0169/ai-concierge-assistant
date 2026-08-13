/**
 * Payload keys ingestion owns.
 *
 * Named as a constant because retrieval (Stage 6) filters and cites against exactly
 * these, and a rename on one side alone breaks the other silently - a citation with
 * no title, or a filter that matches nothing.
 */
export const PAYLOAD_KEYS = Object.freeze({
  DOCUMENT_ID: 'documentId',
  SOURCE_ID: 'sourceId',
  CONTENT_TYPE: 'contentType',
  CONTENT_HASH: 'contentHash',
  CHUNK_INDEX: 'chunkIndex',
  TITLE: 'title',
  URL: 'url',
  HEADING_PATH: 'headingPath',
  TEXT: 'text',
  INGESTED_AT: 'ingestedAt',
});

/**
 * Assemble the point that goes into the vector store.
 *
 * The chunk's **body** is stored, not the embedded text: the heading prefix exists to
 * give the embedding context, but showing "Returns policy > International > Returns
 * policy > International we ship…" back to a customer would be nonsense. What is
 * embedded and what is displayed are different things, and this is where they part.
 *
 * `contentHash` is stored so a later run can tell whether a chunk changed without
 * re-embedding it to find out - which is the whole basis of cheap re-ingestion.
 *
 * @param {{
 *   chunk: import('./chunking/chunk-document.js').Chunk,
 *   document: import('@shopsage/content-model').Document,
 *   vector: number[],
 *   ingestedAt: string,
 * }} input
 * @returns {import('@shopsage/vector-repository').VectorPoint}
 */
export function toVectorPoint(input) {
  const { chunk, document, vector, ingestedAt } = input;

  return {
    id: chunk.id,
    vector,
    payload: {
      siteId: document.siteId,
      [PAYLOAD_KEYS.DOCUMENT_ID]: document.id,
      [PAYLOAD_KEYS.SOURCE_ID]: document.sourceId,
      [PAYLOAD_KEYS.CONTENT_TYPE]: document.contentType,
      [PAYLOAD_KEYS.CONTENT_HASH]: chunk.contentHash,
      [PAYLOAD_KEYS.CHUNK_INDEX]: chunk.index,
      [PAYLOAD_KEYS.TITLE]: document.title,
      [PAYLOAD_KEYS.HEADING_PATH]: chunk.headingPath.join(' > '),
      [PAYLOAD_KEYS.TEXT]: chunk.body,
      [PAYLOAD_KEYS.INGESTED_AT]: ingestedAt,
      ...(document.url === undefined ? {} : { [PAYLOAD_KEYS.URL]: document.url }),
    },
  };
}
