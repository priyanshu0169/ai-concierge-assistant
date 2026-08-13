import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { ServiceUnavailableError, UnauthorizedError, createLogger } from '@shopsage/platform';
import { createKeyStore } from '../src/index.js';

const FIXTURE = JSON.parse(
  readFileSync(new URL('./vectors/vectors.json', import.meta.url), 'utf8'),
);
const KID = FIXTURE.parameters.kid;

/**
 * A JWKS endpoint under test control: how many times it was asked, what it answers, and when
 * it fails.
 *
 * @param {{ failAfter?: number, body?: unknown, status?: number }} [options]
 */
function fakeJwks(options = {}) {
  let calls = 0;

  return {
    calls: () => calls,
    fetchImpl: () => {
      calls += 1;

      if (options.failAfter !== undefined && calls > options.failAfter) {
        return Promise.reject(new Error('jwks unreachable'));
      }

      return Promise.resolve(
        new Response(JSON.stringify(options.body ?? FIXTURE.jwks), {
          status: options.status ?? 200,
          headers: { 'content-type': 'application/json' },
        }),
      );
    },
  };
}

/** @param {Parameters<typeof fakeJwks>[0] & { cacheTtlMs?: number }} [options] */
function buildStore(options = {}) {
  const endpoint = fakeJwks(options);
  let clock = 1_000_000;
  /** @type {any[]} */
  const records = [];

  return {
    endpoint,
    records,
    advance: (/** @type {number} */ ms) => (clock += ms),
    store: createKeyStore({
      url: 'https://store.example.com/assistant/.well-known/jwks.json',
      cacheTtlMs: options.cacheTtlMs ?? 600_000,
      fetchImpl: endpoint.fetchImpl,
      now: () => clock,
      logger: createLogger({
        level: 'trace',
        sink: { write: (line) => records.push(JSON.parse(line)) },
      }),
    }),
  };
}

describe('createKeyStore', () => {
  it('fetches lazily, not at construction', () => {
    // Same rule as every other dependency: start without waiting, report readiness honestly.
    const { endpoint } = buildStore();

    assert.equal(endpoint.calls(), 0);
  });

  it('resolves a published key', async () => {
    const { store } = buildStore();

    assert.ok((await store.resolveKey(KID)).asymmetricKeyType);
  });

  it('caches, so verification is not a per-request call to the issuer', async () => {
    const { store, endpoint } = buildStore();

    for (let i = 0; i < 5; i += 1) await store.resolveKey(KID);

    assert.equal(endpoint.calls(), 1);
  });

  it('refreshes once the cache is stale', async () => {
    const { store, endpoint, advance } = buildStore({ cacheTtlMs: 60_000 });

    await store.resolveKey(KID);
    advance(60_001);
    await store.resolveKey(KID);

    assert.equal(endpoint.calls(), 2);
  });

  it('coalesces concurrent cold-start fetches into one', async () => {
    // A burst arriving on an empty cache would otherwise each fetch the same document.
    const { store, endpoint } = buildStore();

    await Promise.all([store.resolveKey(KID), store.resolveKey(KID), store.resolveKey(KID)]);

    assert.equal(endpoint.calls(), 1);
  });

  describe('an unknown key id', () => {
    it('triggers one refetch, because that is what a rotation looks like', async () => {
      // The realistic case: keys were fetched a while ago, Magento rotated inside the cache
      // window, and a token signed by the new key arrives.
      const { store, endpoint, advance } = buildStore();

      await store.resolveKey(KID);
      advance(60_001);
      await assert.rejects(() => store.resolveKey('rotated-in'), UnauthorizedError);

      assert.equal(endpoint.calls(), 2);
    });

    it('does not refetch for an unknown id straight after a fetch', async () => {
      // The document cannot have changed in the meantime, so a second look would only cost
      // a round trip to learn the same thing.
      const { store, endpoint } = buildStore();

      await store.resolveKey(KID);
      await assert.rejects(() => store.resolveKey('rotated-in'), UnauthorizedError);

      assert.equal(endpoint.calls(), 1);
    });

    it('does not refetch repeatedly within the minimum interval', async () => {
      // The security control. Without it, tokens carrying random `kid`s make this service
      // fetch the JWKS once per request — turning authentication into a denial-of-service
      // amplifier pointed at the storefront it depends on.
      const { store, endpoint, advance } = buildStore();

      await store.resolveKey(KID);
      advance(60_001);

      for (let i = 0; i < 20; i += 1) {
        advance(100);
        await assert.rejects(() => store.resolveKey(`forged-${i}`));
      }

      assert.equal(endpoint.calls(), 2, `fetched ${endpoint.calls()} times for 20 forged ids`);
    });

    it('will look again once the interval has passed', async () => {
      const { store, endpoint, advance } = buildStore();

      await store.resolveKey(KID);
      advance(60_001);
      await assert.rejects(() => store.resolveKey('rotated-in'));
      advance(60_001);
      await assert.rejects(() => store.resolveKey('rotated-in'));

      assert.equal(endpoint.calls(), 3);
    });
  });

  describe('when the issuer is unreachable', () => {
    it('serves a stale key set rather than failing', async () => {
      // A blip fetching the document must not invalidate keys that still verify perfectly
      // well. The alternative is an outage caused by a cache miss.
      const { store, endpoint, advance, records } = buildStore({
        cacheTtlMs: 60_000,
        failAfter: 1,
      });

      await store.resolveKey(KID);
      advance(60_001);

      assert.ok((await store.resolveKey(KID)).asymmetricKeyType);
      assert.equal(endpoint.calls(), 2);
      assert.equal(records.at(-1)?.msg, 'serving a stale session key set');
      assert.equal(records.at(-1)?.level, 'warn');
    });

    it('reports 503, not 401, when it holds no keys at all', async () => {
      // The caller's token may be perfectly good; we simply cannot check it. Answering
      // "your credentials are bad" sends an operator looking in the wrong place entirely.
      const { store } = buildStore({ failAfter: 0 });

      await assert.rejects(
        () => store.resolveKey(KID),
        (error) => {
          assert.ok(error instanceof ServiceUnavailableError);
          assert.equal(error.status, 503);
          return true;
        },
      );
    });

    it('recovers on its own once the issuer returns', async () => {
      let failing = true;
      let calls = 0;
      const store = createKeyStore({
        url: 'https://store.example.com/jwks.json',
        fetchImpl: () => {
          calls += 1;
          return failing
            ? Promise.reject(new Error('down'))
            : Promise.resolve(new Response(JSON.stringify(FIXTURE.jwks), { status: 200 }));
        },
      });

      await assert.rejects(() => store.resolveKey(KID));
      failing = false;

      assert.ok((await store.resolveKey(KID)).asymmetricKeyType);
      assert.equal(calls, 2);
    });
  });

  describe('a JWKS document it cannot use', () => {
    it('rejects one that is not a key set', async () => {
      const { store } = buildStore({ body: { notKeys: [] } });

      await assert.rejects(() => store.resolveKey(KID), ServiceUnavailableError);
    });

    it('skips entries it does not understand rather than failing wholesale', async () => {
      // A JWKS legitimately carries keys for other purposes. One unusable entry must not
      // make every token unverifiable.
      const usable = FIXTURE.jwks.keys[0];
      const { store } = buildStore({
        body: {
          keys: [
            { kty: 'oct', kid: 'symmetric', k: 'AAAA' },
            { kty: 'EC', crv: 'P-256', kid: 'encryption-only', use: 'enc', x: 'a', y: 'b' },
            { ...usable, kid: 'other-algorithm', alg: 'HS256' },
            usable,
          ],
        },
      });

      assert.ok((await store.resolveKey(KID)).asymmetricKeyType);
    });

    it('rejects a key set with nothing usable in it', async () => {
      const { store } = buildStore({ body: { keys: [{ kty: 'oct', kid: 'x', k: 'AAAA' }] } });

      await assert.rejects(() => store.resolveKey(KID), ServiceUnavailableError);
    });
  });

  describe('health', () => {
    it('passes once a key set is held', async () => {
      const { store } = buildStore();

      await store.health();

      assert.equal(store.size(), 1);
    });

    it('passes on a stale set, so an issuer outage does not pull the instance', async () => {
      // Readiness must fail only when there are **no** usable keys. An instance still
      // verifying tokens correctly is ready, whatever the issuer is doing.
      const { store, advance } = buildStore({ cacheTtlMs: 60_000, failAfter: 1 });

      await store.health();
      advance(60_001);

      await store.health();
    });

    it('fails when it has never obtained a key set', async () => {
      const { store } = buildStore({ failAfter: 0 });

      await assert.rejects(() => store.health());
    });
  });
});
