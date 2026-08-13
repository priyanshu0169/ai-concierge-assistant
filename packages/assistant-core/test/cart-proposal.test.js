import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { confirmCartProposal } from '../src/commerce/confirm-cart-proposal.js';
import { createCartProposal, isLive } from '../src/commerce/create-cart-proposal.js';
import { createMemoryProposalStore } from '../src/conversation/memory-proposal-store.js';
import { createToolRegistry } from '../src/tools/tool-registry.js';
import {
  createFakeCommerce,
  createFakeRetriever,
  createRecordingLogger,
  testProduct,
  testProfile,
} from './helpers/domain-doubles.js';

const CART_FEATURES = { features: { productSearch: true, cart: true, coupons: true } };

/** @param {Partial<import('../src/types.js').CartProposal>} [overrides] */
function testProposal(overrides = {}) {
  return {
    ...createCartProposal({
      kind: 'addToCart',
      siteId: 'demo-store',
      conversationId: 'c_1',
      subject: 'ps_customer',
      summary: '1 × Merino hoodie',
      now: Date.now(),
      lines: [{ sku: 'HD-MRN-NVY-L', name: 'Merino hoodie', quantity: 1 }],
    }),
    ...overrides,
  };
}

/** @param {{ applied?: boolean, message?: string, failWith?: Error }} [options] */
function createFakeCart(options = {}) {
  /** @type {any[]} */
  const calls = [];

  /** @param {string} method @param {any} input */
  const record = (method, input) => {
    calls.push({ method, ...input });

    if (options.failWith !== undefined) return Promise.reject(options.failWith);

    return Promise.resolve({
      applied: options.applied ?? true,
      ...(options.message === undefined ? {} : { message: options.message }),
      total: { formatted: '£89.00' },
    });
  };

  return {
    calls,
    addToCart: (/** @type {any} */ input) => record('addToCart', input),
    applyCoupon: (/** @type {any} */ input) => record('applyCoupon', input),
  };
}

/**
 * @param {{ commerce?: any, credential?: string, subject?: string }} [options]
 */
function contextFor(options = {}) {
  const siteProfile = testProfile(CART_FEATURES);
  const { logger, records } = createRecordingLogger();

  return {
    records,
    siteProfile,
    context: {
      siteId: siteProfile.identity.siteId,
      siteProfile,
      retriever: createFakeRetriever(),
      commerce: options.commerce ?? createFakeCommerce(),
      conversationId: 'c_1',
      subject: options.subject ?? 'ps_customer',
      logger,
      ...(options.credential === undefined ? {} : { credential: options.credential }),
    },
  };
}

/** @param {string} name @param {import('@shopsage/platform').SiteProfile} siteProfile */
function toolNamed(name, siteProfile) {
  const tool = createToolRegistry(siteProfile).find(name);

  assert.ok(tool, `${name} should be registered`);

  return tool;
}

describe('which sessions are offered a cart tool', () => {
  it('withholds both from a session without the cart scope', () => {
    const names = createToolRegistry(testProfile(CART_FEATURES), ['chat']).tools.map((t) => t.name);

    assert.ok(!names.includes('addToCart'));
    assert.ok(!names.includes('applyCoupon'));
    assert.ok(names.includes('searchProducts'));
  });

  it('grants them to a session that holds it', () => {
    const names = createToolRegistry(testProfile(CART_FEATURES), ['chat', 'cart']).tools.map(
      (t) => t.name,
    );

    assert.ok(names.includes('addToCart'));
    assert.ok(names.includes('applyCoupon'));
  });
});

describe('addToCart prepares and never adds', () => {
  it('returns a proposal rather than touching a cart', async () => {
    const { context, siteProfile } = contextFor();

    const result = await toolNamed('addToCart', siteProfile).execute({
      arguments: { items: [{ sku: 'HD-MRN-NVY-L', quantity: 2 }] },
      context,
    });

    assert.ok(result.proposal);
    assert.equal(result.proposal.kind, 'addToCart');
    assert.equal(result.proposal.lines?.[0].quantity, 2);
    // The tool has no write port at all, so there is nothing here that *could* have committed.
    assert.equal('cart' in context, false);
  });

  it('re-reads every sku from the connector before proposing', async () => {
    const commerce = createFakeCommerce();
    const { context, siteProfile } = contextFor({ commerce, credential: 'session.token.value' });

    await toolNamed('addToCart', siteProfile).execute({
      arguments: { items: [{ sku: 'HD-MRN-NVY-L', quantity: 1 }] },
      context,
    });

    // A model naming a product from memory would otherwise put an unverified line, at a price nobody
    // checked, in front of somebody to approve.
    assert.equal(commerce.calls[0].method, 'findProduct');
    assert.equal(commerce.calls[0].credential, 'session.token.value');
  });

  it("names the connector's product, not the model's phrasing", async () => {
    const { context, siteProfile } = contextFor();

    const result = await toolNamed('addToCart', siteProfile).execute({
      arguments: { items: [{ sku: 'HD-MRN-NVY-L', quantity: 1 }] },
      context,
    });

    assert.equal(result.proposal?.lines?.[0].name, 'Merino wool hoodie, navy, large');
  });

  it('tells the model not to claim the item is in the basket', async () => {
    const { context, siteProfile } = contextFor();

    const result = await toolNamed('addToCart', siteProfile).execute({
      arguments: { items: [{ sku: 'HD-MRN-NVY-L', quantity: 1 }] },
      context,
    });

    assert.match(result.content, /Prepared, and \*\*not\*\* added/u);
    assert.match(result.content, /Do not say the item is in their basket/u);
  });

  it('prepares nothing when no product could be found', async () => {
    const { context, siteProfile } = contextFor({ commerce: createFakeCommerce({ products: [] }) });

    const result = await toolNamed('addToCart', siteProfile).execute({
      arguments: { items: [{ sku: 'GONE-1', quantity: 1 }] },
      context,
    });

    assert.equal(result.proposal, undefined);
    assert.match(result.content, /Nothing was prepared/u);
  });

  it('caps the quantity and defaults a nonsensical one to one', async () => {
    const products = [testProduct({ sku: 'A-1' }), testProduct({ sku: 'B-1' })];
    const { context, siteProfile } = contextFor({ commerce: createFakeCommerce({ products }) });

    const result = await toolNamed('addToCart', siteProfile).execute({
      arguments: {
        items: [
          { sku: 'A-1', quantity: 500 },
          { sku: 'B-1', quantity: 'lots' },
        ],
      },
      context,
    });

    assert.equal(result.proposal?.lines?.[0].quantity, 10);
    // One is what a customer means by "add it", and it is the choice that cannot surprise anybody.
    assert.equal(result.proposal?.lines?.[1].quantity, 1);
  });

  it('expires in minutes, not hours', () => {
    const proposal = testProposal();
    const life = Date.parse(proposal.expiresAt) - Date.now();

    // A proposal shows a price. Confirming an hour-old one against a repriced catalogue is the surprise
    // this whole workflow exists to prevent.
    assert.ok(life <= 10 * 60_000, `${life}ms`);
    assert.ok(life > 8 * 60_000, `${life}ms`);
  });
});

describe('applyCoupon claims nothing about the code', () => {
  it('prepares without asking the connector anything', async () => {
    const commerce = createFakeCommerce();
    const { context, siteProfile } = contextFor({ commerce });

    const result = await toolNamed('applyCoupon', siteProfile).execute({
      arguments: { code: 'SAGE10' },
      context,
    });

    // Validity is only knowable by applying it, which is what the customer has not agreed to yet.
    assert.equal(commerce.calls.length, 0);
    assert.equal(result.proposal?.code, 'SAGE10');
  });

  it('forbids saying whether the code is valid or what it is worth', async () => {
    const { context, siteProfile } = contextFor();

    const result = await toolNamed('applyCoupon', siteProfile).execute({
      arguments: { code: 'SAGE10' },
      context,
    });

    assert.match(result.content, /You do not know whether this code is valid/u);
    assert.match(result.content, /what the new total would be/u);
  });

  it('never logs the code', async () => {
    const { context, siteProfile, records } = contextFor();

    await toolNamed('applyCoupon', siteProfile).execute({
      arguments: { code: 'SECRET50' },
      context,
    });

    // A working promotional code is worth something, and a log outlives the conversation.
    assert.ok(!JSON.stringify(records).includes('SECRET50'));
  });

  it('refuses a code that is not shaped like one', async () => {
    const { context, siteProfile } = contextFor();

    for (const code of ['', '   ', 'has space', 'a'.repeat(80), '../../etc']) {
      const result = await toolNamed('applyCoupon', siteProfile).execute({
        arguments: { code },
        context,
      });

      assert.equal(result.proposal, undefined, JSON.stringify(code));
    }
  });

  it('judges shape only, never plausibility', async () => {
    const { context, siteProfile } = contextFor();

    // Whether a code means anything is Magento's to answer. Rejecting an odd-looking one here would be
    // ShopSage inventing a rule about somebody else's promotions.
    const result = await toolNamed('applyCoupon', siteProfile).execute({
      arguments: { code: 'ZZZ_NOT_A_REAL_CODE_999' },
      context,
    });

    assert.ok(result.proposal);
  });
});

describe('the proposal store takes once', () => {
  it('returns a saved proposal exactly once', async () => {
    const store = createMemoryProposalStore();
    const proposal = testProposal();

    await store.save(proposal);

    assert.equal((await store.consume({ siteId: 'demo-store', id: proposal.id }))?.id, proposal.id);
    // The second read is what a double-tapped confirm button looks like.
    assert.equal(await store.consume({ siteId: 'demo-store', id: proposal.id }), undefined);
  });

  it("will not serve one store's proposal to another", async () => {
    const store = createMemoryProposalStore();
    const proposal = testProposal();

    await store.save(proposal);

    assert.equal(await store.consume({ siteId: 'other-store', id: proposal.id }), undefined);
  });

  it('does not return an expired proposal, and consumes it anyway', async () => {
    let clock = Date.parse('2026-08-04T10:00:00.000Z');
    const store = createMemoryProposalStore({ now: () => clock });
    const proposal = testProposal({ expiresAt: '2026-08-04T10:05:00.000Z' });

    await store.save(proposal);
    clock = Date.parse('2026-08-04T10:06:00.000Z');

    assert.equal(await store.consume({ siteId: 'demo-store', id: proposal.id }), undefined);
  });

  it('sweeps expired proposals on write rather than on a timer', async () => {
    let clock = Date.parse('2026-08-04T10:00:00.000Z');
    const store = createMemoryProposalStore({ now: () => clock });
    const stale = testProposal({ id: 'cp_stale', expiresAt: '2026-08-04T10:01:00.000Z' });

    await store.save(stale);
    clock = Date.parse('2026-08-04T10:02:00.000Z');
    await store.save(testProposal({ id: 'cp_fresh' }));

    assert.equal(await store.consume({ siteId: 'demo-store', id: 'cp_stale' }), undefined);
  });

  it('warns in production, because a second replica breaks the button', () => {
    const { logger, records } = createRecordingLogger();

    createMemoryProposalStore({ logger, isProduction: true });

    const warning = records.find((entry) => entry.level === 'warn');

    assert.ok(warning);
    assert.match(warning.remediation, /CONVERSATION_STORE=redis/u);
  });
});

describe('confirming a proposal', () => {
  /** @param {{ proposal?: any, subject?: string, cart?: any }} [options] */
  const setup = async (options = {}) => {
    const store = createMemoryProposalStore();
    const proposal = options.proposal ?? testProposal();
    const cart = options.cart ?? createFakeCart();
    const { logger, records } = createRecordingLogger();

    await store.save(proposal);

    return {
      cart,
      records,
      proposal,
      confirm: () =>
        confirmCartProposal({
          proposals: store,
          cart,
          siteId: 'demo-store',
          proposalId: proposal.id,
          subject: options.subject ?? 'ps_customer',
          logger,
        }),
    };
  };

  it("executes once and reports the store's own wording", async () => {
    const { confirm, cart } = await setup({
      cart: createFakeCart({ message: 'Added to your basket.' }),
    });

    const result = await confirm();

    assert.equal(result.status, 'applied');
    assert.equal(result.message, 'Added to your basket.');
    assert.equal(cart.calls.length, 1);
  });

  it('refuses a second confirmation without touching the cart again', async () => {
    const { confirm, cart } = await setup();

    await confirm();
    const second = await confirm();

    // The take-once consume is what makes a double-tapped button safe, and it happens before anything
    // reaches the connector.
    assert.equal(second.status, 'gone');
    assert.equal(cart.calls.length, 1);
  });

  it('leaves the proposal usable by its owner after a stranger tries', async () => {
    const store = createMemoryProposalStore();
    const proposal = testProposal();
    const cart = createFakeCart();

    await store.save(proposal);

    /** @param {string} subject */
    const attempt = (subject) =>
      confirmCartProposal({
        proposals: store,
        cart,
        siteId: 'demo-store',
        proposalId: proposal.id,
        subject,
      });

    // Real finding, from running two sessions against the stack: the consume is unconditional, so the
    // wrong session's refused attempt left the right one unable to confirm its own change. A stranger
    // holding an id could destroy it without being able to use it.
    assert.equal((await attempt('ps_somebody_else')).status, 'gone');
    assert.equal((await attempt('ps_customer')).status, 'applied');
    assert.equal(cart.calls.length, 1);
  });

  it('does not restore an expired proposal, which is finished either way', async () => {
    const store = createMemoryProposalStore();
    const proposal = testProposal({ expiresAt: '2020-01-01T00:00:00.000Z' });

    await store.save(proposal);
    await confirmCartProposal({
      proposals: store,
      cart: createFakeCart(),
      siteId: 'demo-store',
      proposalId: proposal.id,
      subject: 'ps_somebody_else',
    });

    assert.equal(await store.consume({ siteId: 'demo-store', id: proposal.id }), undefined);
  });

  it('refuses a confirmation from a different session', async () => {
    const { confirm, cart } = await setup({ subject: 'ps_somebody_else' });

    const result = await confirm();

    // A proposal id in a screenshot or a log must not let anybody else alter that cart.
    assert.equal(result.status, 'gone');
    assert.equal(cart.calls.length, 0);
  });

  it("gives an expired proposal and a stranger's the same answer", async () => {
    const expired = await setup({
      proposal: testProposal({ expiresAt: '2020-01-01T00:00:00.000Z' }),
    });
    const stranger = await setup({ subject: 'ps_somebody_else' });

    // Identical, deliberately: a stranger holding a guessed id learns only that it did not work, not
    // whether it ever existed or whose it was.
    assert.deepEqual(await expired.confirm(), await stranger.confirm());
  });

  it('records why it refused, without saying whose it was', async () => {
    const { confirm, records } = await setup({ subject: 'ps_somebody_else' });

    await confirm();

    const refusal = records.find((entry) => entry.msg === 'a cart confirmation was refused');

    assert.ok(refusal);
    assert.equal(refusal.reason, 'subject mismatch');
    assert.ok(!JSON.stringify(refusal).includes('ps_customer'));
  });

  it('sends the same idempotency key for the same proposal', async () => {
    const first = await setup();
    const second = await setup({ proposal: first.proposal });

    await first.confirm();
    await second.confirm();

    // Derived rather than random: two attempts at the same confirmation must carry the same key or a
    // connector cannot recognise the repeat.
    assert.equal(first.cart.calls[0].idempotencyKey, second.cart.calls[0].idempotencyKey);
  });

  it('never sends the proposal id as the idempotency key', async () => {
    const { confirm, cart, proposal } = await setup();

    await confirm();

    // The id is a bearer token. A connector logging its idempotency keys - a normal thing to do - would
    // otherwise be writing confirmation tokens into its logs.
    assert.notEqual(cart.calls[0].idempotencyKey, proposal.id);
    assert.ok(!cart.calls[0].idempotencyKey.includes(proposal.id.slice(3)));
  });

  it('sends only sku and quantity, never the price it quoted', async () => {
    const { confirm, cart } = await setup();

    await confirm();

    assert.deepEqual(cart.calls[0].lines[0].sku, 'HD-MRN-NVY-L');
    // The connector is the authority on what things cost; sending a price would invite it to trust
    // ShopSage's copy of one.
    const sent = JSON.stringify(cart.calls[0].lines);

    assert.ok(!sent.includes('formatted'));
  });

  it('reports a store refusal as rejected, not as an error', async () => {
    const { confirm } = await setup({
      cart: createFakeCart({ applied: false, message: 'That code has expired.' }),
    });

    const result = await confirm();

    assert.equal(result.status, 'rejected');
    assert.equal(result.message, 'That code has expired.');
  });

  it('does not invent a reason when the connector gave none', async () => {
    const { confirm } = await setup({ cart: createFakeCart({ applied: false }) });

    const result = await confirm();

    // "It did not apply" is true. "The code is invalid" might not be.
    assert.match(result.message, /could not be applied/u);
  });

  it('applies a coupon through the coupon method', async () => {
    const coupon = testProposal({ kind: 'applyCoupon', code: 'SAGE10', lines: undefined });
    const { confirm, cart } = await setup({ proposal: coupon });

    await confirm();

    assert.equal(cart.calls[0].method, 'applyCoupon');
    assert.equal(cart.calls[0].code, 'SAGE10');
  });

  it('refuses a stored proposal whose kind and payload disagree', async () => {
    const broken = testProposal({ kind: 'applyCoupon', code: undefined, lines: undefined });
    const { confirm, cart } = await setup({ proposal: broken });

    // Unreachable through the tools, so reaching it means a format changed or an entry was tampered
    // with - and acting on a half-understood basket instruction is worse than doing nothing.
    await assert.rejects(confirm(), /no payload for kind/u);
    assert.equal(cart.calls.length, 0);
  });
});

describe('isLive', () => {
  it('is false at the moment of expiry, not after a grace period', () => {
    const at = Date.parse('2026-08-04T10:00:00.000Z');

    assert.equal(isLive({ expiresAt: '2026-08-04T10:00:00.000Z' }, at), false);
    assert.equal(isLive({ expiresAt: '2026-08-04T10:00:00.001Z' }, at), true);
  });
});
