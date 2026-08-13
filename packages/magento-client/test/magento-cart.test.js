import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { createMagentoCart } from '../src/create-magento-cart.js';

/** @param {({ status?: number, body?: unknown } | Error)[]} script */
function clientWith(script) {
  /** @type {{ url: string, method: string, headers: any, body: any }[]} */
  const requests = [];
  let index = 0;

  /** @type {any} */
  const fetchImpl = (/** @type {any} */ url, /** @type {any} */ init = {}) => {
    requests.push({
      url: String(url),
      method: init.method,
      headers: { ...init.headers },
      body: init.body === undefined ? undefined : JSON.parse(init.body),
    });

    const step = script[Math.min(index, script.length - 1)];

    index += 1;

    if (step instanceof Error) return Promise.reject(step);

    return Promise.resolve(
      new Response(step.body === undefined ? null : JSON.stringify(step.body), {
        status: step.status ?? 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
  };

  return {
    requests,
    cart: createMagentoCart({ baseUrl: 'https://store.example.com', fetchImpl }),
  };
}

const LINES = [{ sku: 'HD-MRN-NVY-L', name: 'Merino hoodie', quantity: 2 }];

describe('adding to a cart', () => {
  it('posts to the contract path', async () => {
    const { cart, requests } = clientWith([{ body: { applied: true } }]);

    await cart.addToCart({ lines: LINES, idempotencyKey: 'k1' });

    assert.equal(requests[0].url, 'https://store.example.com/assistant/v1/cart/items');
    assert.equal(requests[0].method, 'POST');
  });

  it('sends the idempotency key as a header', async () => {
    const { cart, requests } = clientWith([{ body: { applied: true } }]);

    await cart.addToCart({ lines: LINES, idempotencyKey: 'k1' });

    assert.equal(requests[0].headers['idempotency-key'], 'k1');
  });

  it('sends only sku and quantity', async () => {
    const { cart, requests } = clientWith([{ body: { applied: true } }]);

    await cart.addToCart({
      lines: [{ ...LINES[0], price: { formatted: '£89.00' }, url: 'https://x.test/p' }],
      idempotencyKey: 'k1',
    });

    // The name, price and URL in a proposal exist so a customer could see what they agreed to. Sending
    // them would invite a connector to trust ShopSage's copy of a price.
    assert.deepEqual(requests[0].body, { items: [{ sku: 'HD-MRN-NVY-L', quantity: 2 }] });
  });

  it('forwards the session token and the service credential separately', async () => {
    const { requests } = clientWith([{ body: { applied: true } }]);
    const cart = createMagentoCart({
      baseUrl: 'https://store.example.com',
      serviceToken: 'svc',
      fetchImpl: /** @type {any} */ (
        (/** @type {any} */ url, /** @type {any} */ init) => {
          requests.push({
            url: String(url),
            method: init.method,
            headers: { ...init.headers },
            body: undefined,
          });

          return Promise.resolve(new Response('{"applied":true}', { status: 200 }));
        }
      ),
    });

    await cart.addToCart({ lines: LINES, idempotencyKey: 'k1', credential: 'session.token' });

    assert.equal(requests[0].headers.authorization, 'Bearer session.token');
    assert.equal(requests[0].headers['x-shopsage-service-token'], 'svc');
  });
});

describe('applying a coupon', () => {
  it('posts the code to the coupon path', async () => {
    const { cart, requests } = clientWith([{ body: { applied: true } }]);

    await cart.applyCoupon({ code: 'SAGE10', idempotencyKey: 'k1' });

    assert.equal(requests[0].url, 'https://store.example.com/assistant/v1/cart/coupon');
    assert.deepEqual(requests[0].body, { code: 'SAGE10' });
  });
});

describe("mapping the connector's answer", () => {
  it("carries the store's wording, item count, total and cart URL", async () => {
    const { cart } = clientWith([
      {
        body: {
          applied: true,
          message: 'Added to your basket.',
          itemCount: 3,
          total: { formatted: '£178.00', amount: '178.00', currency: 'GBP' },
          cartUrl: 'https://store.example.com/checkout/cart',
        },
      },
    ]);

    const outcome = await cart.addToCart({ lines: LINES, idempotencyKey: 'k1' });

    assert.equal(outcome.applied, true);
    assert.equal(outcome.message, 'Added to your basket.');
    assert.equal(outcome.itemCount, 3);
    assert.equal(outcome.total?.formatted, '£178.00');
  });

  it('defaults `applied` to false, never to true', async () => {
    for (const body of [{}, { applied: 'yes' }, { applied: 1 }, { message: 'ok' }]) {
      const { cart } = clientWith([{ body }]);

      // Every other field falls back to absent. This one cannot fall back to "it worked": telling a
      // customer their item is in the basket when the connector never said so is the failure the whole
      // workflow exists to avoid.
      const outcome = await cart.addToCart({ lines: LINES, idempotencyKey: 'k1' });

      assert.equal(outcome.applied, false, JSON.stringify(body));
    }
  });

  it('survives a body that is not an object', async () => {
    const { cart } = clientWith([{ body: 'nope' }]);

    assert.deepEqual(await cart.addToCart({ lines: LINES, idempotencyKey: 'k1' }), {
      applied: false,
    });
  });

  it('drops a cart URL that is not http', async () => {
    const { cart } = clientWith([{ body: { applied: true, cartUrl: 'javascript:alert(1)' } }]);

    const outcome = await cart.addToCart({ lines: LINES, idempotencyKey: 'k1' });

    assert.equal(outcome.cartUrl, undefined);
  });
});

describe('a write is never retried', () => {
  it('makes exactly one request when the connector fails with a 503', async () => {
    const { cart, requests } = clientWith([{ status: 503 }, { body: { applied: true } }]);

    await assert.rejects(cart.addToCart({ lines: LINES, idempotencyKey: 'k1' }), /returned 503/u);

    // A 5xx is not "worth another attempt" here: the connector may have added the item and lost the
    // response. Telling the customer it did not confirm is the honest outcome.
    assert.equal(requests.length, 1);
  });

  it('marks the failure not retryable, whatever the status', async () => {
    for (const status of [500, 502, 503, 429, 400]) {
      const { cart } = clientWith([{ status }]);

      await assert.rejects(
        cart.applyCoupon({ code: 'X', idempotencyKey: 'k1' }),
        (/** @type {any} */ error) => {
          // `retryable` is what tells a caller upstream it is safe to try again. It is not.
          assert.equal(error.retryable, false, String(status));

          return true;
        },
      );
    }
  });

  it('imports no retry helper at all', () => {
    const source = readFileSync(new URL('../src/create-magento-cart.js', import.meta.url), 'utf8');
    // The **import statements**, not the whole file. The module's own documentation says the words
    // "withRetry is not imported here", which a naive substring check reads as a violation - a nice
    // reminder that a test asserting on prose is testing prose.
    const imports = source
      .split(/\r?\n/u)
      .filter((line) => line.startsWith('import '))
      .join(' ');

    // The structural half of the guarantee. A future refactor consolidating the read and write request
    // helpers would make "writes never retry" false with every test still passing, because no test can
    // observe a second charge - so this one watches the import instead.
    assert.ok(!imports.includes('withRetry'), imports);
  });
});
