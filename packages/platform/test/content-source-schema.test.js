import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ConfigurationError } from '../src/errors/errors.js';
import { parseSiteProfile } from '../src/config/site-profile-schema.js';

/**
 * @param {Record<string, unknown>[]} sources
 * @returns {Record<string, unknown>}
 */
function profileWith(sources) {
  return {
    identity: { siteId: 'demo-store', companyName: 'Demo', assistantName: 'Sage' },
    prompts: {
      systemPrompt: 'You are a helpful shopping assistant for this store.',
      welcomeMessage: 'Hi.',
      fallbackMessage: 'Oops.',
      noAnswerMessage: 'Not found.',
    },
    integrations: { backendUrl: 'https://assistant.example.com' },
    content: { sources },
  };
}

const MINIMAL_SOURCE = {
  type: 'website',
  id: 'help-centre',
  startUrls: ['https://example.com/help'],
};

describe('site profile content sources', () => {
  it('defaults to no sources, so a store that ingests nothing still validates', () => {
    const profile = parseSiteProfile(profileWith([]));

    assert.deepEqual(profile.content.sources, []);
  });

  it('applies crawl defaults, which is where most behaviour comes from', () => {
    const [source] = parseSiteProfile(profileWith([MINIMAL_SOURCE])).content.sources;

    assert.equal(source.enabled, true);
    assert.equal(source.contentType, 'page');
    assert.equal(source.maxDepth, 3);
    assert.equal(source.maxPages, 500);
    assert.equal(source.requestsPerSecond, 1);
    assert.equal(source.respectRobotsTxt, true);
    assert.deepEqual(source.include, []);
    assert.deepEqual(source.exclude, []);
    assert.deepEqual(source.allowedHosts, []);
  });

  it('requires a seed, because a crawl with no starting point silently does nothing', () => {
    assert.throws(
      () => parseSiteProfile(profileWith([{ type: 'website', id: 'empty' }])),
      ConfigurationError,
    );
  });

  it('accepts a sitemap as the only seed', () => {
    assert.doesNotThrow(() =>
      parseSiteProfile(
        profileWith([
          { type: 'website', id: 'sitemap-only', sitemaps: ['https://example.com/sitemap.xml'] },
        ]),
      ),
    );
  });

  it('names the offending index when two sources share an id', () => {
    try {
      parseSiteProfile(profileWith([MINIMAL_SOURCE, { ...MINIMAL_SOURCE }]));
      assert.fail('expected a ConfigurationError');
    } catch (error) {
      assert.ok(error instanceof ConfigurationError);
      const issues = /** @type {{ path: string, message: string }[]} */ (error.details?.issues);
      assert.ok(
        issues.some((issue) => issue.path.includes('1') && issue.message.includes('duplicate')),
        'the error should point at the second source',
      );
    }
  });

  it('rejects a pattern that would throw partway through a crawl', () => {
    // Compiling at boot turns a mid-crawl explosion into a configuration error.
    assert.throws(
      () => parseSiteProfile(profileWith([{ ...MINIMAL_SOURCE, include: ['([unclosed'] }])),
      ConfigurationError,
    );
  });

  it('rejects an unknown source type by name', () => {
    try {
      parseSiteProfile(profileWith([{ type: 'telepathy', id: 'x' }]));
      assert.fail('expected a ConfigurationError');
    } catch (error) {
      assert.ok(error instanceof ConfigurationError);
    }
  });

  it('rejects an unknown key, so a typo fails at boot', () => {
    assert.throws(
      () => parseSiteProfile(profileWith([{ ...MINIMAL_SOURCE, maxPagesTypo: 10 }])),
      ConfigurationError,
    );
  });

  it('rejects a content type outside the closed set', () => {
    assert.throws(
      () => parseSiteProfile(profileWith([{ ...MINIMAL_SOURCE, contentType: 'products' }])),
      ConfigurationError,
    );
  });

  it('rejects a non-http start URL', () => {
    assert.throws(
      () =>
        parseSiteProfile(profileWith([{ ...MINIMAL_SOURCE, startUrls: ['ftp://example.com'] }])),
      ConfigurationError,
    );
  });

  it('caps requestsPerSecond, because politeness is not optional', () => {
    assert.throws(
      () => parseSiteProfile(profileWith([{ ...MINIMAL_SOURCE, requestsPerSecond: 500 }])),
      ConfigurationError,
    );
  });

  it('accepts per-path classification rules', () => {
    const [source] = parseSiteProfile(
      profileWith([
        { ...MINIMAL_SOURCE, classify: [{ pattern: '/policies/', contentType: 'policy' }] },
      ]),
    ).content.sources;

    assert.deepEqual(source.classify, [{ pattern: '/policies/', contentType: 'policy' }]);
  });

  it('validates the profile shipped in this repository', async () => {
    // Guards the example: if config/site-profile.json drifts, this fails here rather
    // than at a store's first ingestion run.
    const { readFile } = await import('node:fs/promises');
    const path = await import('node:path');
    const repoRoot = path.resolve(import.meta.dirname, '../../..');
    const document = JSON.parse(
      await readFile(path.join(repoRoot, 'config', 'site-profile.json'), 'utf8'),
    );

    const profile = parseSiteProfile(document);

    assert.equal(profile.content.sources.length, 1);
    // Shipped disabled: an example must not crawl someone's site on first boot.
    assert.equal(profile.content.sources[0].enabled, false);
  });
});
