import { TokenExpiredError, UnauthorizedError } from '@shopsage/platform';
import { decodeToken } from './decode.js';
import { verifySignature } from './verify-signature.js';

/**
 * @typedef {object} AssistantSession
 * @property {string} subject Pseudonym. Never a customer id - see the contract, decision 2.
 * @property {string} siteId Which store this session belongs to.
 * @property {string[]} scopes Capabilities granted, unrecognised entries included.
 * @property {string} tokenId The `jti`, for correlating a support conversation across systems.
 * @property {number} expiresAt Unix seconds.
 */

/**
 * @typedef {object} VerifyOptions
 * @property {string} issuer Expected `iss`.
 * @property {string} audience Expected `aud`, store-specific.
 * @property {string} siteId Expected `sid`; this deployment's store.
 * @property {string} algorithm The **configured** algorithm. Never read from the token.
 * @property {(kid: string) => Promise<import('node:crypto').KeyObject>} resolveKey
 * @property {number} [clockSkewSeconds] Default 60.
 * @property {() => number} [now] Injection seam; unix **seconds**.
 */

const DEFAULT_SKEW_SECONDS = 60;

/**
 * Verify a session token and return the session it describes.
 *
 * The order below is the contract's (§8) and it is not arbitrary. Cheap checks come first so
 * that garbage costs nothing, and **no claim is read until the signature has been verified**
 * — a claim from an unverified token is just a string an attacker chose. The header is the
 * one exception, because a key has to be selected somehow; it is used only to pick a `kid`
 * and to compare `alg` against the configured value.
 *
 * Every rejection reports a coarse reason to the caller and a precise one to the log. An
 * attacker learning *which* check failed learns what to fix next; an operator needs to know
 * exactly that. `reason` is for logs, and the middleware decides what to publish.
 *
 * @param {string} token
 * @param {VerifyOptions} options
 * @returns {Promise<AssistantSession>}
 * @throws {UnauthorizedError | TokenExpiredError}
 */
export async function verifyToken(token, options) {
  const decoded = decodeToken(token);

  assertAlgorithm(decoded.header, options.algorithm);

  const key = await options.resolveKey(readKid(decoded.header));

  if (!verifySignature({ ...decoded, algorithm: options.algorithm, key })) {
    throw reject('bad_signature');
  }

  // Past this line the claims are trustworthy, because Magento signed them.
  const claims = decoded.claims;

  assertTimeWindow(claims, options);
  assertMatches(claims, options);

  return toSession(claims);
}

/**
 * @param {DecodedHeader} header
 * @param {string} expected
 */
function assertAlgorithm(header, expected) {
  if (header.alg === expected) return;

  // Worth a distinct reason: `none` and a swapped family are attacks, not typos, and their
  // base rate in normal traffic is zero.
  throw reject(header.alg === 'none' ? 'algorithm_none' : 'algorithm_mismatch');
}

/**
 * @typedef {{ alg?: unknown, kid?: unknown }} DecodedHeader
 * @param {DecodedHeader} header
 * @returns {string}
 */
function readKid(header) {
  if (typeof header.kid !== 'string' || header.kid.length === 0) throw reject('missing_kid');

  return header.kid;
}

/**
 * @param {Record<string, unknown>} claims
 * @param {VerifyOptions} options
 */
function assertTimeWindow(claims, options) {
  const nowSeconds = options.now === undefined ? Math.floor(Date.now() / 1000) : options.now();
  const skew = options.clockSkewSeconds ?? DEFAULT_SKEW_SECONDS;

  if (typeof claims.exp !== 'number') throw reject('missing_exp');

  // Skew allowed in both directions. Two servers, two clocks: without it a few seconds of
  // drift produces intermittent 401s that correlate with nothing.
  if (claims.exp + skew <= nowSeconds) {
    throw new TokenExpiredError('Session token has expired', {
      details: { reason: 'expired' },
    });
  }

  if (typeof claims.nbf === 'number' && claims.nbf - skew > nowSeconds)
    throw reject('not_yet_valid');
  if (typeof claims.iat === 'number' && claims.iat - skew > nowSeconds)
    throw reject('issued_in_future');
}

/**
 * @param {Record<string, unknown>} claims
 * @param {VerifyOptions} options
 */
function assertMatches(claims, options) {
  if (claims.iss !== options.issuer) throw reject('issuer_mismatch');
  if (!audienceMatches(claims.aud, options.audience)) throw reject('audience_mismatch');

  // The tenancy check. A correctly signed token for another store must not work here, and
  // this is the line that stops it - so its failure is logged as a tenancy violation rather
  // than as an ordinary rejection.
  if (claims.sid !== options.siteId) throw reject('tenancy_violation');
}

/**
 * `aud` is permitted to be a string or an array of them, so both are accepted.
 *
 * @param {unknown} aud
 * @param {string} expected
 * @returns {boolean}
 */
function audienceMatches(aud, expected) {
  if (typeof aud === 'string') return aud === expected;

  return Array.isArray(aud) && aud.includes(expected);
}

/**
 * @param {Record<string, unknown>} claims
 * @returns {AssistantSession}
 */
function toSession(claims) {
  if (typeof claims.sub !== 'string' || claims.sub.length === 0) throw reject('missing_sub');
  if (typeof claims.jti !== 'string' || claims.jti.length === 0) throw reject('missing_jti');

  return {
    subject: claims.sub,
    siteId: /** @type {string} */ (claims.sid),
    // Unrecognised entries are kept rather than filtered. A scope this build does not know
    // about is a newer Magento talking to an older ShopSage, which must not break - and an
    // unknown scope grants nothing anyway, because capability gating asks for names it knows.
    scopes: parseScopes(claims.scope),
    tokenId: claims.jti,
    expiresAt: /** @type {number} */ (claims.exp),
  };
}

/**
 * @param {unknown} scope
 * @returns {string[]}
 */
function parseScopes(scope) {
  if (typeof scope !== 'string') return [];

  return scope.split(' ').filter((entry) => entry.length > 0);
}

/**
 * One message to the caller, a precise reason for the log.
 *
 * @param {string} reason
 * @returns {UnauthorizedError}
 */
function reject(reason) {
  return new UnauthorizedError('Invalid session token', { details: { reason } });
}
