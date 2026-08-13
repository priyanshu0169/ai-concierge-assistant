import { normalizeUrl } from './normalize-url.js';

/** A sitemap index pointing at another index pointing at another... stops here. */
const MAX_INDEX_DEPTH = 2;

/**
 * @typedef {object} SitemapEntries
 * @property {string[]} urls Page URLs found.
 * @property {string[]} indexes Nested sitemap URLs found.
 */

/**
 * Extract locations from a sitemap or sitemap index.
 *
 * Deliberately does not use an XML parser. A sitemap's entire useful content is its
 * `<loc>` elements, the format has no attributes or namespaces that change their
 * meaning, and adding an XML parser to read one element would be a dependency and an
 * attack surface for no benefit. `<lastmod>` is ignored for now - it becomes useful
 * for incremental crawls, which need a stored high-water mark that does not exist
 * yet.
 *
 * Whether a document is an index is decided by its root element, not by guessing
 * from the URL: plenty of sites serve an index from a path called `sitemap.xml`.
 *
 * @param {string} xml
 * @returns {SitemapEntries}
 */
export function parseSitemap(xml) {
  if (typeof xml !== 'string') return { urls: [], indexes: [] };

  const locations = [...xml.matchAll(/<loc>\s*([\s\S]*?)\s*<\/loc>/gi)]
    .map((match) => decodeXmlEntities(match[1].trim()))
    .map((value) => normalizeUrl(value))
    .filter((value) => value !== undefined);

  const unique = [...new Set(locations)];
  const isIndex = /<sitemapindex[\s>]/i.test(xml);

  return isIndex ? { urls: [], indexes: unique } : { urls: unique, indexes: [] };
}

/**
 * Resolve sitemaps to page URLs, following one level of index nesting.
 *
 * A sitemap that cannot be fetched or parsed is **skipped with a warning**, not
 * thrown. Sitemaps are an optimisation for discovery; a missing one means the crawl
 * falls back to following links, which is a degraded run rather than a failed one.
 * A start URL that does not resolve is a different matter and does fail.
 *
 * @param {{
 *   sitemaps: string[],
 *   fetchText: (url: string) => Promise<string | undefined>,
 *   logger?: import('@shopsage/platform').Logger,
 * }} input
 * @returns {Promise<string[]>}
 */
export async function collectSitemapUrls(input) {
  const { sitemaps, fetchText, logger } = input;

  /** @type {Set<string>} */
  const pages = new Set();
  /** @type {Set<string>} */
  const visited = new Set();
  let frontier = sitemaps.map((url) => normalizeUrl(url)).filter((url) => url !== undefined);

  for (let depth = 0; depth <= MAX_INDEX_DEPTH && frontier.length > 0; depth += 1) {
    /** @type {string[]} */
    const nested = [];

    for (const url of frontier) {
      if (visited.has(url)) continue;
      visited.add(url);

      const xml = await fetchText(url);
      if (xml === undefined) {
        logger?.warn('sitemap unavailable, falling back to link discovery', { sitemap: url });
        continue;
      }

      const { urls, indexes } = parseSitemap(xml);
      for (const page of urls) pages.add(page);
      nested.push(...indexes);
    }

    frontier = nested;
  }

  return [...pages];
}

/**
 * The five entities XML defines. Nothing else is legal in a `<loc>`.
 *
 * @param {string} value
 * @returns {string}
 */
function decodeXmlEntities(value) {
  return value
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}
