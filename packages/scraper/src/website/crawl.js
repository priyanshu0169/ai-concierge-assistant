import { AppError } from '@shopsage/platform';
import { USER_AGENT } from './fetch-page.js';
import { parseHtmlPage } from './html-document.js';
import { normalizeUrl } from './normalize-url.js';
import { createRateLimiter } from './rate-limiter.js';
import { parseRobots } from './robots.js';
import { collectSitemapUrls } from './sitemap.js';
import { toDocument } from './to-document.js';

/**
 * @typedef {object} CrawlContext
 * @property {Record<string, any>} config
 * @property {string} siteId
 * @property {import('@shopsage/platform').Logger} [logger]
 * @property {import('@shopsage/content-model').SourceStats} stats
 * @property {import('./url-filter.js').UrlFilter} urlFilter
 * @property {(ms: number) => Promise<void>} [sleep] Injection seam for tests.
 * @property {(url: string, signal?: AbortSignal) => Promise<import('./fetch-page.js').FetchedPage | undefined>} fetchPage
 * @property {(url: string, signal?: AbortSignal) => Promise<string | undefined>} fetchText
 * @property {AbortSignal} [signal]
 */

/**
 * Breadth-first crawl, yielding documents as they are found.
 *
 * Breadth-first rather than depth-first on purpose: with a `maxPages` ceiling, the
 * pages that survive should be the ones nearest the seeds, because those are the ones
 * an operator deliberately pointed at. Depth-first would spend the budget on
 * whatever chain of links it wandered into first.
 *
 * Streaming rather than collecting: a run that fails on page 400 has still produced
 * 399 pages of usable output, and progress is observable while it happens.
 *
 * @param {CrawlContext} context
 * @returns {AsyncGenerator<import('@shopsage/content-model').Document, void, void>}
 */
export async function* crawl(context) {
  const { config, logger, stats, urlFilter, signal } = context;

  const robots = await loadRobots(context);
  const frontier = await buildFrontier(context, robots);
  const rateLimiter = createRateLimiter({
    requestsPerSecond: effectiveRate(context, robots),
    sleep: context.sleep,
  });

  /** @type {Set<string>} */
  const seen = new Set(frontier.map((entry) => entry.url));
  /** @type {Set<string>} */
  const emittedHashes = new Set();
  let visited = 0;

  logger?.info('crawl started', {
    seeds: frontier.length,
    allowedHosts: urlFilter.allowedHosts,
    maxPages: config.maxPages,
    maxDepth: config.maxDepth,
  });

  while (frontier.length > 0 && visited < config.maxPages) {
    signal?.throwIfAborted();

    const entry = /** @type {{ url: string, depth: number }} */ (frontier.shift());
    if (!robots.isAllowed(new URL(entry.url).pathname)) {
      stats.skipped += 1;
      logger?.debug('page skipped', { url: entry.url, reason: 'robots-disallowed' });
      continue;
    }

    visited += 1;
    const outcome = await visit(context, entry, rateLimiter);

    const document = recordOutcome({ outcome, url: entry.url, stats, emittedHashes, logger });

    if (document !== undefined) yield document;

    enqueue({ frontier, seen, urlFilter, links: outcome.links, entry, maxDepth: config.maxDepth });
  }

  logger?.info('crawl finished', { visited, ...stats, remainingInFrontier: frontier.length });
}

/**
 * Fetch and convert one page. Never throws for a page-level problem.
 *
 * @param {CrawlContext} context
 * @param {{ url: string, depth: number }} entry
 * @param {import('./rate-limiter.js').RateLimiter} rateLimiter
 * @returns {Promise<{ document?: import('@shopsage/content-model').Document, links: string[] }>}
 */
async function visit(context, entry, rateLimiter) {
  const { logger, stats, signal } = context;

  try {
    await rateLimiter.acquire();
    const fetched = await context.fetchPage(entry.url, signal);

    if (fetched === undefined) {
      stats.skipped += 1;
      // The one debug line that would have shortened this stage's own investigation from a
      // manual, ad-hoc probe to a single `--verbose` run: `fetchPage` returning `undefined`
      // covers a non-2xx response, a non-HTML content-type, and a too-large body, and those are
      // three very different reasons for the same number. Not distinguished further here because
      // fetchPage already discarded which one it was - see fetch-page.js if that granularity is
      // ever worth adding.
      logger?.debug('page skipped', { url: entry.url, reason: 'not fetched as a page' });
      return { links: [] };
    }

    return convert({ context, entry, fetched });
  } catch (error) {
    if (signal?.aborted === true) throw error;

    // One unreachable page must not abandon a five-hundred-page crawl.
    stats.failed += 1;
    logger?.warn('page failed', {
      url: entry.url,
      err: AppError.is(error) ? error : new Error(String(error)),
    });

    return { links: [] };
  }
}

/**
 * Parse a fetched page and convert it to a document, logging why if it is not one.
 *
 * Split out of `visit` so that function keeps one job - fetch, and turn a transport failure into
 * a count rather than an abandoned crawl - and this one has the other: whether what came back is
 * worth a customer's answer.
 *
 * @param {{
 *   context: CrawlContext,
 *   entry: { url: string, depth: number },
 *   fetched: import('./fetch-page.js').FetchedPage,
 * }} input
 * @returns {{ document?: import('@shopsage/content-model').Document, links: string[] }}
 */
function convert(input) {
  const { context, entry, fetched } = input;
  const { config, siteId, logger, stats } = context;

  const page = parseHtmlPage(fetched.html);
  const document = toDocument({
    page,
    url: normalizeUrl(fetched.finalUrl) ?? entry.url,
    siteId,
    sourceId: config.id,
    defaultContentType: config.contentType,
    classify: config.classify,
    maxDocumentCharacters: config.maxDocumentCharacters,
    lastModified: fetched.lastModified,
  });

  if (document === undefined) {
    stats.skipped += 1;
    logger?.debug('page skipped', {
      url: entry.url,
      reason: reasonDocumentSkipped(page),
      textLength: page.text.trim().length,
    });
  }

  return { document, links: page.links };
}

/**
 * @param {import('./html-document.js').ParsedPage} page
 * @returns {string}
 */
function reasonDocumentSkipped(page) {
  return page.noindex ? 'noindex' : 'too little text';
}

/**
 * Decide what happens to one visited page's outcome: emit it, or skip it and log why.
 *
 * Pulled out of the main loop so that loop keeps one job - walk the frontier - and this one has
 * the other: whether a page's content is new enough to be worth a customer's answer. Two URLs with
 * byte-identical content are one document, common on stores that expose the same policy page under
 * several category paths; without this check a five-hundred-page crawl of one such store would
 * chunk and embed the same paragraph five hundred times.
 *
 * @param {{
 *   outcome: { document?: import('@shopsage/content-model').Document, links: string[] },
 *   url: string,
 *   stats: import('@shopsage/content-model').SourceStats,
 *   emittedHashes: Set<string>,
 *   logger?: import('@shopsage/platform').Logger,
 * }} input
 * @returns {import('@shopsage/content-model').Document | undefined} The document to yield, if any.
 */
function recordOutcome(input) {
  const { outcome, url, stats, emittedHashes, logger } = input;

  if (outcome.document === undefined) return undefined;

  if (emittedHashes.has(outcome.document.contentHash)) {
    stats.skipped += 1;
    logger?.debug('page skipped', { url, reason: 'duplicate content' });

    return undefined;
  }

  emittedHashes.add(outcome.document.contentHash);
  stats.emitted += 1;

  return outcome.document;
}

/**
 * @param {{
 *   frontier: { url: string, depth: number }[],
 *   seen: Set<string>,
 *   urlFilter: import('./url-filter.js').UrlFilter,
 *   links: string[],
 *   entry: { url: string, depth: number },
 *   maxDepth: number,
 * }} input
 */
function enqueue(input) {
  const { frontier, seen, urlFilter, links, entry, maxDepth } = input;
  if (entry.depth >= maxDepth) return;

  for (const href of links) {
    const url = normalizeUrl(href, entry.url);

    if (url === undefined || seen.has(url) || !urlFilter.isCrawlable(url)) continue;

    seen.add(url);
    frontier.push({ url, depth: entry.depth + 1 });
  }
}

/**
 * Seed the frontier from sitemaps first, then start URLs.
 *
 * Sitemap entries are seeded at depth 0, so a sitemap-listed page is never dropped
 * for being too deep - a site that published a URL has already told us it matters.
 *
 * @param {CrawlContext} context
 * @param {import('./robots.js').RobotsRules} robots
 * @returns {Promise<{ url: string, depth: number }[]>}
 */
async function buildFrontier(context, robots) {
  const { config, logger, urlFilter, signal } = context;

  const declared = config.respectRobotsTxt ? robots.sitemaps : [];
  const sitemapUrls = await collectSitemapUrls({
    sitemaps: [...config.sitemaps, ...declared],
    fetchText: (url) => context.fetchText(url, signal),
    logger,
  });

  // Start URLs first, and that ordering is load-bearing rather than cosmetic. The frontier is a
  // FIFO queue bounded by `maxPages`, so a start URL appended after the sitemap is only reached if
  // the sitemap is smaller than that bound. On this site the sitemap yields 2,167 URLs against a
  // 1,000-page ceiling, which meant explicitly named pages sat at position ~2,168 and were never
  // visited - four policy and company pages stayed missing from the corpus across five crawls
  // because of it, and nothing reported them as skipped because they were never dequeued.
  //
  // Putting them first also matches what the filter below already assumes: an operator naming a URL
  // explicitly means it, so it should outrank a URL discovered from a sitemap.
  const seeds = [...config.startUrls, ...sitemapUrls]
    .map((url) => normalizeUrl(url))
    .filter((url) => url !== undefined);

  // Start URLs bypass include/exclude - an operator naming a URL explicitly means it.
  const startUrls = new Set(config.startUrls.map((/** @type {string} */ url) => normalizeUrl(url)));

  return [...new Set(seeds)]
    .filter((url) => startUrls.has(url) || urlFilter.isCrawlable(url))
    .map((url) => ({ url, depth: 0 }));
}

/**
 * @param {CrawlContext} context
 * @returns {Promise<import('./robots.js').RobotsRules>}
 */
async function loadRobots(context) {
  const { config, logger, signal } = context;

  if (config.respectRobotsTxt === false) {
    logger?.warn('robots.txt is being ignored by configuration', {
      remediation: 'only appropriate for a site you own',
    });

    return { isAllowed: () => true, crawlDelaySeconds: undefined, sitemaps: [] };
  }

  const origins = originsOf(config);
  /** @type {import('./robots.js').RobotsRules[]} */
  const perOrigin = [];

  for (const origin of origins) {
    const contents = await context.fetchText(`${origin}/robots.txt`, signal);
    perOrigin.push(parseRobots(contents ?? '', USER_AGENT));
  }

  return mergeRobots(perOrigin);
}

/**
 * Honour a site's own `Crawl-delay` when it asks for less than we configured.
 *
 * Parsing the directive and then ignoring it would be worse than not parsing it: the
 * site has stated a rate, in the one file it has to state it in, and exceeding it is
 * how a crawler earns a block. Our configured rate is treated as a ceiling, never as
 * an entitlement — we go slower if asked, never faster.
 *
 * @param {CrawlContext} context
 * @param {import('./robots.js').RobotsRules} robots
 * @returns {number} Requests per second.
 */
function effectiveRate(context, robots) {
  const configured = context.config.requestsPerSecond;
  const delay = robots.crawlDelaySeconds;

  if (typeof delay !== 'number' || delay <= 0) return configured;

  const requested = 1 / delay;
  if (requested >= configured) return configured;

  context.logger?.info('honouring robots.txt crawl-delay', {
    crawlDelaySeconds: delay,
    configuredRequestsPerSecond: configured,
    effectiveRequestsPerSecond: requested,
  });

  return requested;
}

/**
 * Combine per-origin rules conservatively.
 *
 * A crawl may legitimately span `example.com` and `help.example.com`, each with its
 * own robots.txt. A path is fetched only if **every** applicable origin allows it,
 * and the largest crawl-delay wins. Being stricter than necessary costs a little
 * coverage; being laxer than a site asked for is a breach of it.
 *
 * @param {import('./robots.js').RobotsRules[]} rules
 * @returns {import('./robots.js').RobotsRules}
 */
function mergeRobots(rules) {
  const delays = rules
    .map((rule) => rule.crawlDelaySeconds)
    .filter((delay) => typeof delay === 'number');

  return {
    isAllowed: (pathname) => rules.every((rule) => rule.isAllowed(pathname)),
    crawlDelaySeconds: delays.length === 0 ? undefined : Math.max(...delays),
    sitemaps: [...new Set(rules.flatMap((rule) => rule.sitemaps))],
  };
}

/**
 * @param {Record<string, any>} config
 * @returns {string[]}
 */
function originsOf(config) {
  const urls = [...config.startUrls, ...config.sitemaps];

  const origins = urls
    .map((url) => normalizeUrl(url))
    .filter((url) => url !== undefined)
    .map((url) => new URL(url).origin);

  return [...new Set(origins)];
}
