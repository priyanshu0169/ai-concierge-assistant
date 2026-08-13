/**
 * The closed set of content kinds.
 *
 * Exported as values rather than only as a type so a site profile schema and a
 * source implementation validate against the same list, and adding a kind is one
 * edit rather than three that can drift.
 */
export const CONTENT_TYPES = Object.freeze({
  /** A general CMS page with no more specific classification. */
  PAGE: 'page',
  /** Question-and-answer content. Usually the highest-value retrieval material. */
  FAQ: 'faq',
  /** Buying guides, how-tos, explainers. */
  GUIDE: 'guide',
  /** Shipping, returns, privacy, terms. Answers here must be exact. */
  POLICY: 'policy',
  /** Editorial posts. Often time-sensitive, which matters for ranking later. */
  BLOG: 'blog',
  /** The source could not classify it. */
  OTHER: 'other',
});

/** @type {readonly import('./types.js').ContentType[]} */
export const CONTENT_TYPE_VALUES = Object.freeze(Object.values(CONTENT_TYPES));

/** Membership is a set lookup, so callers can test an arbitrary string cheaply. */
const KNOWN = new Set(/** @type {string[]} */ (Object.values(CONTENT_TYPES)));

/**
 * @param {unknown} value
 * @returns {value is import('./types.js').ContentType}
 */
export function isContentType(value) {
  return typeof value === 'string' && KNOWN.has(value);
}
