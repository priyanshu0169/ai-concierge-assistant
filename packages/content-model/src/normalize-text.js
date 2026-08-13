import { scrubCharacters } from './scrub-characters.js';

/**
 * Reduce text to a stable canonical form.
 *
 * Every step exists to stop *cosmetically* different text from looking different
 * to a content hash. Without it, an unchanged page whose CDN swapped a plain space
 * for a non-breaking one would re-embed on every ingestion run - and embedding is
 * the expensive step, so idempotency is worth more here than it appears.
 *
 * Unicode is normalized to NFC first, so composed and decomposed forms of the same
 * accented character hash identically. Retrieval over multilingual content makes
 * that a real case rather than a theoretical one.
 *
 * Blank-line structure is deliberately **preserved**, collapsed to at most one
 * blank line. Paragraph boundaries are the coarsest structural signal a chunker
 * has, and flattening them would throw it away.
 *
 * @param {string} value
 * @returns {string}
 */
export function normalizeText(value) {
  if (typeof value !== 'string') return '';

  return scrubCharacters(value.normalize('NFC'))
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * Normalize a value that must stay on one line, such as a title.
 *
 * @param {string} value
 * @returns {string}
 */
export function normalizeLine(value) {
  return normalizeText(value).replace(/\n+/g, ' ').trim();
}
