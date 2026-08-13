import assert from 'node:assert/strict';
import { UpstreamError } from '@shopsage/platform';
import { describe, it } from 'node:test';
import { createRedisProposalStore } from '../src/redis/create-redis-proposal-store.js';
import { createFakeRedis } from './helpers/fake-redis.js';

/** @param {Parameters<typeof createFakeRedis>[0]} [redisOptions] */
function build(redisOptions) {
  const redis = createFakeRedis(redisOptions);

  return {
    redis,
    store: createRedisProposalStore({
      url: 'redis://localhost:6379',
      clientFactory: () => /** @type {any} */ (redis),
    }),
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
    siteId: 'demo-store',
    conversationId: 'c_1',
    subject: 'ps_customer',
    summary: '1 × Merino hoodie',
    expiresAt: new Date(Date.now() + 600_000).toISOString(),
    lines: [{ sku: 'HD-MRN-NVY-L', name: 'Merino hoodie', quantity: 1 }],
    ...overrides,
  };
}

describe('storing a proposal', () => {
  it("keys by site, so one store cannot read another's", async () => {
    const { store, redis } = build();
    const proposal = testProposal();

    await store.save(proposal);

    assert.ok(redis.values.has(`shopsage:proposal:demo-store:${proposal.id}`));
    assert.equal(await store.consume({ siteId: 'other-store', id: proposal.id }), undefined);
  });

  it("derives the TTL from the proposal's own expiry", async () => {
    const { store, redis } = build();
    const proposal = testProposal({ expiresAt: new Date(Date.now() + 300_000).toISOString() });

    await store.save(proposal);

    const ttl = redis.ttls.get(`shopsage:proposal:demo-store:${proposal.id}`);

    // Not a configured number: a proposal that expires at a stated time and lingers past it in storage
    // is a contradiction the code should not be able to express.
    assert.ok(ttl !== undefined && ttl > 290 && ttl <= 300, String(ttl));
  });

  it('stores nothing for an already-expired proposal', async () => {
    const { store, redis } = build();

    await store.save(testProposal({ expiresAt: new Date(Date.now() - 1000).toISOString() }));

    // Redis rejects a non-positive `EX`, and a one-second floor would create a confirmation button that
    // is dead the moment it exists.
    assert.equal(redis.values.size, 0);
  });

  it('honours a configured key prefix', async () => {
    const redis = createFakeRedis();
    const store = createRedisProposalStore({
      url: 'redis://localhost:6379',
      keyPrefix: 'other:prefix',
      clientFactory: () => /** @type {any} */ (redis),
    });
    const proposal = testProposal();

    await store.save(proposal);

    assert.ok(redis.values.has(`other:prefix:demo-store:${proposal.id}`));
  });
});

describe('consuming a proposal', () => {
  it('returns it once and then nothing', async () => {
    const { store } = build();
    const proposal = testProposal();

    await store.save(proposal);

    assert.equal((await store.consume({ siteId: 'demo-store', id: proposal.id }))?.id, proposal.id);
    assert.equal(await store.consume({ siteId: 'demo-store', id: proposal.id }), undefined);
  });

  it('uses GETDEL, so the read and the delete cannot race', async () => {
    const { store, redis } = build();
    const proposal = testProposal();

    await store.save(proposal);
    await store.consume({ siteId: 'demo-store', id: proposal.id });

    // The window between a `get` and a `del` is exactly as wide as a customer tapping a confirm button
    // twice, which is to say wide. Asserted on the command because the semantics are the guarantee.
    assert.ok(redis.calls.includes('getDel'));
    assert.ok(!redis.calls.includes('del'));
  });

  it('round-trips every field the domain needs', async () => {
    const { store } = build();
    const proposal = testProposal();

    await store.save(proposal);

    assert.deepEqual(await store.consume({ siteId: 'demo-store', id: proposal.id }), proposal);
  });

  it('reports an absent proposal as absent', async () => {
    const { store } = build();

    assert.equal(await store.consume({ siteId: 'demo-store', id: 'cp_nope' }), undefined);
  });

  it('treats an unreadable entry as absent rather than throwing', async () => {
    const { store, redis } = build();

    redis.values.set('shopsage:proposal:demo-store:cp_broken', '{not json');

    // The value is already deleted by `GETDEL`, so it cannot be retried - reporting it absent is the
    // only honest outcome, and the confirmation endpoint already handles that.
    assert.equal(await store.consume({ siteId: 'demo-store', id: 'cp_broken' }), undefined);
  });

  it('treats a proposal missing its subject as absent', async () => {
    const { store, redis } = build();

    redis.values.set(
      'shopsage:proposal:demo-store:cp_partial',
      JSON.stringify({ id: 'cp_partial' }),
    );

    // Without a subject there is nothing to check ownership against, and a proposal nobody owns must
    // not be confirmable by anybody.
    assert.equal(await store.consume({ siteId: 'demo-store', id: 'cp_partial' }), undefined);
  });
});

describe('when Redis is unavailable', () => {
  it('raises the platform taxonomy, not a vendor error', async () => {
    const { store } = build({ failWith: new Error('ECONNREFUSED') });

    await assert.rejects(store.save(testProposal()), (error) => {
      assert.ok(error instanceof UpstreamError);
      assert.equal(error.retryable, true);

      return true;
    });
  });

  it('fails a consume rather than pretending the proposal is gone', async () => {
    const { store } = build({ failWith: new Error('ECONNREFUSED') });

    // "Gone" and "we could not check" are different facts. Reporting an outage as a consumed proposal
    // would tell a customer their confirmation had already been used.
    await assert.rejects(
      store.consume({ siteId: 'demo-store', id: 'cp_x' }),
      /proposal store is unavailable/u,
    );
  });

  it('reports unhealthy', async () => {
    const { store } = build({ failWith: new Error('ECONNREFUSED') });

    await assert.rejects(store.health(), /unavailable/u);
  });
});

describe('sharing a connection', () => {
  it('does not open a second client when given one', async () => {
    const redis = createFakeRedis();
    let built = 0;
    const shared = {
      client: /** @type {any} */ (redis),
      connected: () => {
        built += 1;

        return Promise.resolve(/** @type {any} */ (redis));
      },
      close: () => Promise.resolve(),
    };
    const store = createRedisProposalStore({
      url: 'redis://localhost:6379',
      connection: /** @type {any} */ (shared),
    });

    await store.save(testProposal());

    // Two clients to the same server from one process is two reconnect loops and two error streams for
    // two key prefixes that could not care less about each other.
    assert.equal(built, 1);
    assert.ok(!redis.calls.includes('connect'));
  });
});
