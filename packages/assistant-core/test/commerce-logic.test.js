import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { compareProducts } from '../src/commerce/compare-products.js';
import { rankRecommendations } from '../src/commerce/rank-recommendations.js';
import { byPrice, comparableByPrice } from '../src/tools/commerce-context.js';
import { testProduct } from './helpers/domain-doubles.js';

/**
 * @param {string} sku
 * @param {string | undefined} amount
 * @param {Partial<import('../src/types.js').Product>} [rest]
 */
function priced(sku, amount, rest = {}) {
  return testProduct({
    sku,
    ...(amount === undefined
      ? { price: undefined }
      : { price: { formatted: `£${amount}`, amount, currency: 'GBP', taxIncluded: true } }),
    ...rest,
  });
}

describe('ordering by price without doing arithmetic on it', () => {
  it('orders by numeric value, not by string order', () => {
    // The trap: "9.00" > "10.00" lexicographically. A naive sort puts the dearer item first.
    const sorted = [priced('a', '10.00'), priced('b', '9.00')].sort(byPrice);

    assert.deepEqual(
      sorted.map((product) => product.sku),
      ['b', 'a'],
    );
  });

  it('compares fractions of differing width correctly', () => {
    const sorted = [priced('a', '10.5'), priced('b', '10.05'), priced('c', '10.50')].sort(byPrice);

    assert.equal(sorted[0].sku, 'b');
    // 10.5 and 10.50 are the same value, so their relative order is unchanged.
    assert.deepEqual(
      sorted.slice(1).map((product) => product.sku),
      ['a', 'c'],
    );
  });

  it('never converts an amount to a number', () => {
    // 0.1 + 0.2 territory. Exactness here is the reason the comparison works on strings: a store
    // with prices that differ in the third decimal must still sort correctly.
    const sorted = [priced('a', '1.005'), priced('b', '1.004')].sort(byPrice);

    assert.deepEqual(
      sorted.map((product) => product.sku),
      ['b', 'a'],
    );
  });

  it('sorts a product with no usable price last, never first', () => {
    // Otherwise a product the store did not price would present itself as the cheapest option.
    const sorted = [priced('a', undefined), priced('b', '9.00')].sort(byPrice);

    assert.deepEqual(
      sorted.map((product) => product.sku),
      ['b', 'a'],
    );
  });

  it('refuses to order across currencies', () => {
    const euro = testProduct({
      sku: 'e',
      price: { formatted: '€9,00', amount: '9.00', currency: 'EUR' },
    });

    // No exchange rate exists that ShopSage is entitled to guess at, so "cheapest" would be invented.
    assert.equal(comparableByPrice([priced('a', '10.00'), euro]), false);
  });

  it('refuses to order when an amount is missing or not a decimal', () => {
    assert.equal(comparableByPrice([priced('a', '10.00'), priced('b', undefined)]), false);
    assert.equal(comparableByPrice([priced('a', '10.00'), priced('b', 'about ten')]), false);
  });
});

describe('comparing products', () => {
  it('separates what is shared from what differs', () => {
    const comparison = compareProducts([
      priced('a', '10.00', { availability: 'in_stock' }),
      priced('b', '20.00', { availability: 'in_stock' }),
    ]);

    assert.deepEqual(comparison.differing, ['Price']);
    assert.ok(comparison.shared.some((line) => line.startsWith('Availability: in_stock')));
    assert.equal(comparison.ordered, true);
  });

  it('names an axis no product stated, rather than leaving it out', () => {
    const comparison = compareProducts([
      priced('a', '10.00', { availability: undefined }),
      priced('b', '20.00', { availability: undefined }),
    ]);

    // Stated so the model does not fill it in. "The store did not say" is a legitimate sentence.
    assert.deepEqual(comparison.unknown, ['Availability']);
  });

  it('treats a stated tax treatment and a silent one as different', () => {
    const silent = testProduct({
      sku: 'b',
      price: { formatted: '£20.00', amount: '20.00', currency: 'GBP' },
    });
    const comparison = compareProducts([priced('a', '10.00'), silent]);

    // A product marked tax-inclusive and one that says nothing do not agree, and must not look
    // like they do.
    assert.ok(comparison.differing.includes('Tax treatment'));
  });

  it("leaves the connector's order alone when price cannot order it", () => {
    const comparison = compareProducts([priced('a', undefined), priced('b', '9.00')]);

    assert.equal(comparison.ordered, false);
    assert.deepEqual(
      comparison.products.map((product) => product.sku),
      ['a', 'b'],
    );
  });
});

describe('choosing a shortlist to recommend', () => {
  it('drops what cannot be bought', () => {
    const shortlist = rankRecommendations({
      query: 'wool socks',
      candidates: [
        testProduct({ sku: 'gone', name: 'wool socks', availability: 'out_of_stock' }),
        testProduct({ sku: 'here', name: 'wool socks thick', availability: 'in_stock' }),
      ],
      limit: 3,
    });

    assert.deepEqual(
      shortlist.map((entry) => entry.product.sku),
      ['here'],
    );
  });

  it('falls back to the unbuyable set rather than returning nothing', () => {
    // "Everything matching is out of stock" is a useful answer. "We do not sell that" is not the
    // same statement and would be false.
    const shortlist = rankRecommendations({
      query: 'wool socks',
      candidates: [testProduct({ sku: 'gone', name: 'wool socks', availability: 'out_of_stock' })],
      limit: 3,
    });

    assert.equal(shortlist.length, 1);
  });

  it("ranks by how much of the query the store's own words cover", () => {
    const shortlist = rankRecommendations({
      query: 'thick wool walking socks',
      candidates: [
        testProduct({ sku: 'weak', name: 'cotton socks', summary: '' }),
        testProduct({ sku: 'strong', name: 'thick wool walking socks', summary: '' }),
      ],
      limit: 2,
    });

    assert.equal(shortlist[0].product.sku, 'strong');
  });

  it('spans the price range instead of taking the top three', () => {
    const candidates = [
      priced('mid-1', '50.00', { name: 'wool socks a' }),
      priced('mid-2', '52.00', { name: 'wool socks b' }),
      priced('cheap', '5.00', { name: 'wool socks c' }),
      priced('dear', '500.00', { name: 'wool socks d' }),
    ];

    const shortlist = rankRecommendations({ query: 'wool socks', candidates, limit: 3 });
    const skus = shortlist.map((entry) => entry.product.sku);

    // A customer weighing up options is answered by a spread, not by three near-identical prices.
    assert.ok(skus.includes('cheap'), skus.join(','));
    assert.ok(skus.includes('dear'), skus.join(','));
  });

  it('returns the shortlist in relevance order, not price order', () => {
    const candidates = [
      priced('a', '500.00', { name: 'thick wool walking socks' }),
      priced('b', '50.00', { name: 'wool socks' }),
      priced('c', '5.00', { name: 'socks' }),
      priced('d', '9.00', { name: 'cotton vest' }),
    ];

    const shortlist = rankRecommendations({
      query: 'thick wool walking socks',
      candidates,
      limit: 3,
    });

    assert.equal(shortlist[0].product.sku, 'a');
  });

  it('gives a reason that restates the data rather than judging it', () => {
    const shortlist = rankRecommendations({
      query: 'merino jumper',
      candidates: [testProduct()],
      limit: 3,
    });

    assert.match(shortlist[0].reason, /matches "merino" in the store's own description/u);
    // Nothing here may claim quality, popularity or suitability - none of it is in the data, and a
    // fabricated reason is indistinguishable from a real one to the person reading it.
    assert.ok(!/best|popular|recommend|ideal|perfect/iu.test(shortlist[0].reason));
  });

  it('falls back to a truthful weaker reason when nothing matched by words', () => {
    const shortlist = rankRecommendations({
      query: 'xyzzy',
      candidates: [testProduct({ availability: 'in_stock' })],
      limit: 3,
    });

    // Phrased to read after "it ", so the tool can put it in a sentence without the model having to
    // repair the grammar.
    assert.equal(shortlist[0].reason, 'is listed in stock in this category');
  });

  it('returns nothing for an empty candidate set', () => {
    assert.deepEqual(rankRecommendations({ query: 'anything', candidates: [], limit: 3 }), []);
  });
});
