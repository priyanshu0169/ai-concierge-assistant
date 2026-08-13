import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { buildContext } from '../src/retrieval/build-context.js';
import { rankChunks, toSources } from '../src/retrieval/rank-chunks.js';
import { testChunk } from './helpers/domain-doubles.js';

describe('rankChunks', () => {
  it('sorts by score, because a retriever order is not guaranteed to be meaningful', () => {
    const ranked = rankChunks([
      testChunk({ id: 'a', score: 0.4, url: 'https://x/a', text: 'a' }),
      testChunk({ id: 'b', score: 0.9, url: 'https://x/b', text: 'b' }),
    ]);

    assert.deepEqual(
      ranked.map((chunk) => chunk.id),
      ['b', 'a'],
    );
  });

  it('drops exact duplicate text, which the same policy on two URLs produces', () => {
    // One fact, published twice. Showing it twice wastes the budget and inflates
    // apparent agreement.
    const ranked = rankChunks([
      testChunk({ id: 'a', url: 'https://x/a', text: 'Returns within thirty days.' }),
      testChunk({ id: 'b', url: 'https://x/b', text: 'Returns within thirty days.' }),
    ]);

    assert.equal(ranked.length, 1);
  });

  it('caps how many chunks one source may contribute', () => {
    // A long page chunks into many similar-scoring pieces. Without a cap, topK of 6 can
    // be six slices of one document, crowding out the page with the other half.
    const ranked = rankChunks([
      testChunk({ id: 'a1', url: 'https://x/long', text: '1' }),
      testChunk({ id: 'a2', url: 'https://x/long', text: '2' }),
      testChunk({ id: 'a3', url: 'https://x/long', text: '3' }),
      testChunk({ id: 'b1', url: 'https://x/other', text: '4' }),
    ]);

    assert.deepEqual(
      ranked.map((chunk) => chunk.id),
      ['a1', 'a2', 'b1'],
    );
  });

  it('honours a configured per-source cap, which measurement showed was the binding limit', () => {
    // Recorded because 2 was demonstrably too tight for breadth questions: "what are the different
    // types of caviar" retrieved six chunks from the single page that answers it and kept two,
    // discarding 67% of the evidence. The cap is a dial now, not a constant.
    const chunks = [
      testChunk({ id: 'a1', url: 'https://x/long', text: '1' }),
      testChunk({ id: 'a2', url: 'https://x/long', text: '2' }),
      testChunk({ id: 'a3', url: 'https://x/long', text: '3' }),
      testChunk({ id: 'a4', url: 'https://x/long', text: '4' }),
    ];

    assert.deepEqual(
      rankChunks(chunks, { maxPerSource: 3 }).map((chunk) => chunk.id),
      ['a1', 'a2', 'a3'],
    );
    // Omitting the option must behave exactly as before, so no existing caller changes.
    assert.equal(rankChunks(chunks).length, 2);
  });

  it('does not apply a score floor, which is the retriever job', () => {
    // The store discards below-threshold matches without shipping them back.
    const ranked = rankChunks([testChunk({ score: 0.01, text: 'weak' })]);

    assert.equal(ranked.length, 1);
  });

  it('copes with an empty result', () => {
    assert.deepEqual(rankChunks([]), []);
  });
});

describe('toSources', () => {
  it('deduplicates by URL, because two chunks from one page are one place to go', () => {
    const sources = toSources({
      chunks: [
        testChunk({ id: 'a', url: 'https://x/returns', text: '1' }),
        testChunk({ id: 'b', url: 'https://x/returns', text: '2' }),
      ],
      maxCitations: 3,
    });

    assert.equal(sources.length, 1);
  });

  it('caps at the store maxCitations, because a wall of links reads as evasion', () => {
    const sources = toSources({
      chunks: [
        testChunk({ url: 'https://x/1', text: '1' }),
        testChunk({ url: 'https://x/2', text: '2' }),
        testChunk({ url: 'https://x/3', text: '3' }),
      ],
      maxCitations: 2,
    });

    assert.equal(sources.length, 2);
  });

  it('keeps a chunk with no URL, citing it by title', () => {
    const sources = toSources({
      chunks: [testChunk({ url: undefined, title: 'Internal FAQ' })],
      maxCitations: 3,
    });

    assert.deepEqual(sources, [{ title: 'Internal FAQ' }]);
  });
});

describe('buildContext', () => {
  it('numbers and labels each excerpt, so an answer can be traced to one', () => {
    const { context } = buildContext({
      chunks: [testChunk({ headingPath: 'International' })],
      maxContextCharacters: 8000,
    });

    assert.match(context, /^\[1\] Returns policy > International/);
    assert.match(context, /Source: https:\/\/example\.com\/help\/returns/);
  });

  it('truncates at a chunk boundary, never mid-chunk', () => {
    // A half-excerpt reads as complete and may cut off the clause that makes it true.
    const long = 'x'.repeat(300);
    const { context, used } = buildContext({
      chunks: [
        testChunk({ id: 'a', url: 'https://x/a', text: long }),
        testChunk({ id: 'b', url: 'https://x/b', text: long }),
        testChunk({ id: 'c', url: 'https://x/c', text: long }),
      ],
      maxContextCharacters: 700,
    });

    assert.equal(used.length, 2);
    assert.ok(context.includes('https://x/a'));
    assert.ok(!context.includes('https://x/c'));
  });

  it('always includes the first excerpt, even if it alone exceeds the budget', () => {
    // Returning no context because the best match was long would be worse than a long
    // prompt, and the chunker already caps chunk size.
    const { used } = buildContext({
      chunks: [testChunk({ text: 'x'.repeat(5000) })],
      maxContextCharacters: 100,
    });

    assert.equal(used.length, 1);
  });

  it('reports exactly which chunks it used, so citations match the context', () => {
    const { used } = buildContext({
      chunks: [testChunk({ id: 'a', url: 'https://x/a', text: 'one' })],
      maxContextCharacters: 8000,
    });

    assert.deepEqual(
      used.map((chunk) => chunk.id),
      ['a'],
    );
  });

  it('handles no chunks', () => {
    assert.deepEqual(buildContext({ chunks: [], maxContextCharacters: 8000 }), {
      context: '',
      used: [],
    });
  });
});
