import { normalizeUrl } from './normalize-url.js';

/**
 * @typedef {object} UrlFilter
 * @property {(url: string) => boolean} isCrawlable
 * @property {string[]} allowedHosts
 */

/**
 * Decide which URLs a crawl may visit, from the site profile alone.
 *
 * Order matters and is not arbitrary:
 *
 * 1. **Host** — a crawler with no host restriction follows a footer link and starts
 *    crawling the internet. When `allowedHosts` is empty it defaults to the hosts of
 *    the seeds, so the safe behaviour is the one you get by not thinking about it.
 * 2. **Exclude** — checked before include, so exclude always wins. An operator
 *    adding `/checkout` to exclude expects it gone, not overridden by a broad
 *    include pattern they wrote last month.
 * 3. **Include** — an empty list means "no opinion", not "nothing". Requiring an
 *    include pattern to crawl anything would make the simplest configuration
 *    (a start URL and nothing else) silently produce zero documents.
 *
 * Patterns are tested against the **normalized absolute URL**, so they can match on
 * host as well as path, and so a pattern's behaviour does not depend on whether a
 * link happened to be written relative or absolute.
 *
 * @param {{
 *   startUrls: string[],
 *   sitemaps: string[],
 *   include: string[],
 *   exclude: string[],
 *   allowedHosts: string[],
 * }} config
 * @returns {UrlFilter}
 */
export function createUrlFilter(config) {
  const include = config.include.map((pattern) => new RegExp(pattern));
  const exclude = config.exclude.map((pattern) => new RegExp(pattern));
  const allowedHosts = resolveAllowedHosts(config);

  return {
    allowedHosts,

    isCrawlable(url) {
      if (!isHostAllowed(url, allowedHosts)) return false;
      if (exclude.some((pattern) => pattern.test(url))) return false;

      return include.length === 0 || include.some((pattern) => pattern.test(url));
    },
  };
}

/**
 * @param {{ startUrls: string[], sitemaps: string[], allowedHosts: string[] }} config
 * @returns {string[]}
 */
function resolveAllowedHosts(config) {
  if (config.allowedHosts.length > 0) {
    return config.allowedHosts.map((host) => host.toLowerCase());
  }

  const seeds = [...config.startUrls, ...config.sitemaps]
    .map((url) => hostOf(url))
    .filter((host) => host !== undefined);

  return [...new Set(seeds)];
}

/**
 * Matches the host itself and its subdomains.
 *
 * Subdomains are included because store content routinely lives on one (`help.`,
 * `blog.`), and an operator who listed `example.com` almost never means to exclude
 * those. Narrowing further is what `include` is for.
 *
 * @param {string} url
 * @param {string[]} allowedHosts
 * @returns {boolean}
 */
function isHostAllowed(url, allowedHosts) {
  const host = hostOf(url);
  if (host === undefined) return false;

  return allowedHosts.some((allowed) => host === allowed || host.endsWith(`.${allowed}`));
}

/**
 * @param {string} url
 * @returns {string | undefined}
 */
function hostOf(url) {
  const normalized = normalizeUrl(url);
  if (normalized === undefined) return undefined;

  return new URL(normalized).hostname.toLowerCase();
}
