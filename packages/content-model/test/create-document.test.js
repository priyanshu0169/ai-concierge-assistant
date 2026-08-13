import assert from 'node:assert/strict';
import { ValidationError } from '@shopsage/platform';
import { describe, it } from 'node:test';
import { CONTENT_TYPES } from '../src/content-types.js';
import { createDocument } from '../src/create-document.js';
import { normalizeText } from '../src/normalize-text.js';
import { scrubCharacters } from '../src/scrub-characters.js';

/**
 * @param {Partial<import('../src/types.js').DocumentDraft>} [overrides]
 * @returns {import('../src/types.js').Document}
 */
function build(overrides = {}) {
  return createDocument({
    siteId: 'demo-store',
    sourceId: 'help-centre',
    sourceType: 'website',
    reference: 'https://demo.example.com/help/returns',
    title: 'Returns policy',
    text: 'Unopened items may be returned within 30 days of delivery for a full refund.',
    ...overrides,
  });
}

describe('createDocument', () => {
  it('produces the canonical shape', () => {
    const document = build({ retrievedAt: '2026-07-31T00:00:00.000Z' });

    assert.deepEqual(Object.keys(document).sort(), [
      'contentHash',
      'contentType',
      'id',
      'metadata',
      'reference',
      'retrievedAt',
      'siteId',
      'sourceId',
      'sourceType',
      'text',
      'title',
    ]);
  });

  it('freezes the document, so a pipeline stage cannot rewrite what it received', () => {
    const document = build();

    assert.equal(Object.isFrozen(document), true);
    assert.equal(Object.isFrozen(document.metadata), true);
  });

  it('defaults contentType to page rather than guessing', () => {
    assert.equal(build().contentType, CONTENT_TYPES.PAGE);
  });

  it('ignores an unrecognised contentType instead of failing on it', () => {
    // A source drifting from the closed set should degrade, not stop an ingestion run.
    assert.equal(build({ contentType: /** @type {any} */ ('sale') }).contentType, 'page');
  });

  describe('identity', () => {
    it('derives the same id for the same content, every run', () => {
      // This is what makes re-ingestion an upsert instead of a duplication.
      assert.equal(build().id, build().id);
    });

    it('separates two sources that use the same reference', () => {
      assert.notEqual(build().id, build({ sourceId: 'other-source' }).id);
    });

    it('separates two stores ingesting the same content', () => {
      assert.notEqual(build().id, build({ siteId: 'other-store' }).id);
    });

    it('cannot be confused by a shifted separator', () => {
      // ('ab','c') and ('a','bc') must not collide into one id.
      const left = build({ siteId: 'ab', sourceId: 'c' });
      const right = build({ siteId: 'a', sourceId: 'bc' });

      assert.notEqual(left.id, right.id);
    });

    it('is prefixed, so it is recognisable in a log line', () => {
      assert.match(build().id, /^doc_[0-9a-f]{32}$/);
    });
  });

  describe('content hash', () => {
    it('changes when the text changes', () => {
      assert.notEqual(build().contentHash, build({ text: 'Something else entirely.' }).contentHash);
    });

    it('changes when the title changes, because citations show it', () => {
      assert.notEqual(build().contentHash, build({ title: 'Refunds' }).contentHash);
    });

    it('does not change when only the retrieval time changes', () => {
      // Otherwise every crawl would re-embed an unchanged corpus, and embedding is
      // the expensive step.
      const first = build({ retrievedAt: '2026-01-01T00:00:00.000Z' });
      const second = build({ retrievedAt: '2026-07-31T00:00:00.000Z' });

      assert.equal(first.contentHash, second.contentHash);
    });

    it('does not change for cosmetically different whitespace', () => {
      const spaced = build({
        text: 'Unopened items may be returned   within 30 days\tof delivery.',
      });
      const plain = build({ text: 'Unopened items may be returned within 30 days of delivery.' });

      assert.equal(spaced.contentHash, plain.contentHash);
    });

    it('does not change when a CDN swaps in a non-breaking space', () => {
      const nbsp = build({ text: `Returned within${String.fromCodePoint(0x00a0)}30 days.` });
      const plain = build({ text: 'Returned within 30 days.' });

      assert.equal(nbsp.contentHash, plain.contentHash);
    });

    it('is prefixed with its algorithm', () => {
      assert.match(build().contentHash, /^sha256:[0-9a-f]{64}$/);
    });
  });

  describe('metadata', () => {
    it('keeps scalars', () => {
      const document = build({
        metadata: { description: 'A policy', wordCount: 12, indexable: true },
      });

      assert.deepEqual(document.metadata, {
        description: 'A policy',
        wordCount: 12,
        indexable: true,
      });
    });

    it('drops values a vector store payload cannot filter on', () => {
      // Dropping rather than throwing: metadata is supplementary, and an odd field is
      // not worth failing an otherwise good document over.
      const document = build({
        metadata: /** @type {any} */ ({
          keep: 'yes',
          nested: { a: 1 },
          list: [1, 2],
          nothing: null,
          notFinite: Number.NaN,
        }),
      });

      assert.deepEqual(document.metadata, { keep: 'yes' });
    });

    it('defaults to an empty object, never undefined', () => {
      assert.deepEqual(build().metadata, {});
    });
  });

  describe('rejection', () => {
    it('refuses a document with no text', () => {
      assert.throws(() => build({ text: '   \n  ' }), ValidationError);
    });

    it('refuses a document with no siteId', () => {
      assert.throws(() => build({ siteId: '' }), ValidationError);
    });

    it('refuses a document with no reference', () => {
      assert.throws(() => build({ reference: '' }), ValidationError);
    });

    it('falls back to the reference for a missing title, rather than refusing', () => {
      // An untitled document is still useful; an unlabelled citation is not.
      const document = build({ title: '' });

      assert.equal(document.title, 'https://demo.example.com/help/returns');
    });
  });
});

describe('normalizeText', () => {
  it('preserves paragraph structure, the coarsest signal a chunker has', () => {
    assert.equal(normalizeText('First para.\n\n\n\nSecond para.'), 'First para.\n\nSecond para.');
  });

  it('preserves heading markers', () => {
    assert.equal(normalizeText('## Returns\n\nWithin 30 days.'), '## Returns\n\nWithin 30 days.');
  });

  it('collapses runs of spaces and tabs', () => {
    assert.equal(normalizeText('a   \t b'), 'a b');
  });

  it('normalises CRLF', () => {
    assert.equal(normalizeText('a\r\nb'), 'a\nb');
  });

  it('trims trailing space before a newline', () => {
    assert.equal(normalizeText('a   \n   b'), 'a\nb');
  });

  it('composes unicode, so accented text hashes consistently', () => {
    const decomposed = `cafe${String.fromCodePoint(0x0301)}`;
    const composed = String.fromCodePoint(0x63, 0x61, 0x66, 0xe9);

    assert.equal(normalizeText(decomposed), normalizeText(composed));
  });

  it('copes with a non-string', () => {
    assert.equal(normalizeText(/** @type {any} */ (undefined)), '');
  });
});

describe('scrubCharacters', () => {
  it('removes a soft hyphen, which splits a word for a tokenizer', () => {
    const withSoftHyphen = `re${String.fromCodePoint(0x00ad)}turns`;

    assert.equal(scrubCharacters(withSoftHyphen), 'returns');
  });

  it('removes zero-width characters and the byte-order mark', () => {
    const noisy = [0xfeff, 0x61, 0x200b, 0x62, 0x200d, 0x63]
      .map((codePoint) => String.fromCodePoint(codePoint))
      .join('');

    assert.equal(scrubCharacters(noisy), 'abc');
  });

  it('folds exotic spaces to a plain space', () => {
    const exotic = [0x00a0, 0x2003, 0x3000, 0x202f]
      .map((codePoint) => String.fromCodePoint(codePoint))
      .join('');

    assert.equal(scrubCharacters(`a${exotic}b`), 'a    b');
  });

  it('keeps tab and newline, which carry the only structure text has', () => {
    assert.equal(scrubCharacters('a\tb\nc'), 'a\tb\nc');
  });

  it('removes other control characters', () => {
    const withControls = `a${String.fromCodePoint(0x00)}b${String.fromCodePoint(0x7f)}c`;

    assert.equal(scrubCharacters(withControls), 'abc');
  });

  it('leaves ordinary text untouched', () => {
    assert.equal(scrubCharacters('Returns within 30 days.'), 'Returns within 30 days.');
  });
});
