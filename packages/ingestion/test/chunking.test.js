import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { chunkDocument } from '../src/chunking/chunk-document.js';
import { createHeadingTrail, parseBlocks } from '../src/chunking/parse-blocks.js';
import { splitOversized, tailOverlap } from '../src/chunking/split-oversized.js';
import { testDocument, testProfile } from './helpers/pipeline-doubles.js';

/**
 * @param {string} text
 * @param {Record<string, unknown>} [settings]
 * @returns {import('../src/chunking/chunk-document.js').Chunk[]}
 */
function chunk(text, settings = {}) {
  return chunkDocument({
    document: testDocument({ text }),
    settings: testProfile(settings).ingestion,
  });
}

describe('parseBlocks', () => {
  it('separates headings from prose', () => {
    const blocks = parseBlocks('## Returns\n\nWithin thirty days.');

    assert.deepEqual(blocks, [
      { kind: 'heading', level: 2, text: 'Returns' },
      { kind: 'text', level: 0, text: 'Within thirty days.' },
    ]);
  });

  it('starts a new block at a blank line, the finest safe place to cut', () => {
    const blocks = parseBlocks('First para.\n\nSecond para.');

    assert.equal(blocks.length, 2);
  });

  it('keeps consecutive lines together, so a wrapped sentence stays whole', () => {
    const blocks = parseBlocks('- one\n- two\n- three');

    assert.equal(blocks.length, 1);
    assert.equal(blocks[0].text, '- one\n- two\n- three');
  });

  it('records heading depth', () => {
    assert.equal(parseBlocks('#### Deep').at(0)?.level, 4);
  });
});

describe('createHeadingTrail', () => {
  it('nests deeper headings under shallower ones', () => {
    const trail = createHeadingTrail();
    trail.enter(1, 'Help');
    trail.enter(2, 'Returns');
    trail.enter(3, 'International');

    assert.deepEqual(trail.path(), ['Help', 'Returns', 'International']);
  });

  it('replaces a sibling rather than stacking it', () => {
    const trail = createHeadingTrail();
    trail.enter(2, 'Returns');
    trail.enter(2, 'Shipping');

    assert.deepEqual(trail.path(), ['Shipping']);
  });

  it('pops back out when a shallower heading arrives', () => {
    const trail = createHeadingTrail();
    trail.enter(1, 'Help');
    trail.enter(3, 'Detail');
    trail.enter(2, 'Shipping');

    assert.deepEqual(trail.path(), ['Help', 'Shipping']);
  });
});

describe('splitOversized', () => {
  it('leaves text that already fits', () => {
    assert.deepEqual(splitOversized('short', 100), ['short']);
  });

  it('cuts at sentence boundaries', () => {
    const pieces = splitOversized('One sentence here. Two sentence here. Three here.', 25);

    assert.ok(pieces.length > 1);
    assert.ok(pieces.every((piece) => piece.length <= 25));
  });

  it('hard-splits text with no sentence structure at all', () => {
    // Real content includes minified tables and unpunctuated walls; a chunker that
    // could not handle them would drop the page entirely.
    const pieces = splitOversized('x'.repeat(250), 100);

    assert.deepEqual(
      pieces.map((piece) => piece.length),
      [100, 100, 50],
    );
  });
});

describe('tailOverlap', () => {
  it('returns nothing when overlap is disabled', () => {
    assert.equal(tailOverlap('some text', 0), '');
  });

  it('returns nothing when the text is shorter than the overlap', () => {
    assert.equal(tailOverlap('short', 100), '');
  });

  it('prefers to start at a sentence boundary', () => {
    // An overlap that begins mid-sentence reads as noise in a citation.
    const overlap = tailOverlap('First sentence here. Second sentence here.', 30);

    assert.ok(!overlap.startsWith('ence'));
  });
});

describe('chunkDocument', () => {
  it('returns one chunk for a short document', () => {
    const chunks = chunk('A short policy statement.');

    assert.equal(chunks.length, 1);
    assert.equal(chunks[0].index, 0);
  });

  it('prepends the title and heading trail, giving an isolated chunk context', () => {
    const chunks = chunk('## Returns\n\nWithin thirty days.');

    assert.match(chunks[0].text, /^Returns policy > Returns\n\n/);
  });

  it('stores the body separately from the embedded text', () => {
    // The prefix helps the embedding; showing it back to a customer would not.
    const chunks = chunk('## Returns\n\nWithin thirty days.');

    assert.ok(!chunks[0].body.includes('Returns policy >'));
    assert.match(chunks[0].body, /Within thirty days/);
  });

  it('omits the prefix when the profile turns it off', () => {
    const chunks = chunk('## Returns\n\nWithin thirty days.', { includeHeadingPath: false });

    assert.equal(chunks[0].text, chunks[0].body);
  });

  it('does not repeat the title in its own breadcrumb when a heading already matches it', () => {
    // The prefix is "Title > heading path"; deduplication applies there. The heading
    // still appears once more as the section's own "## " line in the body, which is
    // real document structure, not redundancy the prefix is responsible for.
    const chunks = chunk('## Returns policy\n\nWithin thirty days.');
    const [prefix] = chunks[0].text.split('\n\n');

    assert.equal(prefix, 'Returns policy');
  });

  describe('boundaries', () => {
    it('starts a new chunk at a heading of the configured level', () => {
      const text = '## Returns\n\nOne.\n\n## Shipping\n\nTwo.';
      const chunks = chunk(text, { splitOnHeadingLevel: 2, minChunkCharacters: 0 });

      assert.equal(chunks.length, 2);
      assert.match(chunks[0].body, /Returns/);
      assert.match(chunks[1].body, /Shipping/);
    });

    it('lets deeper headings share a chunk, so a subsection is not stranded', () => {
      const text = '## Returns\n\nOne.\n\n#### Detail\n\nTwo.';
      const chunks = chunk(text, { splitOnHeadingLevel: 3, minChunkCharacters: 0 });

      assert.equal(chunks.length, 1);
    });

    it('records the heading path a chunk opened in', () => {
      const text = '# Help\n\n## Returns\n\nWithin thirty days of delivery for a full refund.';
      const chunks = chunk(text, { splitOnHeadingLevel: 2, minChunkCharacters: 0 });

      assert.deepEqual(chunks.at(-1)?.headingPath, ['Help', 'Returns']);
    });

    it('records a fresh path for every section, not the first one for the whole document', () => {
      // The regression this pins was silent and cost the corpus most of its heading metadata:
      // `headingPath` was only assigned when the buffer was empty, but a cut seeds the buffer with
      // the overlap tail, so with any non-zero overlap the assignment never ran again and every
      // chunk inherited the first chunk's path. Measured: 59.4% of 4,174 real chunks had no path.
      //
      // Overlap must be non-zero here or the bug cannot reproduce - which is exactly why the two
      // existing path tests missed it.
      const text = [
        '## Serving',
        'Serve caviar chilled on a bed of crushed ice with a mother of pearl spoon.',
        '## Storage',
        'Keep refrigerated at all times and consume within three days of opening.',
        '## History',
        'Caviar was eaten by Persian royalty long before it reached European tables.',
      ].join('\n\n');

      const chunks = chunk(text, {
        splitOnHeadingLevel: 2,
        minChunkCharacters: 0,
        overlapCharacters: 40,
      });

      assert.deepEqual(
        chunks.map((entry) => entry.headingPath),
        [['Serving'], ['Storage'], ['History']],
      );
    });

    it('keeps the path stable across a size-driven split inside one section', () => {
      // A mid-section cut is still inside that section, so the second half must not lose it.
      const text = `## Returns\n\n${'Unopened items may be returned. '.repeat(30)}`;
      const chunks = chunk(text, {
        splitOnHeadingLevel: 2,
        maxChunkCharacters: 400,
        minChunkCharacters: 0,
        overlapCharacters: 40,
      });

      assert.ok(chunks.length > 1, 'expected the section to split');
      for (const entry of chunks) assert.deepEqual(entry.headingPath, ['Returns']);
    });

    it('splits when a section exceeds the ceiling', () => {
      const chunks = chunk('word '.repeat(400), { maxChunkCharacters: 400, overlapCharacters: 0 });

      assert.ok(chunks.length > 1);
    });
  });

  describe('overlap', () => {
    it('carries the tail of one chunk into the next', () => {
      // An answer straddling a boundary must survive whole in one of the two.
      const text = `${'First section text. '.repeat(20)}\n\n${'Second section text. '.repeat(20)}`;
      const chunks = chunk(text, { maxChunkCharacters: 420, overlapCharacters: 120 });

      assert.ok(chunks.length > 1);
      const tailOfFirst = chunks[0].body.slice(-40);
      assert.ok(chunks[1].body.includes(tailOfFirst.trim().slice(0, 20)));
    });

    it('produces no overlap when disabled', () => {
      const chunks = chunk('word '.repeat(300), {
        maxChunkCharacters: 400,
        overlapCharacters: 0,
        minChunkCharacters: 0,
      });
      const total = chunks.reduce((sum, entry) => sum + entry.body.length, 0);

      assert.ok(total <= 'word '.repeat(300).length + chunks.length);
    });
  });

  describe('short trailing chunks', () => {
    it('merges a runt back into its predecessor', () => {
      const text = `${'Substantial policy text here. '.repeat(12)}\n\nTiny.`;
      const chunks = chunk(text, {
        maxChunkCharacters: 10_000,
        minChunkCharacters: 300,
        overlapCharacters: 0,
      });

      assert.equal(chunks.length, 1);
      assert.match(chunks[0].body, /Tiny\./);
    });

    it('refuses the merge when it would breach the ceiling', () => {
      // The first block alone (395) forces a cut once the tiny second block (50)
      // would overflow the window; merging the two back together (447) would then
      // breach the 400 ceiling, so the refusal must leave them as two chunks.
      const text = `${'x'.repeat(395)}\n\n${'y'.repeat(50)}`;
      const chunks = chunk(text, {
        maxChunkCharacters: 400,
        minChunkCharacters: 300,
        overlapCharacters: 0,
      });

      assert.equal(chunks.length, 2);
    });
  });

  describe('identity', () => {
    it('gives chunks positional ids, so a re-run overwrites in place', () => {
      const chunks = chunk('## A\n\nOne.\n\n## B\n\nTwo.', {
        splitOnHeadingLevel: 2,
        minChunkCharacters: 0,
      });

      assert.deepEqual(
        chunks.map((entry) => entry.id.split('#')[1]),
        ['0', '1'],
      );
      assert.ok(chunks[0].id.startsWith('doc_'));
    });

    it('hashes the embedded text, so an edit changes the hash', () => {
      const before = chunk('Within thirty days.');
      const after = chunk('Within sixty days.');

      assert.notEqual(before[0].contentHash, after[0].contentHash);
      assert.match(before[0].contentHash, /^sha256:[0-9a-f]{64}$/);
    });

    it('produces the same hash for the same input, every run', () => {
      assert.equal(
        chunk('Within thirty days.')[0].contentHash,
        chunk('Within thirty days.')[0].contentHash,
      );
    });
  });

  it('handles a document with no headings at all', () => {
    const chunks = chunk('Just prose, no structure whatsoever, but perfectly valid content.');

    assert.equal(chunks.length, 1);
    assert.deepEqual(chunks[0].headingPath, []);
  });
});
