import { createPublicKey, verify } from 'node:crypto';
import { UnauthorizedError } from '@shopsage/platform';

/**
 * The algorithms this verifier will ever perform, and how.
 *
 * An allow-list of *implementations*, not a lookup from the token's `alg` header. That
 * distinction is the single most important line in this package: choosing the verification
 * method from a value the attacker supplies is the classic JWT break, where a token is
 * signed with HS256 using the RSA public key as the HMAC secret and a naive verifier
 * happily agrees. Here the caller passes the algorithm it has been *configured* to expect,
 * and the header is only compared against it.
 *
 * `none` is absent because it is not an algorithm. `HS256` is absent on purpose too, and
 * permanently: a symmetric key means this service could mint tokens, so a compromise here
 * would become an identity compromise for the store
 * (docs/proposals/0001-assistant-session-token.md, decision 1).
 *
 * @type {Readonly<Record<string, { hash: string, dsaEncoding?: 'ieee-p1363' }>>}
 */
const ALGORITHMS = Object.freeze({
  // Raw R||S concatenation, which is what JWS specifies and what Node calls `ieee-p1363`.
  // Without it Node expects DER and rejects every valid token.
  ES256: { hash: 'sha256', dsaEncoding: 'ieee-p1363' },
  RS256: { hash: 'sha256' },
});

/** @returns {string[]} */
export function supportedAlgorithms() {
  return Object.keys(ALGORITHMS);
}

/**
 * Import a JWK as a verification key.
 *
 * @param {Record<string, unknown>} jwk
 * @returns {import('node:crypto').KeyObject}
 */
export function importJwk(jwk) {
  return createPublicKey({ key: /** @type {any} */ (jwk), format: 'jwk' });
}

/**
 * Check a signature against a key, using the algorithm the caller expects.
 *
 * @param {{
 *   algorithm: string,
 *   key: import('node:crypto').KeyObject,
 *   signedInput: Buffer,
 *   signature: Buffer,
 * }} input
 * @returns {boolean}
 */
export function verifySignature(input) {
  const spec = ALGORITHMS[input.algorithm];

  if (spec === undefined) {
    // Reached only through a configuration error, since the algorithm is validated at boot.
    throw new UnauthorizedError('Invalid session token', {
      details: { reason: 'unsupported_algorithm' },
    });
  }

  try {
    return verify(
      spec.hash,
      input.signedInput,
      {
        key: input.key,
        ...(spec.dsaEncoding === undefined ? {} : { dsaEncoding: spec.dsaEncoding }),
      },
      input.signature,
    );
  } catch {
    // A malformed signature makes OpenSSL throw rather than return false - a wrong-length
    // ECDSA signature, for instance. Indistinguishable from a bad signature to a caller,
    // and it must not become a 500.
    return false;
  }
}
