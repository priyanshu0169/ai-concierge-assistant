import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createMagentoClient } from '../src/create-magento-client.js';

/**
 * A fetch double recording every request, answering from a script.
 *
 * @param {(({ status?: number, body?: unknown }) | Error)[]} script
 */
function fakeFetch(script) {
  /** @type {{ url: string, headers: Record<string, string> }[]} */
  const requests = [];
  let index = 0;

  /** @type {any} */
  const impl = (/** @type {any} */ url, /** @type {any} */ init = {}) => {
    requests.push({ url: String(url), headers: { ...init.headers } });

    const step = script[Math.min(index, script.length - 1)];

    index += 1;

    if (step instanceof Error) return Promise.reject(step);

    const status = step.status ?? 200;

    return Promise.resolve(
      new Response(step.body === undefined ? null : JSON.stringify(step.body), {
        status,
        headers: { 'content-type': 'application/json' },
      }),
    );
  };

  return { impl, requests };
}

/**
 * @param {(({ status?: number, body?: unknown }) | Error)[]} script
 * @param {Partial<import('../src/create-magento-client.js').MagentoClientOptions>} [options]
 */
function clientWith(script, options = {}) {
  const { impl, requests } = fakeFetch(script);

  return {
    requests,
    client: createMagentoClient({
      baseUrl: 'https://store.example.com',
      fetchImpl: impl,
      // No backoff wait in a test. The retry policy is what is under test, not the sleeping.
      maxAttempts: 2,
      ...options,
    }),
  };
}

const ONE_PRODUCT = {
  sku: 'HD-MRN-NVY-L',
  name: 'Merino hoodie',
  url: 'https://example.com/p/1',
};

describe('talking to the commerce connector', () => {
  it('calls the contract path under /assistant/v1', async () => {
    const { client, requests } = clientWith([{ body: { items: [ONE_PRODUCT] } }]);

    await client.searchProducts({ query: 'wool hoodie' });

    assert.match(requests[0].url, /^https:\/\/store\.example\.com\/assistant\/v1\/products\?/u);
  });

  it('forwards the customer session token as a bearer', async () => {
    const { client, requests } = clientWith([{ body: { items: [] } }]);

    await client.searchProducts({ query: 'x', credential: 'header.body.sig' });

    assert.equal(requests[0].headers.authorization, 'Bearer header.body.sig');
  });

  it('sends the service credential in its own header, not as the bearer', async () => {
    const { client, requests } = clientWith([{ body: { items: [] } }], {
      serviceToken: 'shopsage-service',
    });

    await client.searchProducts({ query: 'x', credential: 'customer.session.token' });

    // Two credentials, two meanings: the bearer says "on behalf of this session", the service header
    // says "the caller is ShopSage". Collapsing them would make a stolen customer token enough to
    // impersonate the service.
    assert.equal(requests[0].headers.authorization, 'Bearer customer.session.token');
    assert.equal(requests[0].headers['x-shopsage-service-token'], 'shopsage-service');
  });

  it('sends no authorization header when there is no session token', async () => {
    const { client, requests } = clientWith([{ body: { items: [] } }]);

    await client.searchProducts({ query: 'x' });

    assert.equal(requests[0].headers.authorization, undefined);
  });

  it('encodes a sku into the path rather than interpolating it', async () => {
    const { client, requests } = clientWith([{ body: ONE_PRODUCT }]);

    await client.findProduct({ sku: 'A/B C' });

    // An unencoded slash would address a different endpoint entirely.
    assert.match(requests[0].url, /\/products\/A%2FB(%20|\+)C$/u);
  });

  it('caps the limit it asks for whatever it was given', async () => {
    const { client, requests } = clientWith([{ body: { items: [] } }]);

    await client.searchProducts({ query: 'x', limit: 500 });

    assert.match(requests[0].url, /limit=10/u);
  });
});

describe('when a lookup finds nothing', () => {
  it('reads a 404 on one product as absent, not as an error', async () => {
    const { client } = clientWith([
      { status: 404, body: { error: { code: 'PRODUCT_NOT_FOUND' } } },
    ]);

    // "We do not sell that" is an answer. Raising here would turn a normal miss into a failure the
    // assistant apologises for.
    assert.equal(await client.findProduct({ sku: 'GONE' }), undefined);
  });

  it('reads a search with no items as an empty list', async () => {
    const { client } = clientWith([{ body: { items: [] } }]);

    assert.deepEqual(await client.searchProducts({ query: 'submarine' }), []);
  });

  it('treats a malformed body as empty rather than throwing', async () => {
    const { client } = clientWith([{ body: { products: 'oops' } }]);

    assert.deepEqual(await client.searchProducts({ query: 'x' }), []);
  });
});

describe('retrying, and not retrying', () => {
  it('retries a 503, because the connector asked to be tried again', async () => {
    const { client, requests } = clientWith([{ status: 503 }, { body: { items: [ONE_PRODUCT] } }]);

    const products = await client.searchProducts({ query: 'x' });

    assert.equal(requests.length, 2);
    assert.equal(products.length, 1);
  });

  it('does not retry a 403, which will say the same thing twice', async () => {
    const { client, requests } = clientWith([{ status: 403 }]);

    await assert.rejects(client.listOrders({}), /returned 403/u);
    assert.equal(requests.length, 1);
  });

  it('does not retry a 404', async () => {
    const { client, requests } = clientWith([{ status: 404 }]);

    await client.findProduct({ sku: 'GONE' });

    assert.equal(requests.length, 1);
  });

  it('gives up after the configured attempts', async () => {
    const { client, requests } = clientWith([{ status: 502 }], { maxAttempts: 2 });

    await assert.rejects(client.searchProducts({ query: 'x' }), /returned 502/u);
    assert.equal(requests.length, 2);
  });

  it("never puts the connector's error text in the error it raises", async () => {
    const { client } = clientWith([
      { status: 500, body: { error: { message: 'SQLSTATE[42S02] table shopsage_x missing' } } },
    ]);

    await assert.rejects(client.searchProducts({ query: 'x' }), (error) => {
      // A connector's error text is written for its own operator, and everything above this turns a
      // failure into "I could not look that up" regardless of what it said.
      assert.ok(!String(error).includes('SQLSTATE'));
      assert.ok(!JSON.stringify(/** @type {any} */ (error).details).includes('shopsage_x'));

      return true;
    });
  });

  it('logs a retry without the session token', async () => {
    /** @type {any[]} */
    const warnings = [];
    const { client } = clientWith([{ status: 503 }, { body: { items: [] } }], {
      logger: /** @type {any} */ ({
        warn: (/** @type {any} */ msg, /** @type {any} */ fields) =>
          warnings.push({ msg, ...fields }),
      }),
    });

    await client.searchProducts({ query: 'x', credential: 'secret.token.value' });

    assert.equal(warnings.length, 1);
    assert.equal(warnings[0].operation, 'searchProducts');
    assert.ok(!JSON.stringify(warnings).includes('secret.token.value'));
  });
});
