import assert from 'node:assert/strict';
import { UpstreamError, createLogger } from '@shopsage/platform';
import { describe, it } from 'node:test';
import { createRedisConversationStore } from '../src/index.js';
import { createFakeRedis } from './helpers/fake-redis.js';

const SITE = 'demo-store';
const CONVERSATION = 'c_1';

/**
 * @param {Parameters<typeof createFakeRedis>[0]} [redisOptions]
 * @param {Partial<import('../src/index.js').RedisConversationStoreOptions>} [overrides]
 */
function buildStore(redisOptions, overrides = {}) {
  const redis = createFakeRedis(redisOptions);
  /** @type {any[]} */
  const records = [];

  const store = createRedisConversationStore({
    url: 'redis://localhost:6379',
    ttlSeconds: 3600,
    maxStoredMessages: 4,
    logger: createLogger({
      level: 'trace',
      sink: { write: (line) => records.push(JSON.parse(line)) },
    }),
    clientFactory: () => /** @type {any} */ (redis),
    ...overrides,
  });

  return { store, redis, records };
}

/**
 * @param {string} content
 * @param {'user' | 'assistant'} [role]
 */
const turn = (content, role = 'user') => ({ role, content, at: '2026-01-01T00:00:00.000Z' });

describe('createRedisConversationStore', () => {
  it('returns nothing for a conversation that does not exist', async () => {
    const { store } = buildStore();

    assert.deepEqual(
      await store.history({ siteId: SITE, conversationId: CONVERSATION, limit: 10 }),
      [],
    );
  });

  it('appends and reads back in order', async () => {
    const { store } = buildStore();
    const turns = [turn('Q'), turn('A', 'assistant')];

    await store.append({ siteId: SITE, conversationId: CONVERSATION, turns });

    assert.deepEqual(
      await store.history({ siteId: SITE, conversationId: CONVERSATION, limit: 10 }),
      turns,
    );
  });

  it('reads the most recent messages, not the oldest', async () => {
    // A follow-up question depends on what was just said, so a truncated history must
    // keep the end.
    const { store } = buildStore();

    for (const content of ['1', '2', '3']) {
      await store.append({ siteId: SITE, conversationId: CONVERSATION, turns: [turn(content)] });
    }

    const history = await store.history({ siteId: SITE, conversationId: CONVERSATION, limit: 2 });

    assert.deepEqual(
      history.map((entry) => entry.content),
      ['2', '3'],
    );
  });

  describe('tenancy', () => {
    it('puts the site id in the key, so one store cannot read another', async () => {
      // Structural rather than a filter somebody has to remember, for the same reason
      // every vector search takes siteId as a required argument.
      const { store, redis } = buildStore();

      await store.append({
        siteId: 'store-a',
        conversationId: 'c_shared',
        turns: [turn('private to a')],
      });

      assert.deepEqual(
        await store.history({ siteId: 'store-b', conversationId: 'c_shared', limit: 10 }),
        [],
      );
      assert.deepEqual([...redis.lists.keys()], ['shopsage:conv:store-a:c_shared']);
    });

    it('honours a configured key prefix, so one Redis can host two deployments', async () => {
      const { store, redis } = buildStore(undefined, { keyPrefix: 'staging:conv' });

      await store.append({ siteId: SITE, conversationId: CONVERSATION, turns: [turn('Q')] });

      assert.deepEqual([...redis.lists.keys()], ['staging:conv:demo-store:c_1']);
    });
  });

  describe('bounds', () => {
    it('caps what it stores, whatever the conversation length', async () => {
      const { store, redis } = buildStore();

      for (const content of ['1', '2', '3', '4', '5', '6']) {
        await store.append({ siteId: SITE, conversationId: CONVERSATION, turns: [turn(content)] });
      }

      assert.equal(redis.lists.get('shopsage:conv:demo-store:c_1')?.length, 4);
    });

    it('sets an expiry on every write, so an idle conversation disappears', async () => {
      const { store, redis } = buildStore();

      await store.append({ siteId: SITE, conversationId: CONVERSATION, turns: [turn('Q')] });

      assert.equal(redis.ttls.get('shopsage:conv:demo-store:c_1'), 3600);
    });

    it('refreshes the expiry on a later write, making the timeout an idle one', async () => {
      const { store, redis } = buildStore(undefined, { ttlSeconds: 60 });
      const key = 'shopsage:conv:demo-store:c_1';

      await store.append({ siteId: SITE, conversationId: CONVERSATION, turns: [turn('Q')] });
      redis.ttls.set(key, 5);
      await store.append({ siteId: SITE, conversationId: CONVERSATION, turns: [turn('Q2')] });

      assert.equal(redis.ttls.get(key), 60);
    });

    it('writes append, trim and expire as one transaction', async () => {
      // Two tabs on one conversation would otherwise interleave a read-modify-write and
      // lose a turn, which is why the port says `append` rather than `set`.
      const { store, redis } = buildStore();

      await store.append({
        siteId: SITE,
        conversationId: CONVERSATION,
        turns: [turn('Q'), turn('A', 'assistant')],
      });

      assert.equal(redis.calls.filter((call) => call === 'exec').length, 1);
    });

    it('does not touch the store for an empty append', async () => {
      const { store, redis } = buildStore();

      await store.append({ siteId: SITE, conversationId: CONVERSATION, turns: [] });

      assert.deepEqual(redis.calls, []);
    });
  });

  describe('reading what another version wrote', () => {
    /** @param {string[]} entries */
    async function readingRaw(entries) {
      const { store, redis, records } = buildStore();

      await store.append({ siteId: SITE, conversationId: CONVERSATION, turns: [turn('good')] });
      redis.lists.set('shopsage:conv:demo-store:c_1', entries);

      return {
        history: await store.history({ siteId: SITE, conversationId: CONVERSATION, limit: 10 }),
        records,
      };
    }

    it('skips an entry that is not JSON rather than failing the turn', async () => {
      // A shared datastore outlives any one release. One bad entry must not throw inside
      // a customer's question, and keep throwing on every turn of that conversation.
      const { history } = await readingRaw([
        'not json at all',
        JSON.stringify(turn('still readable')),
      ]);

      assert.deepEqual(
        history.map((entry) => entry.content),
        ['still readable'],
      );
    });

    it('skips an entry of the wrong shape', async () => {
      const { history } = await readingRaw([
        JSON.stringify({ role: 'system', content: 'x', at: 'now' }),
        JSON.stringify({ role: 'user', content: 42, at: 'now' }),
        JSON.stringify({ role: 'user' }),
        JSON.stringify(turn('ok')),
      ]);

      assert.deepEqual(
        history.map((entry) => entry.content),
        ['ok'],
      );
    });

    it('says so when it skipped something', async () => {
      const { records } = await readingRaw(['garbage', JSON.stringify(turn('ok'))]);
      const warning = records.find((record) => record.msg?.includes('unreadable'));

      assert.equal(warning?.level, 'warn');
      assert.equal(warning?.skipped, 1);
    });
  });

  describe('failure', () => {
    it('presents an unreachable store as an upstream failure, not a client error', async () => {
      // Nothing above this package should have to recognise a redis-specific error type
      // to know a dependency is down.
      const { store } = buildStore({ failWith: new Error('ECONNREFUSED'), failOn: 'connect' });

      await assert.rejects(
        () => store.history({ siteId: SITE, conversationId: CONVERSATION, limit: 10 }),
        (error) => error instanceof UpstreamError,
      );
    });

    it('does not leak the vendor error message to a customer', async () => {
      const { store } = buildStore({ failWith: new Error('ECONNREFUSED 10.0.0.5:6379') });

      await assert.rejects(
        () => store.append({ siteId: SITE, conversationId: CONVERSATION, turns: [turn('Q')] }),
        (error) => {
          assert.ok(error instanceof UpstreamError);
          assert.ok(!error.message.includes('10.0.0.5'));
          return true;
        },
      );
    });

    it('retries the connection after a failed attempt', async () => {
      // A rejected connect promise must not be memoized: the first outage would otherwise
      // be permanent for the life of the process, which is what the client's own
      // reconnect strategy exists to prevent.
      const redis = createFakeRedis();
      let attempts = 0;

      const store = createRedisConversationStore({
        url: 'redis://localhost:6379',
        ttlSeconds: 60,
        maxStoredMessages: 4,
        clientFactory: () =>
          /** @type {any} */ ({
            ...redis,
            connect: () => {
              attempts += 1;
              return attempts === 1 ? Promise.reject(new Error('down')) : redis.connect();
            },
          }),
      });

      await assert.rejects(() =>
        store.history({ siteId: SITE, conversationId: CONVERSATION, limit: 10 }),
      );
      await store.history({ siteId: SITE, conversationId: CONVERSATION, limit: 10 });

      assert.equal(attempts, 2);
    });

    it('fails fast when the store never answers', async () => {
      // The defect this was written for: with Redis stopped, `/health/ready` hung
      // indefinitely instead of reporting `down`. The client retries connecting forever
      // by design, and nothing above it had a deadline — `platform`'s `withTimeout` is a
      // cancellation primitive, and a Redis command cannot be cancelled.
      const { store } = buildStore(undefined, {
        timeoutMs: 20,
        clientFactory: () =>
          /** @type {any} */ ({
            on: () => {},
            isOpen: false,
            connect: () => new Promise(() => {}),
          }),
      });

      const startedAt = Date.now();

      await assert.rejects(
        () => store.history({ siteId: SITE, conversationId: CONVERSATION, limit: 10 }),
        (error) => {
          assert.ok(error instanceof UpstreamError);
          assert.match(error.message, /did not respond within 20ms/u);
          return true;
        },
      );

      assert.ok(Date.now() - startedAt < 1000, 'must not wait on a hung operation');
    });

    it('bounds every operation, not just reads', async () => {
      const hung = () =>
        /** @type {any} */ ({ on: () => {}, isOpen: false, connect: () => new Promise(() => {}) });

      for (const operation of [
        (/** @type {any} */ s) =>
          s.append({ siteId: SITE, conversationId: CONVERSATION, turns: [turn('Q')] }),
        (/** @type {any} */ s) => s.health(),
      ]) {
        const { store } = buildStore(undefined, { timeoutMs: 20, clientFactory: hung });

        await assert.rejects(() => operation(store), UpstreamError);
      }
    });

    it('logs a connection error rather than letting it take the process down', () => {
      // Node throws on an 'error' event with no listener. An unreachable store must fail
      // a request, not crash the service.
      const { redis, records } = buildStore();

      assert.equal(redis.errorHandlers.length, 1);
      redis.errorHandlers[0](new Error('connection lost'));

      assert.equal(records.at(-1)?.level, 'warn');
    });
  });

  describe('health', () => {
    it('pings, so readiness means the store answers rather than resolves', async () => {
      const { store, redis } = buildStore();

      await store.health();

      assert.ok(redis.calls.includes('ping'));
    });

    it('fails when the store cannot be reached', async () => {
      const { store } = buildStore({ failWith: new Error('down'), failOn: 'connect' });

      await assert.rejects(
        () => store.health(),
        (error) => error instanceof UpstreamError,
      );
    });
  });

  it('closes an open connection on shutdown', async () => {
    const { store, redis } = buildStore();

    await store.health();
    await store.close();

    assert.ok(redis.calls.includes('close'));
    assert.equal(redis.isOpen, false);
  });

  it('closing an unused store does nothing', async () => {
    const { store, redis } = buildStore();

    await store.close();

    assert.deepEqual(redis.calls, []);
  });
});
