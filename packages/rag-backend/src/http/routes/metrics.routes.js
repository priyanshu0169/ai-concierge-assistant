import { Router } from 'express';
import { timingSafeEqual } from 'node:crypto';
import { Buffer } from 'node:buffer';
import { UnauthorizedError } from '@shopsage/platform';

/**
 * `GET /metrics`, in the Prometheus exposition format.
 *
 * **Guarded, and not because metrics are secret in principle.** This payload says how many customers
 * asked questions today, how many tokens the store paid for, which dependencies are failing and how
 * often the assistant cannot answer. For a competitor that is a free business intelligence feed, and for
 * anybody probing it is a map of what is currently broken. So it takes a bearer token.
 *
 * Mounted outside `/v1`, deliberately. A scraper is not a customer: it holds an operator credential
 * rather than a session token, it must not be rate limited alongside customer traffic, and it should not
 * stop working the day `/v1` becomes `/v2`. The same reasoning that keeps `/health` unversioned.
 *
 * @param {{
 *   render: () => string,
 *   token: string,
 * }} dependencies
 * @returns {import('express').Router}
 */
export function createMetricsRouter(dependencies) {
  const expected = Buffer.from(dependencies.token, 'utf8');
  const router = Router();

  router.get('/metrics', (req, res) => {
    if (!isAuthorised(req.get('authorization'), expected)) {
      // A 401 with no detail. A scraper misconfiguration is diagnosed from the scraper's own logs, and
      // saying which part was wrong helps somebody guessing more than it helps an operator.
      throw new UnauthorizedError('A metrics credential is required');
    }

    // `version=0.0.4` is the exposition format's own version and is what scrapers content-negotiate on.
    // Omitting it works with Prometheus and confuses stricter agents.
    res.type('text/plain; version=0.0.4; charset=utf-8').send(dependencies.render());
  });

  return router;
}

/**
 * Constant-time comparison, and the length check that has to come first.
 *
 * `timingSafeEqual` throws on a length mismatch rather than returning false, so the lengths are compared
 * before the contents — which leaks the credential's length. That is a real leak and an acceptable one:
 * knowing a token is 43 characters long does not measurably help guess it, whereas a byte-by-byte
 * early-exit comparison genuinely does.
 *
 * @param {string | undefined} header
 * @param {Buffer} expected
 * @returns {boolean}
 */
function isAuthorised(header, expected) {
  const match = /^Bearer (?<token>.+)$/u.exec(header ?? '');

  if (match?.groups === undefined) return false;

  const supplied = Buffer.from(match.groups.token, 'utf8');

  return supplied.length === expected.length && timingSafeEqual(supplied, expected);
}
