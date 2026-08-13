import { createDocument } from '@shopsage/content-model';
import { normalizeUrl } from './normalize-url.js';

/**
 * Too short to be a page worth retrieving. Below this it is a redirect stub, an
 * error page, or a shell whose content arrives by JavaScript we did not run.
 */
const MIN_TEXT_LENGTH = 120;

/**
 * @typedef {object} ToDocumentInput
 * @property {import('./html-document.js').ParsedPage} page
 * @property {string} url The URL actually fetched, after redirects.
 * @property {string} siteId
 * @property {string} sourceId
 * @property {string} defaultContentType
 * @property {{ pattern: string, contentType: string }[]} classify
 * @property {number} maxDocumentCharacters
 * @property {string} [lastModified]
 */

/**
 * Convert a parsed page into a canonical `Document`.
 *
 * Returns `undefined` when the page should not be ingested, which is a routine
 * outcome rather than an error: `noindex` pages, and pages with too little text to
 * carry an answer.
 *
 * The **canonical URL wins** over the fetched one when the page declares it. That is
 * what collapses `?page=1`, session-decorated and category-scoped variants of the
 * same article into one document — the site is telling us its own identity for the
 * content, and it knows better than URL normalization can.
 *
 * @param {ToDocumentInput} input
 * @returns {import('@shopsage/content-model').Document | undefined}
 */
export function toDocument(input) {
  const { page, url, siteId, sourceId } = input;

  if (page.noindex) return undefined;

  const text = truncate(page.text, input.maxDocumentCharacters);
  if (text.trim().length < MIN_TEXT_LENGTH) return undefined;

  const canonical = resolveCanonical(page.canonicalUrl, url);
  const location = canonical ?? url;

  return createDocument({
    siteId,
    sourceId,
    sourceType: 'website',
    contentType: classifyUrl(location, input),
    // The reference *is* the canonical URL for a website source: it is both the
    // document's identity and where a customer can be sent.
    reference: location,
    url: location,
    title: page.title,
    text,
    locale: page.locale,
    metadata: buildMetadata({ ...input, location }),
  });
}

/**
 * Resolve the page's declared canonical, distrusting one that resolves to a
 * different host than the page that declared it.
 *
 * A `<link rel="canonical">` is markup the site authored, and real sites get it
 * wrong. One observed in production: a templating bug that duplicates the origin
 * into the href itself - `https://example.comhttps://example.com/page` - rather
 * than a single well-formed URL. The WHATWG URL parser does not reject that: it
 * silently parses into *some* syntactically valid URL (host `example.comhttps`,
 * path `//example.com/page`), just not the one the site meant. So "did `new URL`
 * throw" is not a strong enough check on its own - it lets a corrupted-but-parseable
 * value through, and that value then becomes the document's permanent identity and
 * the citation URL a customer is sent.
 *
 * A canonical whose resolved host does not match the page that declared it is
 * exactly the signature of that failure mode (and, incidentally, of a canonical
 * pointing at an unrelated domain by mistake). Neither is legitimate for one crawl
 * scoped to one site (docs/adr/0017), so falling back to the URL actually fetched -
 * already this function's behaviour when no canonical is declared at all - is
 * always at least as correct.
 *
 * @param {string | undefined} canonicalUrl
 * @param {string} fetchedUrl
 * @returns {string | undefined}
 */
function resolveCanonical(canonicalUrl, fetchedUrl) {
  if (canonicalUrl === undefined) return undefined;

  const normalized = normalizeUrl(canonicalUrl, fetchedUrl);
  if (normalized === undefined) return undefined;

  const declaredHost = new URL(normalized).hostname;
  const fetchedHost = new URL(fetchedUrl).hostname;

  return declaredHost === fetchedHost ? normalized : undefined;
}

/**
 * Apply the profile's per-path classification rules, first match wins.
 *
 * Without these a whole site is one content type, which makes `contentType` useless
 * as a retrieval filter for any store that keeps FAQs, policies and a blog on one
 * domain — that is, every store.
 *
 * @param {string} url
 * @param {{ classify: { pattern: string, contentType: string }[], defaultContentType: string }} input
 * @returns {import('@shopsage/content-model').ContentType}
 */
function classifyUrl(url, input) {
  const match = input.classify.find((rule) => new RegExp(rule.pattern).test(url));

  // Both values came through the site-profile schema, which validates them against
  // the same closed set `createDocument` checks - and `createDocument` falls back to
  // `page` for anything unrecognised, so a drift degrades rather than throws.
  return /** @type {import('@shopsage/content-model').ContentType} */ (
    match?.contentType ?? input.defaultContentType
  );
}

/**
 * @param {ToDocumentInput & { location: string }} input
 * @returns {Record<string, string | number | boolean>}
 */
function buildMetadata(input) {
  const { page, url, location, lastModified } = input;

  return {
    ...(page.description === undefined ? {} : { description: page.description }),
    ...(lastModified === undefined ? {} : { lastModified }),
    // Recorded only when it differs, so the common case stays uncluttered and the
    // interesting case - a page that redirected or declared a different canonical -
    // is visible.
    ...(location === url ? {} : { fetchedUrl: url }),
  };
}

/**
 * Cut at a paragraph boundary where possible.
 *
 * The ceiling exists because a single enormous page would otherwise dominate a
 * crawl's memory and produce hundreds of chunks of mostly boilerplate. Cutting mid-
 * sentence would leave a fragment that reads as an error; cutting at a blank line
 * leaves something coherent.
 *
 * @param {string} text
 * @param {number} limit
 * @returns {string}
 */
function truncate(text, limit) {
  if (text.length <= limit) return text;

  const clipped = text.slice(0, limit);
  const lastBreak = clipped.lastIndexOf('\n\n');

  return lastBreak > limit / 2 ? clipped.slice(0, lastBreak) : clipped;
}
