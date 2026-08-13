/**
 * Regenerate the shared session-token test vectors.
 *
 *   node packages/session-token/test/vectors/generate-vectors.mjs
 *
 * The output is **checked in**, and this script exists so the Magento module can reproduce it
 * rather than having to trust it. Both sides need the same fixtures to prove compliance
 * without the other running — see the contract, §14.
 *
 * Two properties make the vectors deterministic, which is what stops the suite failing on a
 * date nobody chose:
 *
 * - The key pair is **fixed**, embedded below in JWK form. It is a throwaway used only by
 *   tests, which is why a private key appears in a committed file at all; nothing signs real
 *   traffic with it.
 * - Every vector carries the `now` it must be evaluated at, so a "valid" token stays valid
 *   for ever and an "expired" one stays expired.
 */

import { createPrivateKey, createPublicKey, sign } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));

/** Fixed throwaway P-256 key. Test-only; never used for real traffic. */
const SIGNING_JWK = {
  kty: 'EC',
  crv: 'P-256',
  d: 'm1YWy_AmB0LP8ph5sHXU9ldGcpziKVOp_SJnWFcMIzE',
  x: 'i0H6Tc_zcCZGGbc4c_5LPTBg3oETbqgw4Eee3mQDdVE',
  y: '0N7OIzXq55aOwDvbAddY191K6uTVC8aXs53RYc9xWFo',
};

/** A second key, used only to produce the wrong-signature vector. */
const IMPOSTOR_JWK = {
  kty: 'EC',
  crv: 'P-256',
  d: 'Sktkf5U2BAZtHY3gyl5WzKPbFJpGG-k6SkCPl6TurhI',
  x: 'H8GeeWaGUel5JQ3L-uHU7gEaISVJ3RutnZq7Xt3zWKM',
  y: 'zuXDQPl1jzztAthxxbdxpnBVCPHl0IXK2fK2U32iU78',
};

const KID = 'test-2026-08-a';
const ISSUER = 'https://store.example.com';
const AUDIENCE = 'shopsage-demo-store';
const SITE_ID = 'demo-store';
const NOW = 1_800_000_000; // Fixed reference instant, in unix seconds.

const base = {
  iss: ISSUER,
  aud: AUDIENCE,
  sub: 'ps_3f9c1b7e4a2d',
  sid: SITE_ID,
  scope: 'chat orders',
  jti: '8f14e45f-ea0b-4c3f-9f0d-2b6a1c7d5e42',
  iat: NOW,
  exp: NOW + 900,
};

/**
 * @param {Record<string, unknown>} header
 * @param {Record<string, unknown>} claims
 * @param {Record<string, string>} [jwk]
 */
function mint(header, claims, jwk = SIGNING_JWK) {
  const encode = (/** @type {unknown} */ value) =>
    Buffer.from(JSON.stringify(value)).toString('base64url');

  const signingInput = `${encode(header)}.${encode(claims)}`;

  if (header.alg === 'none') return `${signingInput}.`;

  const signature = sign('sha256', Buffer.from(signingInput, 'ascii'), {
    key: createPrivateKey({ key: jwk, format: 'jwk' }),
    dsaEncoding: 'ieee-p1363',
  });

  return `${signingInput}.${signature.toString('base64url')}`;
}

const header = { alg: 'ES256', typ: 'at+jwt', kid: KID };

const vectors = [
  {
    id: 'valid',
    description: 'A well-formed token from the expected issuer for this store.',
    expect: 'accept',
    now: NOW,
    token: mint(header, base),
  },
  {
    id: 'valid-cart',
    description:
      'A well-formed token whose session may also change the basket. Added in Stage 9b, when `cart` ' +
      'joined the scope set: a shared vector for the capability that spends money is worth having, and ' +
      'it is what ShopSage verifies the confirmation path against.',
    expect: 'accept',
    now: NOW,
    token: mint(header, {
      ...base,
      scope: 'chat orders cart',
      jti: 'a1b2c3d4-0000-4c3f-9f0d-2b6a1c7d5e42',
    }),
  },
  {
    id: 'expired',
    description: 'Correctly signed, but past its expiry beyond the skew allowance.',
    expect: 'reject',
    reason: 'expired',
    code: 'TOKEN_EXPIRED',
    now: NOW,
    token: mint(header, { ...base, iat: NOW - 1800, exp: NOW - 901 }),
  },
  {
    id: 'wrong-signing-key',
    description: 'Signed by a key that is not in the published set.',
    expect: 'reject',
    reason: 'bad_signature',
    now: NOW,
    token: mint(header, base, IMPOSTOR_JWK),
  },
  {
    id: 'alg-none',
    description: 'Unsigned token claiming alg none. Must be refused before verification.',
    expect: 'reject',
    reason: 'algorithm_none',
    now: NOW,
    token: mint({ ...header, alg: 'none' }, base),
  },
  {
    id: 'wrong-audience',
    description: 'A valid token minted for a different ShopSage deployment.',
    expect: 'reject',
    reason: 'audience_mismatch',
    now: NOW,
    token: mint(header, { ...base, aud: 'shopsage-other-store' }),
  },
  {
    id: 'wrong-sid',
    description: "Another store's session presented to this one. A tenancy violation.",
    expect: 'reject',
    reason: 'tenancy_violation',
    now: NOW,
    token: mint(header, { ...base, sid: 'other-store' }),
  },
  {
    id: 'invalid-scope',
    description: 'No usable scope. Still a valid token: accepted, capability withheld.',
    expect: 'accept',
    scopes: [],
    now: NOW,
    token: mint(header, { ...base, scope: '' }),
  },
  {
    id: 'unknown-kid',
    description: 'References a key id absent from the JWKS.',
    expect: 'reject',
    reason: 'unknown_kid',
    now: NOW,
    token: mint({ ...header, kid: 'test-does-not-exist' }, base),
  },
];

const document = {
  $comment:
    'Shared test vectors for the assistant session token contract. Generated by ' +
    'generate-vectors.mjs; do not hand-edit. Test-only keys.',
  contract: 'docs/proposals/0001-assistant-session-token.md',
  parameters: { issuer: ISSUER, audience: AUDIENCE, siteId: SITE_ID, algorithm: 'ES256', kid: KID },
  jwks: {
    keys: [{ ...publicPart(SIGNING_JWK), kid: KID, use: 'sig', alg: 'ES256' }],
  },
  signingKey: { ...SIGNING_JWK, kid: KID },
  vectors,
};

/** @param {Record<string, string>} jwk */
function publicPart(jwk) {
  return createPublicKey({ key: jwk, format: 'jwk' }).export({ format: 'jwk' });
}

writeFileSync(join(HERE, 'vectors.json'), `${JSON.stringify(document, null, 2)}\n`);
process.stdout.write(`wrote ${vectors.length} vectors\n`);
