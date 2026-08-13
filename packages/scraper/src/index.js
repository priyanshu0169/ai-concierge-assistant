/**
 * @shopsage/scraper - a website `ContentSource`.
 *
 * One implementation of the port in `@shopsage/content-model`, not a special case.
 * Everything a crawl does - seeds, sitemaps, include and exclude patterns, depth,
 * page ceiling, rate, classification - comes from a site-profile section, so this
 * package names no store, no path and no URL layout.
 *
 * **In scope:** CMS pages, buying guides, FAQs, blog posts, shipping and returns
 * policies.
 *
 * **Out of scope: products.** Not an omission. Product data comes from the Magento
 * API at query time, because an embedded catalogue is a snapshot that is wrong the
 * moment a price or stock level changes - and a confidently wrong price is the most
 * damaging output this system can produce.
 *
 * See docs/adr/0016 and docs/adr/0017.
 */

export { createWebsiteSource } from './website/create-website-source.js';
export { USER_AGENT } from './website/fetch-page.js';

/** The registry key this package answers to. */
export const WEBSITE_SOURCE_TYPE = 'website';
