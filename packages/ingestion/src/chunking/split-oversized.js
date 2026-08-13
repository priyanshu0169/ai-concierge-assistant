/**
 * Sentence-ish boundaries: terminator, closing quote or bracket, then whitespace.
 *
 * Deliberately crude. Proper sentence segmentation needs locale rules and an
 * abbreviation list, and this is a fallback path for text that has already defeated
 * paragraph and heading boundaries - precision here buys very little.
 */
const SENTENCE_END = /(?<=[.!?][)"'”’]?)\s+/;

/**
 * Break a block that is too large for one chunk.
 *
 * Tried in descending order of how natural the seam is: sentences first, then a
 * hard character cut. The hard cut exists because some real content has none of the
 * structure above it - a minified table, a wall of unpunctuated text - and a chunker
 * that could not handle that would simply drop the page.
 *
 * @param {string} text
 * @param {number} maxCharacters
 * @returns {string[]}
 */
export function splitOversized(text, maxCharacters) {
  if (text.length <= maxCharacters) return [text];

  /** @type {string[]} */
  const pieces = [];
  let current = '';

  for (const sentence of text.split(SENTENCE_END)) {
    if (current !== '' && `${current} ${sentence}`.length > maxCharacters) {
      pieces.push(current);
      current = '';
    }

    current = current === '' ? sentence : `${current} ${sentence}`;
  }

  if (current !== '') pieces.push(current);

  return pieces.flatMap((piece) => hardSplit(piece, maxCharacters));
}

/**
 * @param {string} text
 * @param {number} maxCharacters
 * @returns {string[]}
 */
function hardSplit(text, maxCharacters) {
  if (text.length <= maxCharacters) return [text];

  /** @type {string[]} */
  const pieces = [];

  for (let start = 0; start < text.length; start += maxCharacters) {
    pieces.push(text.slice(start, start + maxCharacters));
  }

  return pieces;
}

/**
 * Take the tail of a chunk to prepend to the next one.
 *
 * Overlap protects against a boundary landing mid-answer: a question whose answer
 * straddles two chunks still has one chunk containing all of it. Cut at a sentence
 * start where possible, because an overlap beginning mid-sentence reads as noise to
 * both a model and a human reading a citation.
 *
 * @param {string} text
 * @param {number} overlapCharacters
 * @returns {string}
 */
export function tailOverlap(text, overlapCharacters) {
  if (overlapCharacters <= 0 || text.length <= overlapCharacters) return '';

  const tail = text.slice(-overlapCharacters);
  const boundary = tail.search(SENTENCE_END);

  return boundary === -1 ? tail.trimStart() : tail.slice(boundary).trimStart();
}
