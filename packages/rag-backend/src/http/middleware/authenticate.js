import { TokenExpiredError, UnauthorizedError } from '@shopsage/platform';

const BEARER = /^Bearer (?<token>[^\s]+)$/u;

/**
 * How loudly each rejection is recorded.
 *
 * A 401 is not one event. An expiry happens to every customer every fifteen minutes by
 * design and is not worth a warning; a swapped algorithm has a base rate of zero in honest
 * traffic and is worth waking somebody for. Logging them all at one level means either
 * drowning in expiries or missing an attack.
 *
 * @type {Readonly<Record<string, 'info' | 'warn' | 'error'>>}
 */
const SEVERITY = Object.freeze({
  expired: 'info',
  missing_token: 'info',
  malformed: 'info',
  oversized: 'info',
  unreadable_header: 'info',
  unreadable_claims: 'info',
  unknown_kid: 'warn',
  not_yet_valid: 'warn',
  issued_in_future: 'warn',
  issuer_mismatch: 'warn',
  audience_mismatch: 'warn',
  // Attacks, not typos.
  algorithm_none: 'error',
  algorithm_mismatch: 'error',
  bad_signature: 'error',
  tenancy_violation: 'error',
});

/**
 * Require a valid session token on `/v1`.
 *
 * The token is verified, never trusted: what the browser sends is what the customer can
 * change, so identity comes from Magento's signature and nothing else
 * (docs/proposals/0001-assistant-session-token.md).
 *
 * On success `req.session` carries the pseudonymous subject, the store, and the scopes. It
 * deliberately carries no customer identity, because the token deliberately contains none —
 * a tool needing that will forward the token to Magento rather than resolve it here.
 *
 * @param {{
 *   verify: (token: string) => Promise<import('@shopsage/session-token').AssistantSession>,
 * }} dependencies
 * @returns {import('express').RequestHandler}
 */
export function createAuthenticationMiddleware(dependencies) {
  return function authenticate(req, _res, next) {
    const token = readBearer(req.get('authorization'));

    if (token === undefined) {
      record(req, 'missing_token');
      next(new UnauthorizedError('A session token is required'));
      return;
    }

    dependencies
      .verify(token)
      .then((session) => {
        req.session = session;
        // Kept apart from `session`, which is bound into the request logger below. See the note on
        // `sessionCredential` in types.d.ts: the split is what stops a bearer token reaching a log
        // line by way of an innocent-looking `{ session }`.
        req.sessionCredential = token;
        // The subject is a pseudonym by contract, so it is safe to log and useful to have:
        // it is what rate limiting keys on and what a support trace follows.
        req.log = req.log.child({ subject: session.subject, tokenId: session.tokenId });
        next();
      })
      .catch((error) => {
        record(req, reasonOf(error));
        next(forClient(error));
      });
  };
}

/**
 * A synthetic session, for running without Magento.
 *
 * Grants `chat` and nothing else by default, so the capability-gating path is exercised locally rather
 * than bypassed — a developer should see the same tool set a guest sees, not a superset that hides a
 * gating bug until production.
 *
 * `DEV_SESSION_SCOPES` widens it, and exists because that default made the order and cart paths
 * unreachable without a real issuer: a developer working on `addToCart` could not reach their own
 * feature. It is honoured **only** here, on the branch that runs when authentication is off, so there
 * is no configuration that can widen a verified session's scopes. Anything beyond `chat` is warned
 * about at boot, because a deployment that got here by accident should say so out loud.
 *
 * @param {{
 *   siteId: string,
 *   logger: import('@shopsage/platform').Logger,
 *   scopes?: string[],
 * }} options
 * @returns {import('express').RequestHandler}
 */
export function createUnauthenticatedMiddleware(options) {
  const scopes = options.scopes ?? ['chat'];
  const extra = scopes.filter((scope) => scope !== 'chat');

  options.logger.warn('authentication is disabled', {
    consequence: 'every request is treated as an anonymous guest session',
    scopes,
    remediation: 'set AUTH_ENABLED=true and configure AUTH_* before serving real traffic',
  });

  if (extra.length > 0) {
    options.logger.warn('the synthetic guest session has been granted extra capabilities', {
      scopes: extra,
      consequence:
        'anyone who can reach this instance can use them, including confirming cart changes',
      remediation: 'unset DEV_SESSION_SCOPES; it is a development affordance only',
    });
  }

  return function withoutAuthentication(req, _res, next) {
    req.session = {
      // Keyed by address so rate limiting still separates callers locally. Not a real
      // pseudonym, and marked so it can never be mistaken for one in a log.
      subject: `dev:${req.ip ?? 'unknown'}`,
      siteId: options.siteId,
      scopes,
      tokenId: 'dev',
      expiresAt: 0,
    };

    next();
  };
}

/**
 * @param {string | undefined} header
 * @returns {string | undefined}
 */
function readBearer(header) {
  return header === undefined ? undefined : (BEARER.exec(header)?.groups?.token ?? undefined);
}

/**
 * Strip the precise reason before the error leaves the building.
 *
 * A 401 is an exposed error, so the envelope publishes its `details` - which is right for a
 * validation failure telling a caller which field to fix, and wrong here. Knowing that the
 * *audience* was wrong rather than the signature is exactly what an attacker needs to work
 * out what to change next, and the caller can do nothing with it either way.
 *
 * So the reason is logged and then discarded. The **code** survives, because that is the one
 * distinction a client legitimately acts on: `TOKEN_EXPIRED` means refresh and retry,
 * `UNAUTHORIZED` means stop.
 *
 * A `ServiceUnavailableError` from the key store passes through unchanged: it says our
 * dependency is unreachable, which is our problem to report honestly and reveals nothing
 * usable.
 *
 * @param {unknown} error
 * @returns {unknown}
 */
function forClient(error) {
  if (error instanceof TokenExpiredError) return new TokenExpiredError('Session token has expired');
  if (error instanceof UnauthorizedError) return new UnauthorizedError('Invalid session token');

  return error;
}

/**
 * @param {unknown} error
 * @returns {string}
 */
function reasonOf(error) {
  const reason = /** @type {{ details?: { reason?: unknown } }} */ (error)?.details?.reason;

  return typeof reason === 'string' ? reason : 'unknown';
}

/**
 * @param {import('express').Request} req
 * @param {string} reason
 */
function record(req, reason) {
  const level = SEVERITY[reason] ?? 'warn';

  // The precise reason goes here and **not** to the caller: knowing which check failed is
  // exactly what an attacker would use to work out what to change next.
  req.log[level]('session token rejected', { reason });
}
