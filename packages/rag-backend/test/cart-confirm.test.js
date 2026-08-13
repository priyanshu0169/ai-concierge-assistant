import assert from 'node:assert/strict';
import { createMemoryProposalStore } from '@shopsage/assistant-core';
import { after, before, describe, it } from 'node:test';
import { createApp } from '../src/app.js';
import { createHealthService } from '../src/health/health-service.js';
import { readJson, startTestServer } from './helpers/start-test-server.js';
import {
  buildTestConfig,
  createSilentLogger,
  createStubAssistant,
  createStubAuthentication,
} from './helpers/test-doubles.js';

/** @param {{ applied?: boolean, message?: string, failWith?: Error }} [options] */
function createStubCart(options = {}) {
  /** @type {any[]} */
  const calls = [];

  /** @param {string} method @param {any} input */
  const record = (method, input) => {
    calls.push({ method, ...input });

    if (options.failWith !== undefined) return Promise.reject(options.failWith);

    return Promise.resolve({
      applied: options.applied ?? true,
      ...(options.message === undefined ? {} : { message: options.message }),
      itemCount: 2,
      total: { formatted: '£178.00' },
      cartUrl: 'https://store.example.com/checkout/cart',
    });
  };

  return {
    calls,
    addToCart: (/** @type {any} */ input) => record('addToCart', input),
    applyCoupon: (/** @type {any} */ input) => record('applyCoupon', input),
  };
}

/**
 * @param {Partial<any>} [overrides]
 * @returns {import('@shopsage/assistant-core').CartProposal}
 */
function testProposal(overrides = {}) {
  return {
    id: 'cp_0123456789abcdef0123456789abcdef',
    kind: /** @type {const} */ ('addToCart'),
    siteId: 'test-store',
    conversationId: 'c_1',
    subject: 'ps_test',
    summary: '2 × Merino hoodie',
    expiresAt: new Date(Date.now() + 600_000).toISOString(),
    lines: [{ sku: 'HD-MRN-NVY-L', name: 'Merino hoodie', quantity: 2 }],
    ...overrides,
  };
}

/**
 * @param {{ scopes?: string[], cart?: any, mountCart?: boolean }} [options]
 */
function buildCartApp(options = {}) {
  const config = buildTestConfig({
    env: { RATE_LIMIT_ENABLED: 'false' },
    features: { cart: true, coupons: true },
  });
  const proposals = createMemoryProposalStore();
  const cart = options.cart ?? createStubCart();

  const app = createApp({
    config,
    logger: createSilentLogger(),
    healthService: createHealthService({ serviceName: 'test', version: '0.1.0-test' }),
    assistant: createStubAssistant(),
    authentication: createStubAuthentication({ scopes: options.scopes ?? ['chat', 'cart'] }),
    ...(options.mountCart === false ? {} : { cart: { proposals, cart } }),
  });

  return { app, proposals, cart };
}

/**
 * @param {import('./helpers/start-test-server.js').TestServer} server
 * @param {unknown} body
 */
function postConfirm(server, body) {
  return server.request('/v1/cart/confirm', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

describe('POST /v1/cart/confirm', () => {
  /** @type {import('./helpers/start-test-server.js').TestServer} */
  let server;
  /** @type {ReturnType<typeof createMemoryProposalStore>} */
  let proposals;
  /** @type {ReturnType<typeof createStubCart>} */
  let cart;

  before(async () => {
    const built = buildCartApp();

    proposals = built.proposals;
    cart = built.cart;
    server = await startTestServer(built.app);
  });

  after(() => server?.close());

  it('executes a proposal it holds', async () => {
    const proposal = testProposal();

    await proposals.save(proposal);

    const response = await postConfirm(server, { proposalId: proposal.id });
    const body = await readJson(response);

    assert.equal(response.status, 200);
    assert.equal(body.status, 'applied');
    assert.equal(cart.calls.at(-1).method, 'addToCart');
  });

  it("publishes the connector's total as a string, never a computed one", async () => {
    const proposal = testProposal({ id: 'cp_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' });

    await proposals.save(proposal);

    const body = await readJson(await postConfirm(server, { proposalId: proposal.id }));

    // A widget rendering a total it derived from line prices is the same failure as a model doing the
    // arithmetic, one layer further out.
    assert.equal(body.cart.total, '£178.00');
    assert.equal(body.cart.itemCount, 2);
  });

  it('answers a second confirmation with 200 and gone', async () => {
    const proposal = testProposal({ id: 'cp_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb' });

    await proposals.save(proposal);
    await postConfirm(server, { proposalId: proposal.id });

    const response = await postConfirm(server, { proposalId: proposal.id });
    const body = await readJson(response);

    // Not a 404: "that has expired" is an answer to a question the customer asked by clicking, not an
    // error to retry - and a 404 would confirm to a stranger that the id was once real.
    assert.equal(response.status, 200);
    assert.equal(body.status, 'gone');
  });

  it('rejects a malformed proposal id before any lookup', async () => {
    for (const proposalId of ['nope', 'cp_short', '../etc/passwd', 'cp_' + 'z'.repeat(32)]) {
      const response = await postConfirm(server, { proposalId });

      assert.equal(response.status, 400, proposalId);
    }
  });

  it('rejects unknown fields', async () => {
    const response = await postConfirm(server, {
      proposalId: testProposal().id,
      subject: 'ps_somebody_else',
    });

    // The one field a caller must not be able to supply. Accepting it would make the ownership check
    // decorative.
    assert.equal(response.status, 400);
  });

  it('answers gone for a proposal belonging to another session', async () => {
    const proposal = testProposal({
      id: 'cp_cccccccccccccccccccccccccccccccc',
      subject: 'ps_somebody_else',
    });

    await proposals.save(proposal);

    const body = await readJson(await postConfirm(server, { proposalId: proposal.id }));

    assert.equal(body.status, 'gone');
  });
});

describe('when the session may not confirm', () => {
  it('refuses a session without the cart scope', async () => {
    const built = buildCartApp({ scopes: ['chat'] });
    const server = await startTestServer(built.app);

    try {
      const response = await postConfirm(server, { proposalId: testProposal().id });
      const body = await readJson(response);

      // 403, not 404: this says nothing about whether any particular id exists. The session simply may
      // not confirm carts, which is true whatever it asked for.
      assert.equal(response.status, 403);
      assert.equal(body.error.code, 'FORBIDDEN');
    } finally {
      await server.close();
    }
  });
});

describe('when the store has no cart feature', () => {
  it('does not mount the route at all', async () => {
    const built = buildCartApp({ mountCart: false });
    const server = await startTestServer(built.app);

    try {
      const response = await postConfirm(server, { proposalId: testProposal().id });

      // A 404 from an unmounted route is honest - "this deployment does not do that" - where a 403 from
      // a mounted one would advertise a capability nobody configured.
      assert.equal(response.status, 404);
    } finally {
      await server.close();
    }
  });
});

describe('when the connector refuses or fails', () => {
  it("reports a refusal as rejected, with the store's wording", async () => {
    const built = buildCartApp({
      cart: createStubCart({ applied: false, message: 'That code has expired.' }),
    });
    const server = await startTestServer(built.app);

    try {
      const proposal = testProposal({ kind: 'applyCoupon', code: 'OLD', lines: undefined });

      await built.proposals.save(proposal);

      const response = await postConfirm(server, { proposalId: proposal.id });
      const body = await readJson(response);

      assert.equal(response.status, 200);
      assert.equal(body.status, 'rejected');
      assert.equal(body.message, 'That code has expired.');
    } finally {
      await server.close();
    }
  });

  it('surfaces a connector failure as an error, not as a refusal', async () => {
    const built = buildCartApp({ cart: createStubCart({ failWith: new Error('ECONNREFUSED') }) });
    const server = await startTestServer(built.app);

    try {
      const proposal = testProposal();

      await built.proposals.save(proposal);

      const response = await postConfirm(server, { proposalId: proposal.id });

      // Unlike a chat turn, this is **not** degraded into a friendly answer. A write may have partially
      // happened, and "we could not apply it" would be a claim nobody can support - so the client is
      // told the request failed and tells the customer to check their basket.
      assert.ok(response.status >= 500, String(response.status));
    } finally {
      await server.close();
    }
  });
});
