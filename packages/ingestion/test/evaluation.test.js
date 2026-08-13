import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { runEvaluation } from '../src/evaluation/run-evaluation.js';
import { PAYLOAD_KEYS } from '../src/to-vector-point.js';
import { createFakeEmbeddings, testProfile } from './helpers/pipeline-doubles.js';

/**
 * A store whose `search` is scripted rather than backed by real vectors - evaluation
 * measures the reporting logic here, not similarity math, which the vector-repository
 * suite already covers.
 *
 * @param {import('@shopsage/vector-repository').VectorMatch[]} matches
 */
function scriptedStore(matches) {
  return {
    createCollection: () => Promise.resolve(),
    collectionExists: () => Promise.resolve(true),
    health: () => Promise.resolve(),
    insert: () => Promise.resolve(),
    list: () => Promise.resolve({ points: [] }),
    delete: () => Promise.resolve(),
    count: () => Promise.resolve(0),
    search: () => Promise.resolve(matches),
  };
}

/**
 * @param {{ url?: string, text?: string, score?: number }} [overrides]
 * @returns {import('@shopsage/vector-repository').VectorMatch}
 */
function match(overrides = {}) {
  return {
    id: 'doc_x#0',
    score: overrides.score ?? 0.8,
    payload: {
      siteId: 'demo-store',
      [PAYLOAD_KEYS.URL]: overrides.url ?? 'https://example.com/help/returns',
      [PAYLOAD_KEYS.TEXT]: overrides.text ?? 'Unopened items may be returned within thirty days.',
    },
  };
}

describe('runEvaluation', () => {
  it('passes a question whose expected URL is retrieved', async () => {
    const report = await runEvaluation({
      questions: [{ question: 'How long for returns?', expectedUrls: ['/help/returns'] }],
      siteProfile: testProfile(),
      embeddings: createFakeEmbeddings(),
      store: scriptedStore([match()]),
    });

    assert.equal(report.passed, 1);
    assert.equal(report.results[0].rank, 1);
  });

  it('passes on a text match when no URL is given', async () => {
    const report = await runEvaluation({
      questions: [{ question: 'Returns?', expectedText: ['thirty days'] }],
      siteProfile: testProfile(),
      embeddings: createFakeEmbeddings(),
      store: scriptedStore([match({ url: 'https://example.com/other' })]),
    });

    assert.equal(report.passed, 1);
  });

  it('records the rank of the first expected hit', async () => {
    const report = await runEvaluation({
      questions: [{ question: 'Returns?', expectedUrls: ['/help/returns'] }],
      siteProfile: testProfile(),
      embeddings: createFakeEmbeddings(),
      store: scriptedStore([
        match({ url: 'https://example.com/shipping', text: 'unrelated' }),
        match({ url: 'https://example.com/help/returns' }),
      ]),
    });

    assert.equal(report.results[0].rank, 2);
  });

  it('fails a question whose expected content never appears', async () => {
    const report = await runEvaluation({
      questions: [{ question: 'Returns?', expectedUrls: ['/help/returns'] }],
      siteProfile: testProfile(),
      embeddings: createFakeEmbeddings(),
      store: scriptedStore([match({ url: 'https://example.com/shipping', text: 'unrelated' })]),
    });

    assert.equal(report.passed, 0);
    assert.equal(report.results[0].rank, 0);
  });

  describe('unanswerable questions', () => {
    it('passes when nothing is retrieved', async () => {
      const report = await runEvaluation({
        questions: [{ question: 'Who runs the company?', unanswerable: true }],
        siteProfile: testProfile(),
        embeddings: createFakeEmbeddings(),
        store: scriptedStore([]),
      });

      assert.equal(report.passed, 1);
      assert.equal(report.refusalAccuracy, 1);
    });

    it('fails when something is retrieved above the floor', async () => {
      // The dangerous case: a confident wrong answer about something the corpus
      // cannot actually address.
      const report = await runEvaluation({
        questions: [{ question: 'Who runs the company?', unanswerable: true }],
        siteProfile: testProfile(),
        embeddings: createFakeEmbeddings(),
        store: scriptedStore([match()]),
      });

      assert.equal(report.passed, 0);
      assert.equal(report.refusalAccuracy, 0);
    });
  });

  describe('summary metrics', () => {
    it('computes recall over answerable questions only', async () => {
      const report = await runEvaluation({
        questions: [
          { question: 'a', expectedUrls: ['/help/returns'] },
          { question: 'b', expectedUrls: ['/nowhere'] },
          { question: 'c', unanswerable: true },
        ],
        siteProfile: testProfile(),
        embeddings: createFakeEmbeddings(),
        store: scriptedStore([match()]),
      });

      // One of two answerable questions hit; the unanswerable one is excluded from
      // recall and scored separately.
      assert.equal(report.recallAtK, 0.5);
      assert.equal(report.refusalAccuracy, 0);
    });

    it('defaults refusal accuracy to 1 when there are no unanswerable questions', () => {
      return runEvaluation({
        questions: [{ question: 'a', expectedUrls: ['/help/returns'] }],
        siteProfile: testProfile(),
        embeddings: createFakeEmbeddings(),
        store: scriptedStore([match()]),
      }).then((report) => assert.equal(report.refusalAccuracy, 1));
    });
  });

  it('passes topK and minScore from the site profile through to search', async () => {
    /** @type {any} */
    let seenQuery;
    const store = /** @type {any} */ (scriptedStore([]));
    store.search = (/** @type {any} */ query) => {
      seenQuery = query;
      return Promise.resolve([]);
    };

    await runEvaluation({
      questions: [{ question: 'x', unanswerable: true }],
      siteProfile: testProfile(),
      embeddings: createFakeEmbeddings(),
      store,
    });

    assert.equal(seenQuery.topK, 6);
    assert.equal(seenQuery.minScore, 0.35);
  });
});
