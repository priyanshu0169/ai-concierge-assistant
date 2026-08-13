import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { toOrder, toPrice, toProduct } from '../src/wire/to-product.js';

const WIRE_PRODUCT = {
  sku: 'HD-MRN-NVY-L',
  name: 'Merino wool hoodie, navy, large',
  url: 'https://example.com/p/merino-hoodie',
  imageUrl: 'https://example.com/i/merino.jpg',
  summary: 'Mid-weight merino.',
  price: { formatted: '£120.00', amount: '120.00', currency: 'GBP', taxIncluded: true },
  availability: 'in_stock',
};

describe('mapping a product off the wire', () => {
  it('maps every field the contract defines', () => {
    assert.deepEqual(toProduct(WIRE_PRODUCT), WIRE_PRODUCT);
  });

  it('drops a product with no sku, name or url', () => {
    for (const missing of ['sku', 'name', 'url']) {
      assert.equal(toProduct({ ...WIRE_PRODUCT, [missing]: undefined }), undefined, missing);
    }
  });

  it('drops a product whose url is not something a customer can open', () => {
    // Checked here as well as in the widget. The widget's check is the safety one; this stops a
    // product with an unusable link being offered to the model, so the assistant never cites
    // something a customer cannot follow.
    const hostile = { ...WIRE_PRODUCT, url: 'javascript:alert(1)' };

    assert.equal(toProduct(hostile), undefined);
  });

  it('ignores an availability value the contract does not define', () => {
    const odd = toProduct({ ...WIRE_PRODUCT, availability: 'coming_soon' });

    // Absent rather than passed through. An unrecognised value reaching the prompt would invite the
    // model to interpret it, and availability is never inferred.
    assert.equal(odd?.availability, undefined);
  });

  it('never infers availability from anything else in the payload', () => {
    const silent = toProduct({ ...WIRE_PRODUCT, availability: undefined, price: undefined });

    assert.equal(silent?.availability, undefined);
  });

  it('survives a connector adding a field it has never seen', () => {
    const future = toProduct({ ...WIRE_PRODUCT, loyaltyPoints: 12, variants: [{ size: 'L' }] });

    assert.deepEqual(future, WIRE_PRODUCT);
  });

  it('survives nulls where the contract said optional', () => {
    const nulls = toProduct({ ...WIRE_PRODUCT, summary: null, imageUrl: null, price: null });

    assert.equal(nulls?.sku, 'HD-MRN-NVY-L');
    assert.equal(nulls?.summary, undefined);
    assert.equal(nulls?.price, undefined);
  });

  it('returns undefined rather than throwing for junk', () => {
    for (const junk of [undefined, null, 'a string', 42, []]) {
      assert.equal(toProduct(junk), undefined, String(junk));
    }
  });
});

describe('mapping money', () => {
  it('requires a formatted string, because that is the only field ever shown', () => {
    assert.equal(toPrice({ amount: '120.00', currency: 'GBP' }), undefined);
  });

  it('keeps the amount as a string and never parses it', () => {
    const price = toPrice({ formatted: '£120.00', amount: '120.00' });

    assert.equal(price?.amount, '120.00');
    assert.equal(typeof price?.amount, 'string');
  });

  it('carries an unstated tax treatment as absent, not as false', () => {
    // A store quoting ex-VAT figures to a consumer without saying so has a legal problem, and
    // neither ShopSage nor a model can infer which it is.
    assert.equal(toPrice({ formatted: '£120.00' })?.taxIncluded, undefined);
    assert.equal(toPrice({ formatted: '£120.00', taxIncluded: 'yes' })?.taxIncluded, undefined);
    assert.equal(toPrice({ formatted: '£120.00', taxIncluded: false })?.taxIncluded, false);
  });
});

describe('mapping an order', () => {
  it('maps only what a customer asks about', () => {
    const order = toOrder({
      reference: 'ORD-100482',
      status: 'shipped',
      statusLabel: 'Shipped',
      placedAt: '2026-07-14',
      estimatedDelivery: '2026-07-31',
      trackingUrl: 'https://example.com/track/ORD-100482',
      total: { formatted: '£144.00' },
      items: [{ name: 'Merino hoodie', quantity: 2, sku: 'HD-MRN-NVY-L' }],
    });

    assert.equal(order?.reference, 'ORD-100482');
    assert.equal(order?.items[0].quantity, 2);
  });

  it('drops personal data even when a connector volunteers it', () => {
    // The contract limits an order response to status, reference, delivery and tracking - but the
    // adapter does not rely on the connector honouring that. What is never mapped is never written
    // into conversation history.
    const order = toOrder({
      reference: 'ORD-100482',
      items: [],
      shippingAddress: { line1: '34 Bridge Street', postcode: 'SW1A 1AA' },
      customerEmail: 'sam@example.com',
      customerPhone: '07700900123',
      payment: { cardLast4: '4242', method: 'visa' },
    });

    assert.deepEqual(Object.keys(/** @type {object} */ (order)), ['reference', 'items']);
    assert.ok(!JSON.stringify(order).includes('Bridge Street'));
    assert.ok(!JSON.stringify(order).includes('sam@example.com'));
    assert.ok(!JSON.stringify(order).includes('4242'));
  });

  it('defaults an unusable quantity to one rather than dropping the item', () => {
    const order = toOrder({ reference: 'R-1', items: [{ name: 'Hoodie', quantity: 'two' }] });

    assert.equal(order?.items[0].quantity, 1);
  });

  it('drops an item with no name and keeps the rest of the order', () => {
    const order = toOrder({ reference: 'R-1', items: [{ quantity: 1 }, { name: 'Hoodie' }] });

    assert.equal(order?.items.length, 1);
  });

  it('treats a missing items array as empty', () => {
    assert.deepEqual(toOrder({ reference: 'R-1' })?.items, []);
  });
});
