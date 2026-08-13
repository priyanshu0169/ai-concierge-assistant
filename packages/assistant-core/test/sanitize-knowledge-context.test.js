import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { sanitizeKnowledgeContext } from '../src/retrieval/sanitize-knowledge-context.js';

/**
 * @param {Partial<import('../src/types.js').RetrievedChunk>} overrides
 * @returns {import('../src/types.js').RetrievedChunk}
 */
function chunk(overrides = {}) {
  return {
    id: 'doc_1#0',
    score: 0.7,
    text: 'Beluga caviar has large, delicate pearls.',
    title: 'Caviar',
    ...overrides,
  };
}

/** @param {import('../src/types.js').RetrievedChunk[]} chunks */
function textOf(chunks) {
  return sanitizeKnowledgeContext(chunks).chunks.map((entry) => entry.text);
}

describe('sanitizeKnowledgeContext', () => {
  describe('price removal', () => {
    it('masks a bare amount', () => {
      const [text] = textOf([chunk({ text: 'Caviar Butter $68' })]);

      assert.equal(text, 'Caviar Butter [price not shown]');
    });

    it('masks a listing "from" price as one phrase, leaving no dangling FROM', () => {
      // The product name is the part worth keeping - it is what answers "what do you sell".
      const [text] = textOf([chunk({ text: '- Beluga (Grade 000) FROM $280' })]);

      assert.equal(text, '- Beluga (Grade 000) [price not shown]');
    });

    it('masks thousands separators and decimals', () => {
      const [text] = textOf([chunk({ text: 'Set of twelve $1,250.00 each' })]);

      assert.equal(text, 'Set of twelve [price not shown] each');
    });

    it('masks every occurrence in a chunk, not only the first', () => {
      // A category listing carries one per product; masking only the first would leak the rest.
      const [text] = textOf([chunk({ text: 'A $10 B $20 C FROM $30' })]);

      assert.equal(text, 'A [price not shown] B [price not shown] C [price not shown]');
    });

    it('masks a sale pair, which is two prices and two chances to be wrong', () => {
      const [text] = textOf([chunk({ text: 'Essential Caviar Tasting Set $159 $247' })]);

      assert.equal(text, 'Essential Caviar Tasting Set [price not shown] [price not shown]');
    });

    it('masks a price in prose, because a buying guide figure is exactly as stale', () => {
      // Deliberate: the sentence stays in the corpus, it just does not reach the model as fact.
      const [text] = textOf([chunk({ text: 'Expect to pay around $200 per ounce for Beluga.' })]);

      assert.equal(text, 'Expect to pay around [price not shown] per ounce for Beluga.');
    });

    it('is case-insensitive about the from prefix', () => {
      assert.equal(textOf([chunk({ text: 'Osetra from $95' })])[0], 'Osetra [price not shown]');
      assert.equal(textOf([chunk({ text: 'Osetra From $95' })])[0], 'Osetra [price not shown]');
    });
  });

  describe('what it leaves alone', () => {
    it('keeps descriptive content untouched, which is the whole point of the corpus', () => {
      const text = 'Beluga caviar comes from Huso huso and has a mild, buttery flavour.';

      assert.equal(textOf([chunk({ text })])[0], text);
    });

    it('does not mangle a bare number that is not money', () => {
      // Weights, counts and grades are descriptive and must survive: "30g" answers a real question.
      const text = 'Available in 30g, 50g and 125g tins, grade 000, aged 24 months.';

      assert.equal(textOf([chunk({ text })])[0], text);
    });

    it('leaves a lone currency symbol alone', () => {
      const text = 'Prices in $ are shown on each product page.';

      assert.equal(textOf([chunk({ text })])[0], text);
    });
  });

  describe('fields covered', () => {
    it('masks the title, which a product page routinely ends with a price', () => {
      // buildContext renders the title as the excerpt label, so a price there reaches the model
      // just as surely as one in the body.
      const { chunks } = sanitizeKnowledgeContext([
        chunk({ title: 'Scottish Gravlax, Sliced (Small) $13' }),
      ]);

      assert.equal(chunks[0].title, 'Scottish Gravlax, Sliced (Small) [price not shown]');
    });

    it('masks the heading path when present', () => {
      const { chunks } = sanitizeKnowledgeContext([
        chunk({ headingPath: 'Caviar > Gift sets from $159' }),
      ]);

      assert.equal(chunks[0].headingPath, 'Caviar > Gift sets [price not shown]');
    });

    it('keeps every other field, including the url a citation needs', () => {
      const input = chunk({ url: 'https://example.test/caviar', contentType: 'page', score: 0.61 });
      const [result] = sanitizeKnowledgeContext([input]).chunks;

      assert.equal(result.url, 'https://example.test/caviar');
      assert.equal(result.contentType, 'page');
      assert.equal(result.score, 0.61);
      assert.equal(result.id, 'doc_1#0');
    });
  });

  describe('reporting and purity', () => {
    it('reports the categories it removed, never the values', () => {
      const { removed } = sanitizeKnowledgeContext([chunk({ text: 'Osetra FROM $95' })]);

      assert.deepEqual(removed, ['price']);
      assert.ok(!JSON.stringify(removed).includes('95'));
    });

    it('reports nothing when there was nothing to remove', () => {
      const { removed } = sanitizeKnowledgeContext([chunk({ text: 'Just a description.' })]);

      assert.deepEqual(removed, []);
    });

    it('reports a category once however many times it matched', () => {
      const { removed } = sanitizeKnowledgeContext([chunk({ text: '$1 $2 $3 $4' })]);

      assert.deepEqual(removed, ['price']);
    });

    it('does not mutate its input, so a caller keeping the originals still has them', () => {
      const input = chunk({ text: 'Osetra FROM $95' });

      sanitizeKnowledgeContext([input]);

      assert.equal(input.text, 'Osetra FROM $95');
    });

    it('copes with an empty context and with a non-array', () => {
      assert.deepEqual(sanitizeKnowledgeContext([]), { chunks: [], removed: [] });
      assert.deepEqual(sanitizeKnowledgeContext(/** @type {any} */ (undefined)), {
        chunks: [],
        removed: [],
      });
    });

    it('applies to every chunk in the context, not just the first', () => {
      const texts = textOf([chunk({ text: 'A $10' }), chunk({ text: 'B $20' })]);

      assert.deepEqual(texts, ['A [price not shown]', 'B [price not shown]']);
    });
  });
});
