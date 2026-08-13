/**
 * Character-level cleanup, expressed as code points rather than literals.
 *
 * Every character handled here is invisible or indistinguishable from a space, so
 * a regex containing literals would be unreviewable in a diff and the first person
 * to tidy up this file would delete something load-bearing without being able to
 * see it. Numbers are auditable; invisible characters are not.
 */

const TAB = 0x09;
const LINE_FEED = 0x0a;
const SPACE = ' ';

/**
 * Invisible characters that still change a content hash.
 *
 * The soft hyphen is the one that surprises people: CMS editors insert it as a
 * line-break hint, it renders as nothing, and it splits a word in two as far as a
 * tokenizer is concerned.
 */
const INVISIBLE = new Set([
  0x00ad, // soft hyphen
  0x200b, // zero-width space
  0x200c, // zero-width non-joiner
  0x200d, // zero-width joiner
  0xfeff, // byte-order mark
]);

/** Ranges of spaces a reader cannot tell apart from U+0020. */
const SPACE_LIKE_RANGES = [
  [0x00a0, 0x00a0], // no-break space
  [0x1680, 0x1680], // ogham space mark
  [0x2000, 0x200a], // en quad through hair space
  [0x202f, 0x202f], // narrow no-break space
  [0x205f, 0x205f], // medium mathematical space
  [0x3000, 0x3000], // ideographic space
];

/**
 * Strip invisible characters and fold exotic spaces down to a plain space.
 *
 * Tab and newline survive: they carry the only structure plain text has.
 *
 * @param {string} value
 * @returns {string}
 */
export function scrubCharacters(value) {
  /** @type {string[]} */
  const kept = [];

  for (const character of value) {
    const codePoint = character.codePointAt(0) ?? 0;

    if (INVISIBLE.has(codePoint) || isControl(codePoint)) continue;

    kept.push(isSpaceLike(codePoint) ? SPACE : character);
  }

  return kept.join('');
}

/**
 * @param {number} codePoint
 * @returns {boolean}
 */
function isControl(codePoint) {
  if (codePoint === TAB || codePoint === LINE_FEED) return false;

  return codePoint < 0x20 || codePoint === 0x7f;
}

/**
 * @param {number} codePoint
 * @returns {boolean}
 */
function isSpaceLike(codePoint) {
  return SPACE_LIKE_RANGES.some(([from, to]) => codePoint >= from && codePoint <= to);
}
