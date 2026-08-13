import { AppError } from '@shopsage/platform';
import { ingestDocument } from './ingest-document.js';
import { pruneRemovedDocuments } from './prune-removed-documents.js';

/**
 * @typedef {object} SourceReport
 * @property {string} sourceId
 * @property {number} documents
 * @property {number} chunksTotal
 * @property {number} chunksEmbedded
 * @property {number} chunksSkipped
 * @property {number} chunksDeleted
 * @property {number} failures
 * @property {import('./prune-removed-documents.js').PruneOutcome} prune
 */

/**
 * @typedef {object} IngestionReport
 * @property {SourceReport[]} sources
 * @property {number} durationMs
 */

/**
 * Run every configured source through chunk, embed and store.
 *
 * Streams. Documents are handled as the source yields them rather than collected
 * first, so memory is one document rather than one corpus, progress is observable,
 * and a run that dies on page 400 has already stored 399 pages of work.
 *
 * A document that fails is **counted and logged, not thrown**. One malformed page
 * must not abandon a run - but the count matters beyond reporting: any failure
 * disables pruning for that source, because an unseen document might merely be one
 * that could not be fetched.
 *
 * @param {{
 *   sources: import('@shopsage/content-model').ContentSource[],
 *   siteProfile: import('@shopsage/platform').SiteProfile,
 *   embeddings: import('@shopsage/embeddings-client').EmbeddingsClient,
 *   store: import('@shopsage/vector-repository').VectorRepository,
 *   logger?: import('@shopsage/platform').Logger,
 *   force?: boolean,
 *   prune?: boolean,
 *   signal?: AbortSignal,
 * }} input
 * @returns {Promise<IngestionReport>}
 */
export async function runIngestion(input) {
  const { sources, store, logger } = input;
  const startedAt = performance.now();

  // Idempotent, and cheap when it already exists. Doing it here means a fresh
  // deployment needs no separate provisioning step before its first ingestion.
  await store.createCollection();

  /** @type {SourceReport[]} */
  const reports = [];

  for (const source of sources) reports.push(await ingestSource({ ...input, source }));

  const report = { sources: reports, durationMs: Math.round(performance.now() - startedAt) };
  logger?.info('ingestion finished', summarize(report));

  return report;
}

/**
 * @param {{
 *   source: import('@shopsage/content-model').ContentSource,
 *   siteProfile: import('@shopsage/platform').SiteProfile,
 *   embeddings: import('@shopsage/embeddings-client').EmbeddingsClient,
 *   store: import('@shopsage/vector-repository').VectorRepository,
 *   logger?: import('@shopsage/platform').Logger,
 *   force?: boolean,
 *   prune?: boolean,
 *   signal?: AbortSignal,
 * }} input
 * @returns {Promise<SourceReport>}
 */
async function ingestSource(input) {
  const { source, siteProfile, logger, prune = true } = input;
  const sourceLogger = logger?.child({ sourceId: source.id });

  sourceLogger?.info('source started', { sourceType: source.type });

  const tally = createTally();
  await drainSource({ ...input, sourceLogger, tally });

  // The source's own failures count too: a page it could not fetch is a document we
  // did not see, and pruning on that basis would delete live content.
  const failures = tally.failures() + source.stats().failed;

  const pruneOutcome = prune
    ? await pruneRemovedDocuments({
        store: input.store,
        siteId: siteProfile.identity.siteId,
        sourceId: source.id,
        seenDocumentIds: tally.seen(),
        failures,
        logger: sourceLogger,
      })
    : { pruned: false, documentsRemoved: 0, chunksRemoved: 0, skippedReason: 'disabled by caller' };

  const report = { sourceId: source.id, ...tally.totals(), failures, prune: pruneOutcome };
  sourceLogger?.info('source finished', report);

  return report;
}

/**
 * Consume the source, ingesting each document as it arrives.
 *
 * @param {Record<string, any>} input
 * @returns {Promise<void>}
 */
async function drainSource(input) {
  const { source, siteProfile, embeddings, store, sourceLogger, force, signal, tally } = input;

  for await (const document of source.fetch({ signal })) {
    signal?.throwIfAborted();
    tally.saw(document.id);

    try {
      tally.add(
        await ingestDocument({
          document,
          settings: siteProfile.ingestion,
          embeddings,
          store,
          logger: sourceLogger,
          force,
        }),
      );
    } catch (error) {
      if (signal?.aborted === true) throw error;

      // One malformed page must not abandon a run - but the count is not merely
      // cosmetic: any failure disables pruning for this source.
      tally.failed();
      sourceLogger?.error('document failed', {
        documentId: document.id,
        url: document.url,
        err: AppError.is(error) ? error : new Error(String(error)),
      });
    }
  }
}

/**
 * Counters in a closure, so nothing writes to a parameter's properties.
 */
function createTally() {
  const totals = {
    documents: 0,
    chunksTotal: 0,
    chunksEmbedded: 0,
    chunksSkipped: 0,
    chunksDeleted: 0,
  };
  /** @type {Set<string>} */
  const seenDocumentIds = new Set();
  let failureCount = 0;

  return {
    /** @param {string} documentId */
    saw: (documentId) => seenDocumentIds.add(documentId),
    failed: () => {
      failureCount += 1;
    },

    /** @param {import('./ingest-document.js').DocumentOutcome} outcome */
    add(outcome) {
      totals.documents += 1;
      totals.chunksTotal += outcome.chunksTotal;
      totals.chunksEmbedded += outcome.chunksEmbedded;
      totals.chunksSkipped += outcome.chunksSkipped;
      totals.chunksDeleted += outcome.chunksDeleted;
    },

    totals: () => ({ ...totals }),
    seen: () => seenDocumentIds,
    failures: () => failureCount,
  };
}

/**
 * @param {IngestionReport} report
 * @returns {Record<string, unknown>}
 */
function summarize(report) {
  const sum = (/** @type {(entry: SourceReport) => number} */ pick) =>
    report.sources.reduce((total, entry) => total + pick(entry), 0);

  return {
    sources: report.sources.length,
    documents: sum((entry) => entry.documents),
    chunksEmbedded: sum((entry) => entry.chunksEmbedded),
    chunksSkipped: sum((entry) => entry.chunksSkipped),
    chunksDeleted: sum((entry) => entry.chunksDeleted + entry.prune.chunksRemoved),
    failures: sum((entry) => entry.failures),
    durationMs: report.durationMs,
  };
}
