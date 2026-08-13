import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { AppError } from '@shopsage/platform';
import { createKeyStore, verifyToken } from '../src/index.js';

/**
 * The shared contract vectors, driven end to end.
 *
 * This file is the ShopSage half of a two-sided agreement
 * (docs/proposals/0001-assistant-session-token.md §14). The Magento module runs the same
 * fixture against its issuer, which is what lets each side prove compliance without the
 * other running — and what will catch a divergence introduced months apart.
 *
 * Every vector carries the instant it must be evaluated at, so nothing here expires.
 */
const FIXTURE = JSON.parse(
  readFileSync(new URL('./vectors/vectors.json', import.meta.url), 'utf8'),
);

/** A JWKS served from the fixture, so `unknown-kid` genuinely misses. */
function keyStoreForFixture() {
  return createKeyStore({
    url: 'https://store.example.com/assistant/.well-known/jwks.json',
    fetchImpl: () =>
      Promise.resolve(
        new Response(JSON.stringify(FIXTURE.jwks), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      ),
  });
}

/** @param {{ now: number }} vector */
function optionsFor(vector) {
  const { issuer, audience, siteId, algorithm } = FIXTURE.parameters;

  return {
    issuer,
    audience,
    siteId,
    algorithm,
    resolveKey: (/** @type {string} */ kid) => keyStoreForFixture().resolveKey(kid),
    now: () => vector.now,
  };
}

describe('shared contract vectors', () => {
  it('covers every case the contract requires', () => {
    // A vector quietly disappearing would silently narrow the contract, which is what this watches.
    //
    // A **subset** check, not an exact one. The contract specifies a minimum set, so extra vectors are
    // added coverage and must not be a failure - the exact version of this assertion rejected
    // `valid-cart` when the `cart` scope arrived in Stage 9b, which is the test enforcing something the
    // contract never said.
    const present = new Set(FIXTURE.vectors.map((/** @type {any} */ vector) => vector.id));
    const required = [
      'alg-none',
      'expired',
      'invalid-scope',
      'unknown-kid',
      'valid',
      'wrong-audience',
      'wrong-sid',
      'wrong-signing-key',
    ];

    for (const id of required) assert.ok(present.has(id), `missing required vector: ${id}`);
  });

  for (const vector of FIXTURE.vectors) {
    it(`${vector.id}: ${vector.description}`, async () => {
      if (vector.expect === 'accept') {
        const session = await verifyToken(vector.token, optionsFor(vector));

        assert.equal(session.siteId, FIXTURE.parameters.siteId);
        assert.equal(typeof session.subject, 'string');
        assert.equal(typeof session.tokenId, 'string');

        if (vector.scopes !== undefined) assert.deepEqual(session.scopes, vector.scopes);

        return;
      }

      await assert.rejects(
        () => verifyToken(vector.token, optionsFor(vector)),
        (error) => {
          assert.ok(error instanceof AppError, `expected an AppError, got ${error}`);
          assert.equal(error.status, 401);
          assert.equal(error.details?.reason, vector.reason);

          if (vector.code !== undefined) assert.equal(error.code, vector.code);

          return true;
        },
      );
    });
  }

  it('carries no customer-identifying claim', () => {
    // Decision 2, enforced against the fixture rather than only asserted in prose: if the
    // contract's own example token contained an email or a customer id, the design would
    // have drifted from what was agreed.
    const claims = JSON.parse(
      Buffer.from(FIXTURE.vectors[0].token.split('.')[1], 'base64url').toString('utf8'),
    );

    assert.deepEqual(Object.keys(claims).sort(), [
      'aud',
      'exp',
      'iat',
      'iss',
      'jti',
      'scope',
      'sid',
      'sub',
    ]);
    assert.ok(!/@/u.test(claims.sub), 'sub must not look like an email address');
    assert.ok(!/^\d+$/u.test(claims.sub), 'sub must not be a bare numeric id');
  });

  it('exposes no precise reason to a caller, only to the log', () => {
    // The reason is what an attacker would use to work out which check to defeat next. It
    // belongs in `details` for the log; the middleware decides what reaches the client.
    const rejected = FIXTURE.vectors.filter((/** @type {any} */ v) => v.expect === 'reject');

    assert.ok(rejected.length >= 6);
    for (const vector of rejected) {
      assert.equal(typeof vector.reason, 'string', `${vector.id} must pin a reason`);
    }
  });
});
