import assert from 'node:assert/strict';
import { parseSiteProfile } from '@shopsage/platform';
import { describe, it } from 'node:test';
import { createWebsiteSource } from '../src/website/create-website-source.js';
import { parseSitemap } from '../src/website/sitemap.js';
import { toDocument } from '../src/website/to-document.js';

/**
 * Build a source config through the **real** site-profile schema.
 *
 * A hand-written config object would drift from the schema and hide a genuine break,
 * and it would also skip the defaults - which is where most of the crawl's behaviour
 * actually comes from.
 *
 * @param {Record<string, unknown>} overrides
 * @returns {Record<string, any>}
 */
function sourceConfig(overrides = {}) {
  const profile = parseSiteProfile({
    identity: { siteId: 'demo-store', companyName: 'Demo', assistantName: 'Sage' },
    prompts: {
      systemPrompt: 'You are a helpful shopping assistant for this store.',
      welcomeMessage: 'Hi.',
      fallbackMessage: 'Oops.',
      noAnswerMessage: 'Not found.',
    },
    integrations: { backendUrl: 'https://assistant.example.com' },
    content: {
      sources: [
        {
          type: 'website',
          id: 'help-centre',
          startUrls: ['https://example.com/help'],
          requestsPerSecond: 50,
          ...overrides,
        },
      ],
    },
  });

  return profile.content.sources[0];
}

/**
 * @param {string} body
 * @returns {string}
 */
function htmlPage(body) {
  return `<!doctype html><html lang="en"><head><title>Page</title></head><body><main>${body}</main></body></html>`;
}

/** Long enough to clear the minimum-text threshold. */
const PROSE =
  '<p>Unopened items may be returned within thirty days of delivery for a full refund, provided the packaging is intact and undamaged.</p>';

/**
 * A fetch double that serves a small site from a map of paths to HTML.
 *
 * @param {Record<string, string>} pages
 * @param {{ robots?: string, sitemap?: string }} [extras]
 */
function createFakeSite(pages, extras = {}) {
  /** @type {string[]} */
  const requested = [];

  const fetchImpl = /** @type {typeof fetch} */ (
    /** @type {unknown} */ (
      (/** @type {string} */ url) => {
        const address = String(url);
        requested.push(address);

        if (address.endsWith('/robots.txt')) {
          return Promise.resolve(
            new Response(extras.robots ?? '', { status: extras.robots === undefined ? 404 : 200 }),
          );
        }

        if (address.includes('sitemap')) {
          return Promise.resolve(
            new Response(extras.sitemap ?? '', {
              status: extras.sitemap === undefined ? 404 : 200,
            }),
          );
        }

        const path = new URL(address).pathname;
        const body = pages[path];

        if (body === undefined) return Promise.resolve(new Response('missing', { status: 404 }));

        return Promise.resolve(
          new Response(body, { status: 200, headers: { 'content-type': 'text/html' } }),
        );
      }
    )
  );

  return {
    fetchImpl,
    requested,
    pageRequests: () =>
      requested.filter((url) => !url.includes('robots') && !url.includes('sitemap')),
  };
}

/**
 * @param {import('@shopsage/content-model').ContentSource} source
 * @returns {Promise<import('@shopsage/content-model').Document[]>}
 */
async function collect(source) {
  /** @type {import('@shopsage/content-model').Document[]} */
  const documents = [];

  for await (const document of source.fetch()) documents.push(document);

  return documents;
}

/**
 * @param {{ config?: Record<string, unknown>, site: ReturnType<typeof createFakeSite> }} input
 */
function buildSource(input) {
  return createWebsiteSource({
    config: sourceConfig(input.config),
    siteId: 'demo-store',
    fetchImpl: input.site.fetchImpl,
    sleep: () => Promise.resolve(),
  });
}

describe('website content source', () => {
  it('emits a canonical document per page', async () => {
    const site = createFakeSite({ '/help': htmlPage(`<h1>Help</h1>${PROSE}`) });
    const source = buildSource({ site });

    const [document] = await collect(source);

    assert.equal(document.siteId, 'demo-store');
    assert.equal(document.sourceId, 'help-centre');
    assert.equal(document.sourceType, 'website');
    assert.equal(document.title, 'Help');
    assert.equal(document.url, 'https://example.com/help');
    assert.equal(document.reference, 'https://example.com/help');
    assert.match(document.id, /^doc_/);
    assert.match(document.contentHash, /^sha256:/);
    assert.equal(document.locale, 'en');
  });

  it('follows links, breadth first, within maxDepth', async () => {
    const site = createFakeSite({
      '/help': htmlPage(`<a href="/help/returns">Returns</a>${PROSE}`),
      '/help/returns': htmlPage(`<a href="/help/returns/eu">EU</a>${PROSE}`),
      '/help/returns/eu': htmlPage(PROSE),
    });

    const documents = await collect(buildSource({ site, config: { maxDepth: 1 } }));

    assert.deepEqual(
      documents.map((document) => document.url),
      ['https://example.com/help', 'https://example.com/help/returns'],
    );
  });

  it('stops at maxPages', async () => {
    const site = createFakeSite({
      '/help': htmlPage(`<a href="/a">a</a><a href="/b">b</a><a href="/c">c</a>${PROSE}`),
      '/a': htmlPage(PROSE),
      '/b': htmlPage(PROSE),
      '/c': htmlPage(PROSE),
    });

    const documents = await collect(buildSource({ site, config: { maxPages: 2 } }));

    assert.equal(documents.length, 2);
  });

  it('never visits the same URL twice, however it is spelled', async () => {
    const site = createFakeSite({
      '/help': htmlPage(`<a href="/help/">self</a><a href="/help#top">self</a>${PROSE}`),
    });

    await collect(buildSource({ site }));

    assert.equal(site.pageRequests().length, 1);
  });

  it('applies exclude patterns from the profile', async () => {
    const site = createFakeSite({
      '/help': htmlPage(`<a href="/checkout">Checkout</a>${PROSE}`),
      '/checkout': htmlPage(PROSE),
    });

    const documents = await collect(buildSource({ site, config: { exclude: ['/checkout'] } }));

    assert.deepEqual(
      documents.map((document) => document.url),
      ['https://example.com/help'],
    );
  });

  it('does not leave the allowed hosts', async () => {
    const site = createFakeSite({
      '/help': htmlPage(`<a href="https://elsewhere.test/page">Away</a>${PROSE}`),
    });

    await collect(buildSource({ site }));

    assert.equal(
      site.requested.some((url) => url.includes('elsewhere.test')),
      false,
    );
  });

  it('classifies by URL, so one domain can hold several content types', async () => {
    const site = createFakeSite({
      '/help': htmlPage(`<a href="/policies/returns">P</a>${PROSE}`),
      '/policies/returns': htmlPage(PROSE),
    });

    const documents = await collect(
      buildSource({
        site,
        config: { classify: [{ pattern: '/policies/', contentType: 'policy' }] },
      }),
    );

    const byUrl = new Map(documents.map((document) => [document.url, document.contentType]));
    assert.equal(byUrl.get('https://example.com/help'), 'page');
    assert.equal(byUrl.get('https://example.com/policies/returns'), 'policy');
  });

  describe('robots.txt', () => {
    it('honours Disallow', async () => {
      const site = createFakeSite(
        {
          '/help': htmlPage(`<a href="/private/x">P</a>${PROSE}`),
          '/private/x': htmlPage(PROSE),
        },
        { robots: 'User-agent: *\nDisallow: /private' },
      );

      const documents = await collect(buildSource({ site }));

      assert.deepEqual(
        documents.map((document) => document.url),
        ['https://example.com/help'],
      );
      assert.equal(
        site.requested.some((url) => url.includes('/private/')),
        false,
        'a disallowed path must not even be fetched',
      );
    });

    it('can be switched off by configuration, for a site you own', async () => {
      const site = createFakeSite(
        { '/help': htmlPage(PROSE), '/private/x': htmlPage(PROSE) },
        { robots: 'User-agent: *\nDisallow: /' },
      );

      const documents = await collect(buildSource({ site, config: { respectRobotsTxt: false } }));

      assert.equal(documents.length, 1);
    });

    it('treats a missing robots.txt as no restrictions', async () => {
      const site = createFakeSite({ '/help': htmlPage(PROSE) });

      assert.equal((await collect(buildSource({ site }))).length, 1);
    });
  });

  describe('sitemaps', () => {
    it('seeds from a sitemap at depth zero', async () => {
      // Distinct bodies: identical content is de-duplicated by hash, which would
      // otherwise make this look like the sitemap seed being dropped.
      const site = createFakeSite(
        {
          '/help': htmlPage(PROSE),
          '/deep/page': htmlPage(
            '<p>International orders are dispatched within two business days, and delivery typically takes up to fourteen days depending on the destination country.</p>',
          ),
        },
        {
          sitemap: `<?xml version="1.0"?><urlset><url><loc>https://example.com/deep/page</loc></url></urlset>`,
        },
      );

      const documents = await collect(
        buildSource({
          site,
          config: { sitemaps: ['https://example.com/sitemap.xml'], maxDepth: 0 },
        }),
      );

      assert.deepEqual(documents.map((document) => document.url).sort(), [
        'https://example.com/deep/page',
        'https://example.com/help',
      ]);
    });

    it('visits a start URL even when the sitemap alone would exhaust maxPages', async () => {
      // The defect this pins kept four pages out of a real corpus across five crawls, silently.
      // The frontier is FIFO and bounded by maxPages, and start URLs used to be appended *after*
      // the sitemap - so with a sitemap larger than the ceiling an explicitly named page was never
      // dequeued. It was not reported as skipped either, because nothing skipped it: the loop
      // simply stopped first.
      const site = createFakeSite(
        {
          '/policies/returns': htmlPage(
            `<h1>Returns</h1><p>Unopened items may be returned within thirty days. ${PROSE}</p>`,
          ),
          '/filler/a': htmlPage(`<h1>A</h1><p>Filler A. ${PROSE}</p>`),
          '/filler/b': htmlPage(`<h1>B</h1><p>Filler B. ${PROSE}</p>`),
        },
        {
          sitemap:
            '<?xml version="1.0"?><urlset>' +
            '<url><loc>https://example.com/filler/a</loc></url>' +
            '<url><loc>https://example.com/filler/b</loc></url>' +
            '</urlset>',
        },
      );

      // Two sitemap entries and a ceiling of two: the start URL only survives if it is queued
      // ahead of them.
      const documents = await collect(
        buildSource({
          site,
          config: {
            startUrls: ['https://example.com/policies/returns'],
            sitemaps: ['https://example.com/sitemap.xml'],
            maxPages: 2,
            maxDepth: 0,
          },
        }),
      );

      assert.ok(
        documents.some((document) => document.url === 'https://example.com/policies/returns'),
        `the start URL should be crawled first; got ${documents.map((d) => d.url).join(', ')}`,
      );
    });

    it('degrades to link discovery when a sitemap is unavailable', async () => {
      const site = createFakeSite({ '/help': htmlPage(PROSE) });

      const documents = await collect(
        buildSource({ site, config: { sitemaps: ['https://example.com/sitemap.xml'] } }),
      );

      assert.equal(documents.length, 1);
    });
  });

  describe('resilience', () => {
    it('counts a broken page and carries on', async () => {
      // One unreachable page must not abandon a five-hundred-page crawl.
      const site = createFakeSite({
        '/help': htmlPage(`<a href="/gone">Gone</a><a href="/ok">Ok</a>${PROSE}`),
        '/ok': htmlPage(PROSE),
      });

      const source = buildSource({ site });
      const documents = await collect(source);

      assert.equal(documents.length, 2);
      assert.ok(source.stats().skipped >= 1);
    });

    it('skips a page marked noindex', async () => {
      const site = createFakeSite({
        '/help': htmlPage(`<a href="/hidden">H</a>${PROSE}`),
        '/hidden':
          '<html><head><meta name="robots" content="noindex"></head><body><main><p>Hidden but long enough to otherwise qualify for ingestion here.</p></main></body></html>',
      });

      const documents = await collect(buildSource({ site }));

      assert.deepEqual(
        documents.map((document) => document.url),
        ['https://example.com/help'],
      );
    });

    it('skips a page with too little text to answer anything', async () => {
      const site = createFakeSite({
        '/help': htmlPage(`<a href="/thin">T</a>${PROSE}`),
        '/thin': htmlPage('<p>Hi.</p>'),
      });

      const documents = await collect(buildSource({ site }));

      assert.equal(documents.length, 1);
    });

    it('emits one document when two URLs have identical content', async () => {
      const site = createFakeSite({
        '/help': htmlPage(`<a href="/help-copy">Copy</a>${PROSE}`),
        '/help-copy': htmlPage(`<a href="/help-copy">Copy</a>${PROSE}`),
      });

      const source = buildSource({ site });
      const documents = await collect(source);

      assert.equal(documents.length, 1);
      assert.equal(source.stats().emitted, 1);
    });

    it('reports statistics after iteration', async () => {
      const site = createFakeSite({ '/help': htmlPage(PROSE) });
      const source = buildSource({ site });

      await collect(source);

      assert.deepEqual(source.stats(), { emitted: 1, skipped: 0, failed: 0 });
    });

    it('stops when the caller aborts', async () => {
      const site = createFakeSite({
        '/help': htmlPage(`<a href="/a">a</a><a href="/b">b</a>${PROSE}`),
        '/a': htmlPage(PROSE),
        '/b': htmlPage(PROSE),
      });
      const controller = new AbortController();
      const source = buildSource({ site });

      await assert.rejects(async () => {
        for await (const document of source.fetch({ signal: controller.signal })) {
          assert.ok(document);
          controller.abort();
        }
      });
    });
  });

  it('prefers the declared canonical URL as the document identity', () => {
    // Collapses category-scoped and parameterised variants of one article.
    const document = toDocument({
      page: {
        title: 'Returns',
        text: 'Unopened items may be returned within thirty days of delivery for a full refund, provided the original packaging is intact and undamaged.',
        canonicalUrl: 'https://example.com/help/returns',
        locale: 'en',
        noindex: false,
        description: undefined,
        links: [],
      },
      url: 'https://example.com/category/shoes/help/returns?page=2',
      siteId: 'demo-store',
      sourceId: 'help-centre',
      defaultContentType: 'page',
      classify: [],
      maxDocumentCharacters: 200_000,
    });

    assert.equal(document?.url, 'https://example.com/help/returns');
    assert.equal(
      document?.metadata.fetchedUrl,
      'https://example.com/category/shoes/help/returns?page=2',
    );
  });

  it('falls back to the fetched URL when the declared canonical is corrupt', () => {
    // Observed in production: a templating bug on the site duplicated its own origin
    // into the canonical href. `new URL` does not reject this - it parses into a
    // syntactically valid but wrong URL (host `example.comhttps`) - so the fix is a
    // same-host check, not a stricter URL parser.
    const document = toDocument({
      page: {
        title: 'Caviar',
        text: 'Beluga, Ossetra and Sevruga caviar, selected for flavour and provenance by our buyers each season, and stored under strict temperature control until it ships.',
        canonicalUrl: 'https://example.comhttps://example.com/caviar',
        locale: 'en',
        noindex: false,
        description: undefined,
        links: [],
      },
      url: 'https://example.com/caviar',
      siteId: 'demo-store',
      sourceId: 'catalogue-guide',
      defaultContentType: 'page',
      classify: [],
      maxDocumentCharacters: 200_000,
    });

    assert.equal(document?.url, 'https://example.com/caviar');
    assert.equal(document?.metadata.fetchedUrl, undefined);
  });

  it('falls back to the fetched URL when the declared canonical points at a different host', () => {
    const document = toDocument({
      page: {
        title: 'Caviar',
        text: 'Beluga, Ossetra and Sevruga caviar, selected for flavour and provenance by our buyers each season, and stored under strict temperature control until it ships.',
        canonicalUrl: 'https://staging.example.net/caviar',
        locale: 'en',
        noindex: false,
        description: undefined,
        links: [],
      },
      url: 'https://example.com/caviar',
      siteId: 'demo-store',
      sourceId: 'catalogue-guide',
      defaultContentType: 'page',
      classify: [],
      maxDocumentCharacters: 200_000,
    });

    assert.equal(document?.url, 'https://example.com/caviar');
  });
});

describe('parseSitemap', () => {
  it('reads page locations from a urlset', () => {
    const xml = `<urlset><url><loc>https://example.com/a</loc></url><url><loc>https://example.com/b</loc></url></urlset>`;

    assert.deepEqual(parseSitemap(xml), {
      urls: ['https://example.com/a', 'https://example.com/b'],
      indexes: [],
    });
  });

  it('distinguishes an index by its root element, not by its filename', () => {
    const xml = `<sitemapindex><sitemap><loc>https://example.com/one.xml</loc></sitemap></sitemapindex>`;

    assert.deepEqual(parseSitemap(xml), { urls: [], indexes: ['https://example.com/one.xml'] });
  });

  it('decodes XML entities in a location', () => {
    const xml = `<urlset><url><loc>https://example.com/s?a=1&amp;b=2</loc></url></urlset>`;

    assert.deepEqual(parseSitemap(xml).urls, ['https://example.com/s?a=1&b=2']);
  });

  it('de-duplicates and drops unusable locations', () => {
    const xml = `<urlset>
      <url><loc>https://example.com/a</loc></url>
      <url><loc>https://example.com/a/</loc></url>
      <url><loc>not-a-url</loc></url>
    </urlset>`;

    assert.deepEqual(parseSitemap(xml).urls, ['https://example.com/a']);
  });

  it('copes with junk', () => {
    assert.deepEqual(parseSitemap('<html>not a sitemap</html>'), { urls: [], indexes: [] });
    assert.deepEqual(parseSitemap(/** @type {any} */ (undefined)), { urls: [], indexes: [] });
  });
});
