import { crawl } from './crawl.js';
import { crawlerFetch } from './crawler-fetch.js';
import { fetchPage, fetchText } from './fetch-page.js';
import { createUrlFilter } from './url-filter.js';

/**
 * Build a website `ContentSource` from its site-profile entry.
 *
 * Every behavioural decision — where to start, what to follow, how fast, how deep,
 * how to classify — comes from `config`, which is a site-profile section. Nothing in
 * this package names a store, a path or a URL layout. Two stores with completely
 * different sites run this same code.
 *
 * **Products are out of scope**, and not by omission. Product data comes from the
 * Magento API at query time, because an embedded catalogue is a snapshot that is
 * wrong the moment a price changes — and a confidently wrong price is the most
 * damaging thing this system can say.
 *
 * @param {{
 *   config: Record<string, any>,
 *   siteId: string,
 *   logger?: import('@shopsage/platform').Logger,
 *   fetchImpl?: typeof fetch,
 *   sleep?: (ms: number) => Promise<void>,
 * }} input
 * @returns {import('@shopsage/content-model').ContentSource}
 */
export function createWebsiteSource(input) {
  const { config, siteId, logger } = input;
  // `crawlerFetch`, not the bare global `fetch`: a real production site's response headers
  // (session/cart/consent cookies, CDN and WAF diagnostics) routinely exceed the 16 KiB ceiling
  // Node's fetch enforces by default, and unlike every other outbound client in this codebase, a
  // crawler talks to infrastructure it does not operate and cannot ask to send less. See
  // crawler-fetch.js for the full reasoning and docs/adr/0031.
  const fetchImpl = input.fetchImpl ?? crawlerFetch;

  /** @type {import('@shopsage/content-model').SourceStats} */
  const stats = { emitted: 0, skipped: 0, failed: 0 };

  const context = {
    config,
    siteId,
    logger: logger?.child({ sourceId: config.id, sourceType: 'website' }),
    stats,
    urlFilter: createUrlFilter({
      startUrls: config.startUrls,
      sitemaps: config.sitemaps,
      include: config.include,
      exclude: config.exclude,
      allowedHosts: config.allowedHosts,
    }),
    // The limiter is built inside the crawl, once robots.txt has been read: a site's
    // own Crawl-delay may require a slower rate than the profile configured.
    sleep: input.sleep,
    fetchPage: (/** @type {string} */ url, /** @type {AbortSignal | undefined} */ signal) =>
      fetchPage({ url, fetchImpl, signal }),
    fetchText: (/** @type {string} */ url, /** @type {AbortSignal | undefined} */ signal) =>
      fetchText({ url, fetchImpl, signal }),
  };

  return {
    id: config.id,
    type: 'website',
    // Counters are read after iteration. They are mutated by the crawl rather than
    // returned from it because `fetch()` yields documents lazily - there is no final
    // value to attach a summary to without complicating the common case.
    stats: () => ({ ...stats }),
    fetch: (options = {}) => crawl({ ...context, signal: options.signal }),
  };
}
