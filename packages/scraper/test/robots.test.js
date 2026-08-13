import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { parseRobots } from '../src/website/robots.js';

const AGENT = 'ShopSageBot/0.1';

describe('parseRobots', () => {
  it('allows everything when robots.txt is absent or empty', () => {
    for (const contents of ['', '   ', /** @type {any} */ (undefined)]) {
      assert.equal(parseRobots(contents, AGENT).isAllowed('/anything'), true);
    }
  });

  it('honours a Disallow for the wildcard group', () => {
    const rules = parseRobots('User-agent: *\nDisallow: /admin', AGENT);

    assert.equal(rules.isAllowed('/admin'), false);
    assert.equal(rules.isAllowed('/admin/users'), false);
    assert.equal(rules.isAllowed('/help'), true);
  });

  it('treats an empty Disallow as allow-everything, not as a match on ""', () => {
    // The classic bug: prefix-matching the empty string blocks the entire site.
    const rules = parseRobots('User-agent: *\nDisallow:', AGENT);

    assert.equal(rules.isAllowed('/anything'), true);
  });

  it('lets the longest matching rule win, so exceptions work', () => {
    // "None of /admin except /admin/help" is a real and common instruction.
    const rules = parseRobots('User-agent: *\nDisallow: /admin\nAllow: /admin/help', AGENT);

    assert.equal(rules.isAllowed('/admin/secrets'), false);
    assert.equal(rules.isAllowed('/admin/help'), true);
    assert.equal(rules.isAllowed('/admin/help/faq'), true);
  });

  it('lets Allow win a tie of equal length', () => {
    const rules = parseRobots('User-agent: *\nDisallow: /x\nAllow: /x', AGENT);

    assert.equal(rules.isAllowed('/x'), true);
  });

  it('prefers a group naming us over the wildcard group, and does not merge them', () => {
    // Merging would apply rules a site aimed at a different crawler.
    const contents = [
      'User-agent: *',
      'Disallow: /',
      '',
      'User-agent: ShopSageBot',
      'Disallow: /private',
    ].join('\n');

    const rules = parseRobots(contents, AGENT);

    assert.equal(rules.isAllowed('/help'), true, 'the wildcard Disallow must not apply to us');
    assert.equal(rules.isAllowed('/private'), false);
  });

  it('shares one rule set across consecutive User-agent lines', () => {
    const contents = ['User-agent: ShopSageBot', 'User-agent: OtherBot', 'Disallow: /shared'].join(
      '\n',
    );

    assert.equal(parseRobots(contents, AGENT).isAllowed('/shared'), false);
  });

  it('supports * as a wildcard', () => {
    const rules = parseRobots('User-agent: *\nDisallow: /*.pdf', AGENT);

    assert.equal(rules.isAllowed('/guides/manual.pdf'), false);
    assert.equal(rules.isAllowed('/guides/manual.html'), true);
  });

  it('supports $ as an end anchor', () => {
    const rules = parseRobots('User-agent: *\nDisallow: /help$', AGENT);

    assert.equal(rules.isAllowed('/help'), false);
    assert.equal(rules.isAllowed('/help/returns'), true);
  });

  it('reads a crawl delay', () => {
    assert.equal(parseRobots('User-agent: *\nCrawl-delay: 2.5', AGENT).crawlDelaySeconds, 2.5);
  });

  it('takes the last crawl delay when the field repeats', () => {
    const rules = parseRobots('User-agent: *\nCrawl-delay: 1\nCrawl-delay: 5', AGENT);

    assert.equal(rules.crawlDelaySeconds, 5);
  });

  it('ignores a nonsense crawl delay', () => {
    assert.equal(
      parseRobots('User-agent: *\nCrawl-delay: soon', AGENT).crawlDelaySeconds,
      undefined,
    );
  });

  it('collects sitemaps, which are global rather than per group', () => {
    const contents = [
      'Sitemap: https://example.com/sitemap.xml',
      'User-agent: *',
      'Disallow: /admin',
      'Sitemap: https://example.com/news.xml',
    ].join('\n');

    assert.deepEqual(parseRobots(contents, AGENT).sitemaps, [
      'https://example.com/sitemap.xml',
      'https://example.com/news.xml',
    ]);
  });

  it('ignores comments and is case-insensitive about field names', () => {
    const contents = ['# a comment', 'USER-AGENT: *', 'DISALLOW: /admin # trailing'].join('\n');

    assert.equal(parseRobots(contents, AGENT).isAllowed('/admin'), false);
  });

  it('ignores directives that appear before any User-agent line', () => {
    assert.equal(parseRobots('Disallow: /orphan', AGENT).isAllowed('/orphan'), true);
  });

  it('allows everything when no group applies to us and there is no wildcard', () => {
    const rules = parseRobots('User-agent: SomeoneElse\nDisallow: /', AGENT);

    assert.equal(rules.isAllowed('/help'), true);
  });

  it('escapes regex metacharacters in a path, so they match literally', () => {
    const rules = parseRobots('User-agent: *\nDisallow: /a+b', AGENT);

    assert.equal(rules.isAllowed('/a+b'), false);
    assert.equal(rules.isAllowed('/aaab'), true);
  });
});
