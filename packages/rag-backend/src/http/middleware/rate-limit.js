import { RateLimitError } from '@shopsage/platform';
import { createTokenBucket } from '../rate-limit/token-bucket.js';

/**
 * Throttle by client, and tell the client where it stands.
 *
 * Mounted on `/v1` only. Health endpoints are deliberately exempt: an orchestrator polls
 * readiness on a fixed interval and must never be throttled into reporting a false
 * outage, and liveness must not consult anything at all.
 *
 * **What a client is, today, is its IP address.** That is weaker than it sounds — an
 * address can be rotated, and behind a proxy it is only correct when `TRUST_PROXY` is on.
 * It is still worth having: the realistic threat to an unauthenticated, LLM-backed
 * endpoint is a runaway script or a single abusive caller, and both come from one address.
 * When authentication lands, the key becomes the authenticated subject and nothing else
 * here changes — which is why the key is a function rather than `req.ip` inline.
 *
 * @param {{
 *   windowMs: number,
 *   maxRequests: number,
 *   keyOf?: (req: import('express').Request) => string,
 *   now?: () => number,
 * }} options
 * @returns {import('express').RequestHandler}
 */
export function createRateLimitMiddleware(options) {
  const { keyOf = clientKey } = options;
  const bucket = createTokenBucket(options);

  return function rateLimit(req, res, next) {
    const decision = bucket.take(keyOf(req));

    // Sent on every response, not only on a rejection: a client that can see its budget
    // shrinking can slow down before it is refused.
    res.setHeader('RateLimit-Limit', decision.limit);
    res.setHeader('RateLimit-Remaining', decision.remaining);
    res.setHeader('RateLimit-Reset', decision.resetSeconds);

    if (decision.allowed) {
      next();
      return;
    }

    req.log.warn('request rate limited', {
      // The **key**, never the raw address unless that is already what is logged
      // elsewhere. Access logs carry `ip`; duplicating it here adds nothing and spreads
      // personal data across more records.
      limit: decision.limit,
      retryAfterSeconds: decision.retryAfterSeconds,
    });

    next(
      new RateLimitError('Too many requests', {
        details: { limit: decision.limit, windowSeconds: Math.round(options.windowMs / 1000) },
        retryAfterSeconds: decision.retryAfterSeconds,
      }),
    );
  };
}

/**
 * `req.ip` rather than the socket address directly, because Express resolves it against
 * the `trust proxy` setting. With a trusted proxy configured it is the real client; with
 * none, it is the socket peer.
 *
 * The misconfiguration to know about: `TRUST_PROXY=false` **behind** a proxy makes every
 * request appear to come from the proxy, so all customers share one bucket and the limiter
 * throttles everybody at once. `docs/Configuration.md` says so next to the setting.
 *
 * @param {import('express').Request} req
 * @returns {string}
 */
function clientKey(req) {
  return req.ip ?? 'unknown';
}
