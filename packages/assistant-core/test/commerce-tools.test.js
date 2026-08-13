import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createToolRegistry } from '../src/tools/tool-registry.js';
import {
  createFakeCommerce,
  createFakeRetriever,
  createRecordingLogger,
  testOrder,
  testProduct,
  testProfile,
} from './helpers/domain-doubles.js';

const COMMERCE_FEATURES = {
  features: {
    productSearch: true,
    productComparison: true,
    recommendations: true,
    orderTracking: true,
  },
};

/**
 * @param {{
 *   commerce?: any,
 *   profile?: import('@shopsage/platform').SiteProfile,
 *   credential?: string,
 * }} [options]
 */
function contextFor(options = {}) {
  const siteProfile = options.profile ?? testProfile(COMMERCE_FEATURES);
  const { logger, records } = createRecordingLogger();

  return {
    records,
    siteProfile,
    context: {
      siteId: siteProfile.identity.siteId,
      siteProfile,
      retriever: createFakeRetriever(),
      commerce: options.commerce ?? createFakeCommerce(),
      logger,
      ...(options.credential === undefined ? {} : { credential: options.credential }),
    },
  };
}

/**
 * @param {string} name
 * @param {import('@shopsage/platform').SiteProfile} siteProfile
 */
function toolNamed(name, siteProfile) {
  const tool = createToolRegistry(siteProfile).find(name);

  assert.ok(tool, `${name} should be registered`);

  return tool;
}

describe('the commerce tools a store is offered', () => {
  it('registers one tool per enabled feature and nothing more', () => {
    const registry = createToolRegistry(testProfile(COMMERCE_FEATURES));

    assert.deepEqual(registry.tools.map((tool) => tool.name).sort(), [
      'compareProducts',
      'recommendProducts',
      'searchKnowledge',
      'searchProducts',
      'trackOrder',
    ]);
  });

  it('offers no commerce tool to a knowledge-only store', () => {
    const registry = createToolRegistry(testProfile());

    assert.deepEqual(
      registry.tools.map((tool) => tool.name),
      ['searchKnowledge'],
    );
  });

  it('withholds trackOrder from a session without the orders scope', () => {
    const registry = createToolRegistry(testProfile(COMMERCE_FEATURES), ['chat']);
    const names = registry.tools.map((tool) => tool.name);

    // Absent, not present-and-refusing. A guest asking about an order should be told the assistant
    // cannot look it up, not left waiting for a lookup that was never going to happen.
    assert.ok(!names.includes('trackOrder'));
    assert.ok(names.includes('searchProducts'));
    assert.equal(
      registry.definitions.find((entry) => entry.name === 'trackOrder'),
      undefined,
    );
  });

  it('grants trackOrder to a session that holds the scope', () => {
    const registry = createToolRegistry(testProfile(COMMERCE_FEATURES), ['chat', 'orders']);

    assert.ok(registry.tools.some((tool) => tool.name === 'trackOrder'));
  });
});

describe('searchProducts', () => {
  it('forwards the session token to the connector untouched', async () => {
    const commerce = createFakeCommerce();
    const { context, siteProfile } = contextFor({ commerce, credential: 'header.body.signature' });

    await toolNamed('searchProducts', siteProfile).execute({
      arguments: { query: 'wool hoodie' },
      context,
    });

    assert.equal(commerce.calls[0].credential, 'header.body.signature');
  });

  it('never logs the session token', async () => {
    const { context, siteProfile, records } = contextFor({ credential: 'secret.token.value' });

    await toolNamed('searchProducts', siteProfile).execute({
      arguments: { query: 'wool hoodie' },
      context,
    });

    assert.ok(!JSON.stringify(records).includes('secret.token.value'));
  });

  it('states the price exactly as the connector formatted it', async () => {
    const { context, siteProfile } = contextFor();

    const result = await toolNamed('searchProducts', siteProfile).execute({
      arguments: { query: 'wool hoodie' },
      context,
    });

    assert.match(result.content, /£120\.00 including tax/u);
    // Never rendered from the decimal amount. The formatted string is the only thing shown, so a
    // bare "120.00" appearing anywhere would mean something reconstructed a price.
    assert.ok(!/(?<!£)\b120\.00\b/u.test(result.content));
  });

  it('forbids arithmetic on money in the result the model reads', async () => {
    const { context, siteProfile } = contextFor();

    const result = await toolNamed('searchProducts', siteProfile).execute({
      arguments: { query: 'wool hoodie' },
      context,
    });

    assert.match(result.content, /Never calculate a total, a discount, a tax amount/u);
  });

  it('says nothing about stock when the connector said nothing', async () => {
    const bare = testProduct({ availability: undefined, price: undefined });
    const { context, siteProfile } = contextFor({
      commerce: createFakeCommerce({ products: [bare] }),
    });

    const result = await toolNamed('searchProducts', siteProfile).execute({
      arguments: { query: 'wool hoodie' },
      context,
    });

    assert.ok(!result.content.includes('Availability:'));
    assert.ok(!result.content.includes('Price:'));
    assert.match(result.content, /Link: https:\/\/example\.com/u);
  });

  it('marks an unstated tax treatment as unstated rather than picking one', async () => {
    const product = testProduct({ price: { formatted: '£120.00', amount: '120.00' } });
    const { context, siteProfile } = contextFor({
      commerce: createFakeCommerce({ products: [product] }),
    });

    const result = await toolNamed('searchProducts', siteProfile).execute({
      arguments: { query: 'wool hoodie' },
      context,
    });

    assert.match(result.content, /tax treatment unstated/u);
  });

  it('treats an unknown sku as a miss, not a failure', async () => {
    const { context, siteProfile } = contextFor();

    const result = await toolNamed('searchProducts', siteProfile).execute({
      arguments: { sku: 'NOT-A-SKU' },
      context,
    });

    assert.match(result.content, /No product found with sku NOT-A-SKU/u);
  });

  it('tells the model not to invent products when nothing matched', async () => {
    const { context, siteProfile } = contextFor({ commerce: createFakeCommerce({ products: [] }) });

    const result = await toolNamed('searchProducts', siteProfile).execute({
      arguments: { query: 'snowshoes' },
      context,
    });

    assert.match(result.content, /No matching products found/u);
    assert.match(result.content, /Do not suggest a product that is not listed/u);
  });

  it('points a discovery question at searchKnowledge when the catalogue matched nothing', async () => {
    // The empty-result twin of the outage defect. This message used to end "do not guess at what
    // the store sells", which a model read as "stop" - even though the store's own website often
    // describes the category in detail. Consulting published pages is not guessing; inventing a
    // product is. The prohibition now names the thing actually forbidden.
    const { context, siteProfile } = contextFor({ commerce: createFakeCommerce({ products: [] }) });

    const result = await toolNamed('searchProducts', siteProfile).execute({
      arguments: { query: 'caviar' },
      context,
    });

    assert.match(result.content, /call searchKnowledge/u);
    assert.doesNotMatch(result.content, /do not guess at what the store sells/u);
    assert.match(result.content, /[Nn]ever quote a price or stock level/u);
  });
});

describe('compareProducts', () => {
  const cheaper = testProduct({
    sku: 'TS-CTN-WHT-M',
    name: 'Cotton t-shirt, white, medium',
    price: { formatted: '£24.00', amount: '24.00', currency: 'GBP', taxIncluded: true },
  });

  it('orders cheapest first and names only the axes that differ', async () => {
    const commerce = createFakeCommerce({ products: [testProduct(), cheaper] });
    const { context, siteProfile } = contextFor({ commerce });

    const result = await toolNamed('compareProducts', siteProfile).execute({
      arguments: { skus: ['HD-MRN-NVY-L', 'TS-CTN-WHT-M'] },
      context,
    });

    assert.ok(result.content.indexOf('£24.00') < result.content.indexOf('£120.00'));
    assert.match(result.content, /Listed cheapest first/u);
    // The tool result carries the refusal too, not just the ordering. This is the tool where "by how
    // much" gets asked, and instructions nearest the data are the ones a model follows.
    assert.match(result.content, /never by how much/u);
    assert.match(result.content, /genuinely differ: Price/u);
    // Both are in stock with tax included, so those are stated once rather than per product.
    assert.match(result.content, /Identical across all of them[^\n]*Availability: in_stock/u);
  });

  it('computes no price difference, however comparable the prices are', async () => {
    const commerce = createFakeCommerce({ products: [testProduct(), cheaper] });
    const { context, siteProfile } = contextFor({ commerce });

    const result = await toolNamed('compareProducts', siteProfile).execute({
      arguments: { skus: ['HD-MRN-NVY-L', 'TS-CTN-WHT-M'] },
      context,
    });

    // 120.00 - 24.00. If this string ever appears, something started doing sums about money.
    assert.ok(!result.content.includes('96'));
  });

  it('leaves the order alone when currencies are mixed', async () => {
    const euro = testProduct({
      sku: 'EU-1',
      price: { formatted: '€30,00', amount: '30.00', currency: 'EUR' },
    });
    const commerce = createFakeCommerce({ products: [testProduct(), euro] });
    const { context, siteProfile } = contextFor({ commerce });

    const result = await toolNamed('compareProducts', siteProfile).execute({
      arguments: { skus: ['HD-MRN-NVY-L', 'EU-1'] },
      context,
    });

    // No exchange rate exists here, so "cheapest" would be a fabricated comparison.
    assert.ok(!result.content.includes('cheapest first'));
  });

  it('refuses to call one product a comparison', async () => {
    const { context, siteProfile } = contextFor();

    const result = await toolNamed('compareProducts', siteProfile).execute({
      arguments: { skus: ['HD-MRN-NVY-L', 'GONE-1'] },
      context,
    });

    assert.match(result.content, /Not enough of those products could be found/u);
    assert.match(result.content, /GONE-1/u);
  });

  it('deduplicates skus so a repeat cannot become a self-comparison', async () => {
    const commerce = createFakeCommerce();
    const { context, siteProfile } = contextFor({ commerce });

    const result = await toolNamed('compareProducts', siteProfile).execute({
      arguments: { skus: ['HD-MRN-NVY-L', 'HD-MRN-NVY-L'] },
      context,
    });

    // One distinct sku is not a comparison, so it is refused before the connector is touched
    // rather than answered with a product compared against itself.
    assert.equal(commerce.calls.length, 0);
    assert.match(result.content, /at least 2 distinct skus/u);
  });
});

describe('recommendProducts', () => {
  it('does not recommend what cannot be bought', async () => {
    const products = [
      testProduct({ sku: 'A-1', name: 'wool walking socks', availability: 'out_of_stock' }),
      testProduct({ sku: 'B-1', name: 'wool walking hat', availability: 'in_stock' }),
    ];
    const { context, siteProfile } = contextFor({ commerce: createFakeCommerce({ products }) });

    const result = await toolNamed('recommendProducts', siteProfile).execute({
      arguments: { need: 'something wool for walking' },
      context,
    });

    assert.match(result.content, /B-1/u);
    assert.ok(!result.content.includes('A-1'));
  });

  it('says so plainly when everything matching is unavailable', async () => {
    const products = [testProduct({ sku: 'A-1', availability: 'out_of_stock' })];
    const { context, siteProfile } = contextFor({ commerce: createFakeCommerce({ products }) });

    const result = await toolNamed('recommendProducts', siteProfile).execute({
      arguments: { need: 'merino hoodie' },
      context,
    });

    assert.match(result.content, /Everything matching is currently unavailable/u);
  });

  it("gives a reason drawn from the store's own words", async () => {
    const { context, siteProfile } = contextFor();

    const result = await toolNamed('recommendProducts', siteProfile).execute({
      arguments: { need: 'merino jumper' },
      context,
    });

    assert.match(
      result.content,
      /- HD-MRN-NVY-L: it matches "merino" in the store's own description/u,
    );
  });

  it('tells the model not to substitute its own product when nothing matched', async () => {
    const { context, siteProfile } = contextFor({ commerce: createFakeCommerce({ products: [] }) });

    const result = await toolNamed('recommendProducts', siteProfile).execute({
      arguments: { need: 'a submarine' },
      context,
    });

    assert.match(result.content, /do not suggest a product that was not returned/u);
  });
});

describe('trackOrder', () => {
  it('takes no customer identifier at all', () => {
    const tool = toolNamed('trackOrder', testProfile(COMMERCE_FEATURES));
    const properties = Object.keys(
      /** @type {Record<string, unknown>} */ (tool.parameters.properties),
    );

    // The model chooses arguments, so any identity parameter is one it can be talked into changing.
    // Identity comes from the forwarded token and nowhere else.
    assert.deepEqual(properties, ['reference']);
  });

  it('returns no address, contact or payment detail', async () => {
    const { context, siteProfile } = contextFor();

    const result = await toolNamed('trackOrder', siteProfile).execute({ arguments: {}, context });

    assert.match(result.content, /Order ORD-100482/u);
    assert.match(result.content, /Status: Shipped/u);
    assert.match(result.content, /Never ask for or repeat an address/u);
  });

  it('matches a reference a customer typed with different separators', async () => {
    const { context, siteProfile } = contextFor();

    const result = await toolNamed('trackOrder', siteProfile).execute({
      arguments: { reference: 'ord 100482' },
      context,
    });

    assert.match(result.content, /Status: Shipped/u);
  });

  it('never logs the order reference', async () => {
    const { context, siteProfile, records } = contextFor();

    await toolNamed('trackOrder', siteProfile).execute({
      arguments: { reference: 'ORD-100482' },
      context,
    });

    const executed = records.find((entry) => entry.msg === 'trackOrder executed');

    assert.ok(executed);
    assert.equal(executed.narrowed, true);
    assert.ok(!JSON.stringify(executed).includes('100482'));
  });

  it('asks which order rather than guessing when the reference is unknown', async () => {
    const { context, siteProfile } = contextFor();

    const result = await toolNamed('trackOrder', siteProfile).execute({
      arguments: { reference: 'ORD-999999' },
      context,
    });

    assert.match(result.content, /No recent order matches ORD-999999/u);
    assert.match(result.content, /Ask which one they mean/u);
  });

  it('does not ask for personal details when there are no orders', async () => {
    const { context, siteProfile } = contextFor({ commerce: createFakeCommerce({ orders: [] }) });

    const result = await toolNamed('trackOrder', siteProfile).execute({ arguments: {}, context });

    assert.match(result.content, /do not ask them for personal details/u);
  });

  it("prefers the store's own status wording over the enum", async () => {
    const orders = [testOrder({ status: 'partially_shipped', statusLabel: 'Part-shipped' })];
    const { context, siteProfile } = contextFor({ commerce: createFakeCommerce({ orders }) });

    const result = await toolNamed('trackOrder', siteProfile).execute({ arguments: {}, context });

    assert.match(result.content, /Status: Part-shipped/u);
    assert.ok(!result.content.includes('partially_shipped'));
  });
});

describe('when the connector is unreachable', () => {
  it('fails the tool rather than the request, so the assistant can still answer', async () => {
    const commerce = createFakeCommerce({ failWith: new Error('ECONNREFUSED') });
    const { context, siteProfile } = contextFor({ commerce });

    // The tool itself throws; the tool loop is what turns that into a tool result the model reads.
    // Asserted here so the contract between the two stays explicit - see the loop's own tests for
    // the degradation itself.
    await assert.rejects(
      toolNamed('searchProducts', siteProfile).execute({ arguments: { query: 'x' }, context }),
      /ECONNREFUSED/u,
    );
  });

  it('names the misconfiguration when a commerce tool has no connector', async () => {
    const siteProfile = testProfile(COMMERCE_FEATURES);
    const context = {
      siteId: siteProfile.identity.siteId,
      siteProfile,
      retriever: createFakeRetriever(),
    };

    await assert.rejects(
      toolNamed('searchProducts', siteProfile).execute({ arguments: { query: 'x' }, context }),
      /MAGENTO_API_URL/u,
    );
  });
});
