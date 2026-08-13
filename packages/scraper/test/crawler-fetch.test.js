import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { after, before, describe, it } from 'node:test';
import { crawlerFetch } from '../src/website/crawler-fetch.js';
import { createWebsiteSource } from '../src/website/create-website-source.js';

/**
 * A **real** HTTP server, not a fake `fetchImpl` - the whole point of this file is a wire-level
 * header-parsing limit, which a hand-written double bypasses entirely by never going through
 * Undici's parser at all. Bound to `127.0.0.1` on an OS-assigned port, matching this project's
 * convention for tests that need a real socket.
 *
 * `bigHeaders: true` reproduces what a real production storefront sends: several `Set-Cookie`
 * values (session, cart, consent, analytics) that together exceed Node/Undici's 16 KiB default
 * ceiling for response headers, well before the actual page headers are even counted.
 *
 * @param {{ bigHeaders?: boolean }} [options]
 */
function startServer(options = {}) {
  const bigValue = 'x'.repeat(4000);

  const server = createServer((req, res) => {
    res.writeHead(200, {
      'content-type': 'text/html',
      // Comfortably over the 16 KiB default, not just past it - six cookies of ~4 KiB each is
      // ~24 KiB of Set-Cookie alone, so this stays a reliable reproduction regardless of exactly
      // how much overhead a given Node version counts per header.
      ...(options.bigHeaders === true
        ? {
            'set-cookie': [
              `session=${bigValue}`,
              `cart=${bigValue}`,
              `consent=${bigValue}`,
              `ab_test=${bigValue}`,
              `tracking=${bigValue}`,
              `personalization=${bigValue}`,
            ],
          }
        : {}),
    });
    res.end(
      '<!doctype html><html lang="en"><head><title>Page</title></head><body><main>' +
        '<p>Unopened items may be returned within thirty days of delivery for a full refund, ' +
        'provided the packaging is intact and undamaged.</p></main></body></html>',
    );
  });

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = /** @type {import('node:net').AddressInfo} */ (server.address());

      resolve({ server, origin: `http://127.0.0.1:${port}` });
    });
  });
}

describe('the bug this fixes, reproduced against a real server', () => {
  /** @type {import('node:http').Server} */
  let server;
  /** @type {string} */
  let origin;

  before(async () => {
    ({ server, origin } = await startServer({ bigHeaders: true }));
  });

  after(() => new Promise((resolve) => server.close(() => resolve(undefined))));

  it("fails with Node's plain global fetch", async () => {
    // Proves the failure is real and reproducible, and that it is a **response**-header limit: the
    // request carries nothing but the two headers fetchPage always sends, and Undici's parser still
    // overflows on what the server sent back.
    await assert.rejects(fetch(`${origin}/`), (/** @type {any} */ error) => {
      assert.equal(error.constructor.name, 'TypeError');
      assert.equal(error.cause?.constructor?.name, 'HeadersOverflowError');

      return true;
    });
  });

  it('succeeds through crawlerFetch', async () => {
    const response = await crawlerFetch(`${origin}/`);

    assert.equal(response.status, 200);
    assert.match(await response.text(), /thirty days/u);
  });
});

describe('crawlerFetch on an ordinary response', () => {
  /** @type {import('node:http').Server} */
  let server;
  /** @type {string} */
  let origin;

  before(async () => {
    ({ server, origin } = await startServer());
  });

  after(() => new Promise((resolve) => server.close(() => resolve(undefined))));

  it('behaves exactly like fetch when there is nothing to overflow', async () => {
    const response = await crawlerFetch(`${origin}/`);

    assert.equal(response.status, 200);
    assert.equal(response.headers.get('content-type'), 'text/html');
  });

  it('still honours an init object - headers, signal - passed alongside the larger dispatcher', async () => {
    const controller = new AbortController();
    const response = await crawlerFetch(`${origin}/`, {
      headers: { accept: 'text/html' },
      signal: controller.signal,
    });

    assert.equal(response.status, 200);
  });
});

describe('a real crawl through the default transport', () => {
  it('ingests a page whose headers would overflow plain fetch', async () => {
    const { server, origin } = await startServer({ bigHeaders: true });

    try {
      // No fetchImpl override: this is the exact fallback createWebsiteSource uses for a real
      // crawl, so a pass here is a pass for the actual reported failure, not just for the helper
      // in isolation.
      const source = createWebsiteSource({
        config: {
          id: 'oversized-headers-site',
          startUrls: [`${origin}/`],
          sitemaps: [],
          include: [],
          exclude: [],
          allowedHosts: [],
          classify: [],
          maxDepth: 1,
          maxPages: 1,
          requestsPerSecond: 50,
          respectRobotsTxt: false,
        },
        siteId: 'demo-store',
      });

      /** @type {import('@shopsage/content-model').Document[]} */
      const documents = [];

      for await (const document of source.fetch()) documents.push(document);

      assert.equal(documents.length, 1);
      assert.match(documents[0].text, /thirty days/u);
      assert.equal(source.stats().failed, 0);
    } finally {
      await new Promise((resolve) => server.close(() => resolve(undefined)));
    }
  });
});
