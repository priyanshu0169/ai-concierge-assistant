import { createHash } from 'node:crypto';
import { createHeadingTrail, parseBlocks } from './parse-blocks.js';
import { splitOversized, tailOverlap } from './split-oversized.js';

const HASH_PREFIX = 'sha256:';

/**
 * @typedef {object} Chunk
 * @property {string} id Stable: `documentId#index`, so a re-run upserts in place.
 * @property {number} index
 * @property {string} text What gets embedded, heading path included.
 * @property {string} body The chunk without the heading prefix, for display.
 * @property {string[]} headingPath
 * @property {string} contentHash Of `text`. Decides whether to re-embed.
 */

/**
 * Split a canonical document into chunks.
 *
 * Structure-aware: it cuts at headings first, paragraphs second, sentences third,
 * and only then at an arbitrary character. Every level down that list is a worse
 * seam, and the point of the ordering is to reach the bad ones as rarely as possible.
 *
 * The chunk is what gets embedded, so what goes *into* it is a retrieval-quality
 * decision, not a formatting one. Two choices matter:
 *
 * - **The heading trail is prepended** ("Returns policy > International"), giving an
 *   isolated chunk the context a reader gets from the page around it.
 * - **A short trailing fragment is merged backwards** rather than left standing. A
 *   40-character chunk retrieves badly on its own and dilutes the source it came from.
 *
 * @param {{
 *   document: import('@shopsage/content-model').Document,
 *   settings: import('@shopsage/platform').SiteProfile['ingestion'],
 * }} input
 * @returns {Chunk[]}
 */
export function chunkDocument(input) {
  const { document, settings } = input;
  const accumulator = createChunkAccumulator(settings);
  const trail = createHeadingTrail();

  for (const block of parseBlocks(document.text)) {
    if (block.kind === 'heading') {
      // A heading at or above the split level starts a new chunk; deeper ones are
      // allowed to share, so an <h4> subsection is not stranded on its own.
      if (block.level <= settings.splitOnHeadingLevel) accumulator.cut();
      trail.enter(block.level, block.text);
      accumulator.append(`${'#'.repeat(block.level)} ${block.text}`, trail.path());
      continue;
    }

    for (const piece of splitOversized(block.text, settings.maxChunkCharacters)) {
      accumulator.append(piece, trail.path());
    }
  }

  return accumulator.finish(document);
}

/**
 * State lives in a closure rather than an object threaded through the walk: the
 * coding standard forbids writing to a parameter's properties, and a function that
 * rewrites its caller's accumulator is hard to follow.
 *
 * @param {import('@shopsage/platform').SiteProfile['ingestion']} settings
 */
function createChunkAccumulator(settings) {
  /** @type {{ body: string, headingPath: string[] }[]} */
  const completed = [];
  /** @type {string[]} */
  let lines = [];
  /** @type {string[]} */
  let headingPath = [];
  /**
   * Whether `lines` holds nothing but the overlap tail carried from the previous chunk.
   *
   * This flag is the fix for a silent bug that cost the corpus most of its heading metadata.
   * `headingPath` was only reassigned when `lines.length === 0`, but `cut` ends by seeding `lines`
   * with the overlap tail - so with any non-zero `overlapCharacters` (the default is 200) `lines`
   * was never empty again, the assignment never ran, and **every chunk in a document inherited the
   * path captured for the first one**.
   *
   * Measured across the real corpus: 59.4% of 4,174 chunks carried no heading path at all, and the
   * ones that did were mostly product pages where the single `<h1>` happened to be correct by
   * accident. A 25-chunk category page with five `####` sections recorded an empty path for all 25.
   *
   * That matters because the path is prepended to the embedded text (`buildPrefix`), so it is
   * retrieval signal, not decoration - isolating a section without its path measured *worse* than
   * leaving it fused (0.128 vs 0.262 cosine on a company-fact question), while the same section
   * with its path scored 0.485.
   *
   * Carried overlap must not count as "the chunk has started", because the text it came from
   * belongs to the section above. The first *real* piece appended decides the path.
   */
  let carriedOnly = false;

  const currentLength = () => lines.join('\n\n').length;

  const cut = () => {
    const body = lines.join('\n\n').trim();
    if (body === '') {
      lines = [];
      carriedOnly = false;
      return;
    }

    completed.push({ body, headingPath });
    // Carry the tail forward so an answer spanning the seam survives whole in one
    // of the two chunks.
    const overlap = tailOverlap(body, settings.overlapCharacters);
    lines = overlap === '' ? [] : [overlap];
    carriedOnly = lines.length > 0;
  };

  return {
    cut,

    /**
     * @param {string} piece
     * @param {string[]} path
     */
    append(piece, path) {
      if (currentLength() + piece.length > settings.maxChunkCharacters) cut();
      // The path is captured when the chunk starts, not when it ends: a chunk belongs to the
      // section it opened in. `carriedOnly` is why a heading-driven cut still adopts the new
      // section's path - the overlap sitting in `lines` is not a start.
      if (lines.length === 0 || carriedOnly) {
        headingPath = [...path];
        carriedOnly = false;
      }
      lines.push(piece);
    },

    /**
     * @param {import('@shopsage/content-model').Document} document
     * @returns {Chunk[]}
     */
    finish(document) {
      cut();
      return mergeRunts(completed, settings).map((entry, index) =>
        toChunk({ entry, index, document, settings }),
      );
    },
  };
}

/**
 * Fold a too-short trailing chunk back into its predecessor.
 *
 * Only the trailing one: a short chunk in the middle is usually a real, distinct
 * section (a one-line FAQ answer), whereas a short chunk at the end is nearly always
 * the remainder of a split.
 *
 * @param {{ body: string, headingPath: string[] }[]} chunks
 * @param {import('@shopsage/platform').SiteProfile['ingestion']} settings
 * @returns {{ body: string, headingPath: string[] }[]}
 */
function mergeRunts(chunks, settings) {
  if (chunks.length < 2) return chunks;

  const last = chunks[chunks.length - 1];
  if (last.body.length >= settings.minChunkCharacters) return chunks;

  const previous = chunks[chunks.length - 2];
  const merged = `${previous.body}\n\n${last.body}`;

  // Refuse the merge if it would breach the ceiling; a slightly short chunk is a
  // smaller problem than one the embedding backend truncates.
  if (merged.length > settings.maxChunkCharacters) return chunks;

  return [...chunks.slice(0, -2), { body: merged, headingPath: previous.headingPath }];
}

/**
 * @param {{
 *   entry: { body: string, headingPath: string[] },
 *   index: number,
 *   document: import('@shopsage/content-model').Document,
 *   settings: import('@shopsage/platform').SiteProfile['ingestion'],
 * }} input
 * @returns {Chunk}
 */
function toChunk(input) {
  const { entry, index, document, settings } = input;
  const prefix = settings.includeHeadingPath ? buildPrefix(document, entry.headingPath) : '';
  const text = `${prefix}${entry.body}`;

  return {
    // Position-based, not content-based. An edited chunk keeps its id, so a re-run
    // overwrites in place; content-based ids would orphan the old copy on every edit.
    id: `${document.id}#${index}`,
    index,
    text,
    body: entry.body,
    headingPath: entry.headingPath,
    contentHash: `${HASH_PREFIX}${createHash('sha256').update(text, 'utf8').digest('hex')}`,
  };
}

/**
 * @param {import('@shopsage/content-model').Document} document
 * @param {string[]} headingPath
 * @returns {string}
 */
function buildPrefix(document, headingPath) {
  // The document title leads, because a chunk's own headings rarely repeat it and
  // "International" alone is not a searchable concept.
  const trail = [document.title, ...headingPath].filter(
    (part, position, all) => part !== '' && all.indexOf(part) === position,
  );

  return trail.length === 0 ? '' : `${trail.join(' > ')}\n\n`;
}
