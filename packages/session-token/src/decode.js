import { UnauthorizedError } from '@shopsage/platform';

/**
 * The maximum token length worth parsing.
 *
 * A bearer header is attacker-controlled, and base64-decoding a megabyte of it before
 * discovering it is nonsense is free work for whoever sent it. A real token with the agreed
 * claim set is 350-450 bytes, so this is an order of magnitude of headroom.
 */
const MAX_TOKEN_LENGTH = 8_192;

/**
 * @typedef {object} DecodedToken
 * @property {{ alg?: unknown, kid?: unknown, typ?: unknown }} header
 * @property {Record<string, unknown>} claims
 * @property {Buffer} signature Raw bytes, as the algorithm expects them.
 * @property {Buffer} signedInput The exact bytes the signature covers.
 */

/**
 * Split a compact JWS into its parts, without verifying anything.
 *
 * **Nothing this returns is trustworthy yet.** The header is read only to choose a key and
 * to check the algorithm against a pinned value; the claims must not be looked at until the
 * signature has been verified. That ordering is the whole security story of a JWT verifier,
 * so this function deliberately does no claim inspection at all - it cannot be misused to
 * peek.
 *
 * @param {string} token
 * @returns {DecodedToken}
 * @throws {UnauthorizedError}
 */
export function decodeToken(token) {
  if (token.length > MAX_TOKEN_LENGTH) {
    throw new UnauthorizedError('Invalid session token', { details: { reason: 'oversized' } });
  }

  const parts = token.split('.');

  if (parts.length !== 3) {
    throw new UnauthorizedError('Invalid session token', { details: { reason: 'malformed' } });
  }

  const [encodedHeader, encodedClaims, encodedSignature] = parts;

  return {
    header: parseJsonSegment(encodedHeader, 'header'),
    claims: parseJsonSegment(encodedClaims, 'claims'),
    signature: fromBase64Url(encodedSignature),
    // Reconstructed from the original text rather than re-encoded from the parsed objects.
    // Re-encoding would canonicalise whitespace and key order, and the signature covers the
    // bytes that were actually sent - so a re-encoded input verifies against nothing.
    signedInput: Buffer.from(`${encodedHeader}.${encodedClaims}`, 'ascii'),
  };
}

/**
 * @param {string} segment
 * @param {string} label
 * @returns {Record<string, any>}
 */
function parseJsonSegment(segment, label) {
  try {
    const parsed = JSON.parse(fromBase64Url(segment).toString('utf8'));

    // A JSON array or string parses fine and would then be indexed as an object, silently
    // yielding `undefined` for every claim - which reads as "absent" rather than "wrong".
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      throw new Error('not a JSON object');
    }

    return parsed;
  } catch (cause) {
    throw new UnauthorizedError('Invalid session token', {
      cause,
      details: { reason: `unreadable_${label}` },
    });
  }
}

/**
 * @param {string} value
 * @returns {Buffer}
 */
function fromBase64Url(value) {
  return Buffer.from(value, 'base64url');
}
