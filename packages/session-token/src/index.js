/**
 * @shopsage/session-token - verifies Magento-issued assistant session tokens.
 *
 * **This package issues nothing and holds no private key.** Magento is the sole issuer
 * (docs/proposals/0001-assistant-session-token.md, decision 4), so a compromise here yields
 * public keys and nothing that could mint a token for a customer. That asymmetry is why
 * `HS256` is permanently unsupported rather than merely discouraged.
 *
 * Three files, in the order a request meets them:
 *
 * - `decode.js` splits the token and deliberately cannot inspect a claim.
 * - `verify-signature.js` performs the **configured** algorithm, never the token's.
 * - `verify-token.js` runs the contract's ordered checks and returns a session.
 *
 * `jwks/create-key-store.js` is the only part that does I/O, and its two load-bearing rules
 * are documented there: a bounded refetch on an unknown key id, and serving a stale key set
 * rather than failing when the issuer is briefly unreachable.
 *
 * There is no JWT dependency. Node's `crypto` verifies both supported algorithms natively -
 * `ieee-p1363` is exactly the raw signature encoding JWS specifies - and the security-
 * critical part of a JWT verifier is algorithm pinning, which is a decision worth owning in
 * readable code rather than configuring in somebody else's.
 */

export { verifyToken } from './verify-token.js';
export { createKeyStore } from './jwks/create-key-store.js';
export { supportedAlgorithms } from './verify-signature.js';

/**
 * @typedef {import('./verify-token.js').AssistantSession} AssistantSession
 * @typedef {import('./verify-token.js').VerifyOptions} VerifyOptions
 */
