/**
 * Reduce a URL to a canonical form for de-duplication.
 *
 * A crawler that does not do this visits the same page many times: `/help`,
 * `/help/`, `/help#top` and `/help?utm_source=x` are four strings and one page. On a
 * site with a tracking parameter in every internal link, that is the difference
 * between crawling 200 pages and hitting `maxPages` on 200 copies of the homepage.
 *
 * What is normalized, and why only this much:
 *
 * - **Fragment dropped.** It never reaches the server, so it cannot identify a
 *   different document.
 * - **Tracking parameters dropped.** They are added by link builders, never by
 *   routing.
 * - **Remaining query preserved, with keys sorted.** Query strings frequently *do*
 *   identify a page (`?page=2`, `?article=returns`), so discarding them would lose
 *   content. Sorting makes two orderings of the same query one URL.
 * - **Trailing slash removed**, except on the root, where it is the path.
 * - **Host lower-cased**, path left alone: hosts are case-insensitive and paths are
 *   not, on most servers.
 *
 * @param {string} candidate
 * @param {string} [base] Resolves a relative href.
 * @returns {string | undefined} Undefined when the URL is unusable or not http(s).
 */
export function normalizeUrl(candidate, base) {
  const url = parseUrl(candidate, base);
  if (url === undefined) return undefined;

  url.hash = '';
  url.hostname = url.hostname.toLowerCase();
  stripTrackingParameters(url);
  url.searchParams.sort();

  if (url.pathname.length > 1 && url.pathname.endsWith('/')) {
    url.pathname = url.pathname.replace(/\/+$/, '');
  }

  return url.toString();
}

/**
 * Parameters that identify a *referral*, not a page.
 *
 * Deliberately a fixed list rather than "drop everything unrecognised": a store's
 * own routing may use any parameter name, and silently discarding it would make the
 * crawler unable to reach content that exists.
 */
const TRACKING_PARAMETERS = [
  /^utm_/i,
  /^gclid$/i,
  /^gbraid$/i,
  /^wbraid$/i,
  /^fbclid$/i,
  /^msclkid$/i,
  /^mc_(cid|eid)$/i,
  /^_ga$/i,
  /^ref$/i,
];

/**
 * @param {URL} url
 */
function stripTrackingParameters(url) {
  for (const key of [...url.searchParams.keys()]) {
    if (TRACKING_PARAMETERS.some((pattern) => pattern.test(key))) url.searchParams.delete(key);
  }
}

/**
 * @param {string} candidate
 * @param {string} [base]
 * @returns {URL | undefined}
 */
function parseUrl(candidate, base) {
  try {
    const url = new URL(candidate, base);

    // Anything else - mailto:, tel:, javascript:, data: - is not a page.
    return url.protocol === 'http:' || url.protocol === 'https:' ? url : undefined;
  } catch {
    return undefined;
  }
}
