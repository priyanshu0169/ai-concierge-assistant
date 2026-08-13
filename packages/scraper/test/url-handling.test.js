import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { normalizeUrl } from '../src/website/normalize-url.js';
import { createUrlFilter } from '../src/website/url-filter.js';

describe('normalizeUrl', () => {
  it('drops the fragment, which never reaches the server', () => {
    assert.equal(normalizeUrl('https://example.com/help#top'), 'https://example.com/help');
  });

  it('drops a trailing slash, but keeps the root path', () => {
    assert.equal(normalizeUrl('https://example.com/help/'), 'https://example.com/help');
    assert.equal(normalizeUrl('https://example.com/'), 'https://example.com/');
  });

  it('lower-cases the host and leaves the path alone', () => {
    // Hosts are case-insensitive; paths are not, on most servers.
    assert.equal(normalizeUrl('https://EXAMPLE.com/Help'), 'https://example.com/Help');
  });

  it('drops tracking parameters, which identify a referral not a page', () => {
    assert.equal(
      normalizeUrl('https://example.com/help?utm_source=news&gclid=123'),
      'https://example.com/help',
    );
  });

  it('keeps a query that identifies content', () => {
    // Discarding all query strings would make paginated content unreachable.
    assert.equal(
      normalizeUrl('https://example.com/blog?page=2'),
      'https://example.com/blog?page=2',
    );
  });

  it('sorts query keys, so two orderings are one URL', () => {
    const first = normalizeUrl('https://example.com/s?b=2&a=1');
    const second = normalizeUrl('https://example.com/s?a=1&b=2');

    assert.equal(first, second);
  });

  it('resolves a relative href against its page', () => {
    assert.equal(
      normalizeUrl('../returns', 'https://example.com/help/shipping'),
      'https://example.com/returns',
    );
  });

  it('rejects non-http schemes, which are not pages', () => {
    for (const href of ['mailto:a@b.com', 'tel:+1', 'javascript:void(0)', 'data:text/html,x']) {
      assert.equal(normalizeUrl(href), undefined, `${href} should not be crawlable`);
    }
  });

  it('rejects an unparsable value', () => {
    assert.equal(normalizeUrl('not a url'), undefined);
    assert.equal(normalizeUrl(''), undefined);
  });

  it('collapses the four spellings of one page to one string', () => {
    const variants = [
      'https://example.com/help',
      'https://example.com/help/',
      'https://example.com/help#section',
      'https://example.com/help?utm_campaign=x',
    ].map((url) => normalizeUrl(url));

    assert.equal(new Set(variants).size, 1);
  });
});

describe('createUrlFilter', () => {
  /**
   * @param {Partial<Parameters<typeof createUrlFilter>[0]>} [overrides]
   */
  const filterFor = (overrides = {}) =>
    createUrlFilter({
      startUrls: ['https://example.com/help'],
      sitemaps: [],
      include: [],
      exclude: [],
      allowedHosts: [],
      ...overrides,
    });

  it('defaults allowed hosts to the seeds, so a crawl cannot wander the internet', () => {
    const filter = filterFor();

    assert.deepEqual(filter.allowedHosts, ['example.com']);
    assert.equal(filter.isCrawlable('https://example.com/anything'), true);
    assert.equal(filter.isCrawlable('https://somewhere-else.test/page'), false);
  });

  it('includes subdomains, where store content routinely lives', () => {
    const filter = filterFor();

    assert.equal(filter.isCrawlable('https://help.example.com/returns'), true);
  });

  it('does not treat a suffix match as the same host', () => {
    const filter = filterFor();

    assert.equal(filter.isCrawlable('https://notexample.com/page'), false);
    assert.equal(filter.isCrawlable('https://example.com.evil.test/page'), false);
  });

  it('treats an empty include list as "no opinion", not "nothing"', () => {
    // Otherwise the simplest configuration - one start URL - yields zero documents.
    assert.equal(filterFor().isCrawlable('https://example.com/anything'), true);
  });

  it('applies include patterns when given', () => {
    const filter = filterFor({ include: ['^https://example\\.com/(help|blog)(/|$)'] });

    assert.equal(filter.isCrawlable('https://example.com/help/returns'), true);
    assert.equal(filter.isCrawlable('https://example.com/blog'), true);
    assert.equal(filter.isCrawlable('https://example.com/products/123'), false);
  });

  it('lets exclude beat include, because that is what an operator expects', () => {
    const filter = filterFor({ include: ['/help'], exclude: ['/help/internal'] });

    assert.equal(filter.isCrawlable('https://example.com/help/returns'), true);
    assert.equal(filter.isCrawlable('https://example.com/help/internal/notes'), false);
  });

  it('matches patterns against the absolute URL, so they can name a host', () => {
    const filter = filterFor({
      allowedHosts: ['example.com'],
      include: ['^https://help\\.example\\.com/'],
    });

    assert.equal(filter.isCrawlable('https://help.example.com/x'), true);
    assert.equal(filter.isCrawlable('https://example.com/x'), false);
  });

  it('honours an explicit allowedHosts list over the seeds', () => {
    const filter = filterFor({ allowedHosts: ['docs.example.com'] });

    assert.equal(filter.isCrawlable('https://docs.example.com/x'), true);
    assert.equal(filter.isCrawlable('https://example.com/help'), false);
  });

  it('seeds allowed hosts from sitemaps too', () => {
    const filter = filterFor({
      startUrls: [],
      sitemaps: ['https://cdn.example.org/sitemap.xml'],
    });

    assert.deepEqual(filter.allowedHosts, ['cdn.example.org']);
  });

  it('rejects an unusable URL rather than throwing', () => {
    assert.equal(filterFor().isCrawlable('mailto:someone@example.com'), false);
  });
});
