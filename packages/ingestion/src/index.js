/**
 * @shopsage/ingestion - chunk, embed, store.
 *
 * Consumes any `ContentSource` and knows nothing about how its documents were
 * acquired: a crawler, a PDF reader and a CMS export all arrive here as the same
 * canonical `Document`. That is what makes a new source kind a new package rather
 * than a change to this pipeline (docs/adr/0016).
 *
 * The property worth protecting is **cheap re-ingestion**. Embedding is the expensive
 * step - metered on the hosted backend - and most of a corpus is unchanged between
 * runs, so the pipeline asks the store what it already holds and embeds only the
 * difference. Everything else here exists to make that safe: positional chunk ids so
 * a change overwrites in place, trailing-chunk deletion so a shortened page leaves no
 * remains, and a prune that refuses to run when a crawl looks incomplete.
 */

export { chunkDocument } from './chunking/chunk-document.js';
export { ingestDocument } from './ingest-document.js';
export { pruneRemovedDocuments } from './prune-removed-documents.js';
export { runIngestion } from './run-ingestion.js';
export { runEvaluation } from './evaluation/run-evaluation.js';
export { PAYLOAD_KEYS, toVectorPoint } from './to-vector-point.js';

/**
 * @typedef {import('./chunking/chunk-document.js').Chunk} Chunk
 * @typedef {import('./run-ingestion.js').IngestionReport} IngestionReport
 * @typedef {import('./run-ingestion.js').SourceReport} SourceReport
 * @typedef {import('./evaluation/run-evaluation.js').GoldenQuestion} GoldenQuestion
 * @typedef {import('./evaluation/run-evaluation.js').EvaluationReport} EvaluationReport
 */
