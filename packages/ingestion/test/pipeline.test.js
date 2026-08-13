import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ingestDocument } from '../src/ingest-document.js';
import { pruneRemovedDocuments } from '../src/prune-removed-documents.js';
import { runIngestion } from '../src/run-ingestion.js';
import { PAYLOAD_KEYS } from '../src/to-vector-point.js';
import {
  createFakeEmbeddings,
  createFakeSource,
  createFakeStore,
  testDocument,
  testProfile,
} from './helpers/pipeline-doubles.js';

const LONG_TEXT = 'Unopened items may be returned within thirty days of delivery for a refund. ';

/**
 * @param {Record<string, unknown>} [overrides]
 */
function pipeline(overrides = {}) {
  const store = createFakeStore();
  const embeddings = createFakeEmbeddings();
  const siteProfile = testProfile(overrides);

  return { store, embeddings, siteProfile };
}

describe('ingestDocument', () => {
  it('embeds and stores every chunk on a first run', async () => {
    const { store, embeddings, siteProfile } = pipeline();
    const document = testDocument();

    const outcome = await ingestDocument({
      document,
      settings: siteProfile.ingestion,
      embeddings,
      store,
    });

    assert.equal(outcome.chunksTotal, 1);
    assert.equal(outcome.chunksEmbedded, 1);
    assert.equal(store.points.size, 1);
  });

  it('embeds nothing on an unchanged re-run', async () => {
    // The property the whole pipeline is built around. Embedding is the expensive
    // step, and most of a corpus is unchanged between runs.
    const { store, embeddings, siteProfile } = pipeline();
    const document = testDocument();
    const run = () =>
      ingestDocument({ document, settings: siteProfile.ingestion, embeddings, store });

    await run();
    const second = await run();

    assert.equal(second.chunksEmbedded, 0);
    assert.equal(second.chunksSkipped, 1);
    assert.equal(embeddings.calls(), 1, 'the second run must not call the embeddings backend');
  });

  it('re-embeds only what changed', async () => {
    const { store, embeddings, siteProfile } = pipeline({
      splitOnHeadingLevel: 2,
      minChunkCharacters: 0,
    });
    const settings = siteProfile.ingestion;

    const before = testDocument({ text: `## A\n\n${LONG_TEXT}\n\n## B\n\n${LONG_TEXT}` });
    await ingestDocument({ document: before, settings, embeddings, store });
    const firstBatch = embeddings.embedded.length;

    // Same reference, so the same document id - only the second section differs.
    const after = testDocument({
      text: `## A\n\n${LONG_TEXT}\n\n## B\n\nSomething else entirely.`,
    });
    const outcome = await ingestDocument({ document: after, settings, embeddings, store });

    assert.equal(outcome.chunksEmbedded, 1);
    assert.equal(outcome.chunksSkipped, firstBatch - 1);
  });

  it('re-embeds everything when forced', async () => {
    // For the case hashes cannot see: chunking settings changed, or the model did.
    const { store, embeddings, siteProfile } = pipeline();
    const document = testDocument();
    const settings = siteProfile.ingestion;

    await ingestDocument({ document, settings, embeddings, store });
    const forced = await ingestDocument({ document, settings, embeddings, store, force: true });

    assert.equal(forced.chunksEmbedded, 1);
    assert.equal(embeddings.calls(), 2);
  });

  it('deletes trailing chunks when a page gets shorter', async () => {
    // Without this the tail of the old version stays in the index and keeps
    // answering questions - stale content nothing else would notice.
    const { store, embeddings, siteProfile } = pipeline({
      splitOnHeadingLevel: 2,
      minChunkCharacters: 0,
    });
    const settings = siteProfile.ingestion;

    const long = testDocument({
      text: `## A\n\n${LONG_TEXT}\n\n## B\n\n${LONG_TEXT}\n\n## C\n\n${LONG_TEXT}`,
    });
    await ingestDocument({ document: long, settings, embeddings, store });
    const before = store.points.size;

    const short = testDocument({ text: `## A\n\n${LONG_TEXT}` });
    const outcome = await ingestDocument({ document: short, settings, embeddings, store });

    assert.ok(before > 1);
    assert.equal(store.points.size, 1);
    assert.equal(outcome.chunksDeleted, before - 1);
  });

  it('stores the payload retrieval and citations depend on', async () => {
    const { store, embeddings, siteProfile } = pipeline();
    const document = testDocument();

    await ingestDocument({ document, settings: siteProfile.ingestion, embeddings, store });
    const [point] = [...store.points.values()];

    assert.equal(point.payload.siteId, 'demo-store');
    assert.equal(point.payload[PAYLOAD_KEYS.DOCUMENT_ID], document.id);
    assert.equal(point.payload[PAYLOAD_KEYS.SOURCE_ID], 'help-centre');
    assert.equal(point.payload[PAYLOAD_KEYS.CONTENT_TYPE], 'policy');
    assert.equal(point.payload[PAYLOAD_KEYS.URL], 'https://example.com/help/returns');
    assert.equal(point.payload[PAYLOAD_KEYS.TITLE], 'Returns policy');
    assert.equal(typeof point.payload[PAYLOAD_KEYS.CONTENT_HASH], 'string');
    assert.match(String(point.payload[PAYLOAD_KEYS.TEXT]), /Unopened items/);
  });

  it('reads existing state across pages', async () => {
    const { store, embeddings, siteProfile } = pipeline({
      splitOnHeadingLevel: 2,
      minChunkCharacters: 0,
    });
    const settings = siteProfile.ingestion;
    const document = testDocument({
      text: `## A\n\n${LONG_TEXT}\n\n## B\n\n${LONG_TEXT}\n\n## C\n\n${LONG_TEXT}`,
    });

    await ingestDocument({ document, settings, embeddings, store });
    store.pageSize(1);

    const second = await ingestDocument({ document, settings, embeddings, store });

    assert.equal(second.chunksEmbedded, 0, 'pagination must not hide stored chunks');
  });
});

describe('pruneRemovedDocuments', () => {
  /**
   * @param {string[]} documentIds
   */
  async function storeWith(documentIds) {
    const store = createFakeStore();
    await store.insert(
      documentIds.map((documentId, index) => ({
        id: `${documentId}#0`,
        vector: [index, index, index, index],
        payload: {
          siteId: 'demo-store',
          [PAYLOAD_KEYS.DOCUMENT_ID]: documentId,
          [PAYLOAD_KEYS.SOURCE_ID]: 'help-centre',
        },
      })),
    );

    return store;
  }

  it('removes chunks for documents the source no longer produces', async () => {
    const store = await storeWith(['doc_a', 'doc_b', 'doc_c', 'doc_d']);

    const outcome = await pruneRemovedDocuments({
      store,
      siteId: 'demo-store',
      sourceId: 'help-centre',
      seenDocumentIds: new Set(['doc_a', 'doc_b', 'doc_c']),
      failures: 0,
    });

    assert.equal(outcome.pruned, true);
    assert.equal(outcome.documentsRemoved, 1);
    assert.equal(store.points.has('doc_d#0'), false);
    assert.equal(store.points.size, 3);
  });

  it('refuses to prune when the run had failures', async () => {
    // An unreachable page is not a deleted page.
    const store = await storeWith(['doc_a', 'doc_b']);

    const outcome = await pruneRemovedDocuments({
      store,
      siteId: 'demo-store',
      sourceId: 'help-centre',
      seenDocumentIds: new Set(['doc_a']),
      failures: 1,
    });

    assert.equal(outcome.pruned, false);
    assert.match(String(outcome.skippedReason), /failures/);
    assert.equal(store.points.size, 2);
  });

  it('refuses to prune when the run covered too little to be trusted', async () => {
    // The catastrophic case: a crawl that died after two of ten pages would
    // otherwise delete the other eight.
    const store = await storeWith(['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j']);

    const outcome = await pruneRemovedDocuments({
      store,
      siteId: 'demo-store',
      sourceId: 'help-centre',
      seenDocumentIds: new Set(['a', 'b']),
      failures: 0,
    });

    assert.equal(outcome.pruned, false);
    assert.match(String(outcome.skippedReason), /too little/);
    assert.equal(store.points.size, 10);
  });

  it('prunes when coverage is adequate', async () => {
    const store = await storeWith(['a', 'b', 'c', 'd']);

    const outcome = await pruneRemovedDocuments({
      store,
      siteId: 'demo-store',
      sourceId: 'help-centre',
      seenDocumentIds: new Set(['a', 'b', 'c']),
      failures: 0,
    });

    assert.equal(outcome.pruned, true);
    assert.equal(outcome.documentsRemoved, 1);
  });

  it('copes with an empty store', async () => {
    const outcome = await pruneRemovedDocuments({
      store: createFakeStore(),
      siteId: 'demo-store',
      sourceId: 'help-centre',
      seenDocumentIds: new Set(),
      failures: 0,
    });

    assert.equal(outcome.pruned, true);
    assert.equal(outcome.documentsRemoved, 0);
  });
});

describe('runIngestion', () => {
  it('creates the collection, so a fresh deployment needs no provisioning step', async () => {
    const { store, embeddings, siteProfile } = pipeline();
    let created = false;

    await runIngestion({
      sources: [createFakeSource([])],
      siteProfile,
      embeddings,
      store: {
        ...store,
        createCollection: () => {
          created = true;
          return Promise.resolve();
        },
      },
    });

    assert.equal(created, true);
  });

  it('reports per source', async () => {
    const { store, embeddings, siteProfile } = pipeline();

    const report = await runIngestion({
      sources: [createFakeSource([testDocument()])],
      siteProfile,
      embeddings,
      store,
    });

    assert.equal(report.sources.length, 1);
    assert.equal(report.sources[0].documents, 1);
    assert.equal(report.sources[0].chunksEmbedded, 1);
    assert.equal(report.sources[0].failures, 0);
    assert.equal(typeof report.durationMs, 'number');
  });

  it('counts a failing document and carries on', async () => {
    const { store, siteProfile } = pipeline();
    const failing = {
      embedDocuments: () => Promise.reject(new Error('backend exploded')),
      embedQuery: () => Promise.resolve([0, 0, 0, 0]),
      health: () => Promise.resolve({ model: 'fake', maxInputTokens: 0 }),
    };

    const report = await runIngestion({
      sources: [
        createFakeSource([testDocument(), testDocument({ reference: 'https://example.com/b' })]),
      ],
      siteProfile,
      embeddings: failing,
      store,
    });

    assert.equal(report.sources[0].failures, 2);
    assert.equal(report.sources[0].documents, 0);
  });

  it('does not prune after a failure, whoever reported it', async () => {
    const { store, embeddings, siteProfile } = pipeline();

    const report = await runIngestion({
      sources: [createFakeSource([testDocument()], { failed: 3 })],
      siteProfile,
      embeddings,
      store,
    });

    assert.equal(report.sources[0].failures, 3);
    assert.equal(report.sources[0].prune.pruned, false);
  });

  it('honours a caller that disables pruning', async () => {
    const { store, embeddings, siteProfile } = pipeline();

    const report = await runIngestion({
      sources: [createFakeSource([testDocument()])],
      siteProfile,
      embeddings,
      store,
      prune: false,
    });

    assert.equal(report.sources[0].prune.pruned, false);
    assert.match(String(report.sources[0].prune.skippedReason), /disabled/);
  });
});
