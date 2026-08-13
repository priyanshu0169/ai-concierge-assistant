import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { mean, ndcg, reciprocalRank, round } from '../src/evaluation/metrics.js';

describe('reciprocalRank', () => {
  it('rewards a hit at rank one over one further down', () => {
    assert.equal(reciprocalRank(1), 1);
    assert.equal(reciprocalRank(2), 0.5);
    assert.equal(reciprocalRank(4), 0.25);
  });

  it('scores a total miss as zero rather than infinity', () => {
    // Rank 0 is the "not retrieved" sentinel; dividing by it would poison the mean.
    assert.equal(reciprocalRank(0), 0);
  });
});

describe('ndcg', () => {
  it('is 1 when every relevant chunk is already at the top', () => {
    assert.equal(ndcg([true, true, false, false]), 1);
  });

  it('falls when a relevant chunk is ranked below an irrelevant one', () => {
    // Same number of relevant results, worse order: the metric exists to see this difference,
    // because the context budget and the per-source cap both cut from the bottom.
    assert.ok(ndcg([false, true]) < ndcg([true, false]));
  });

  it('scores no relevant results as zero, not NaN', () => {
    assert.equal(ndcg([false, false, false]), 0);
    assert.equal(ndcg([]), 0);
  });

  it('never exceeds 1, whatever the order', () => {
    for (const relevance of [[true], [true, false, true], [false, false, true]]) {
      assert.ok(ndcg(relevance) <= 1, `exceeded 1 for ${JSON.stringify(relevance)}`);
    }
  });
});

describe('mean', () => {
  it('averages', () => {
    assert.equal(mean([1, 2, 3]), 2);
  });

  it('returns zero for an empty list, so a report never shows NaN', () => {
    assert.equal(mean([]), 0);
  });
});

describe('round', () => {
  it('keeps four places, enough to see a change worth acting on', () => {
    assert.equal(round(0.632626262), 0.6326);
    assert.equal(round(1), 1);
  });
});
