import { randomUUID } from 'node:crypto';

const REQUEST_ID_HEADER = 'x-request-id';
const MAX_INBOUND_LENGTH = 128;
const SAFE_ID_PATTERN = /^[A-Za-z0-9._:-]+$/;

/**
 * Assign a correlation id to every request and expose a request-scoped logger.
 *
 * An inbound `x-request-id` is honoured so a trace started by the Magento
 * storefront or an API gateway continues through ShopSage - but it is
 * validated first. The header is attacker-controlled and lands in log storage,
 * so an unbounded or newline-bearing value would be a log injection vector.
 *
 * @param {{ logger: import('@shopsage/platform').Logger }} dependencies
 * @returns {import('express').RequestHandler}
 */
export function createRequestIdMiddleware(dependencies) {
  const { logger } = dependencies;

  return function attachRequestId(req, res, next) {
    const inbound = req.get(REQUEST_ID_HEADER);
    const requestId = isUsableRequestId(inbound) ? inbound : randomUUID();

    req.requestId = requestId;
    req.log = logger.child({ requestId });
    res.setHeader(REQUEST_ID_HEADER, requestId);

    next();
  };
}

/**
 * @param {string | undefined} value
 * @returns {value is string}
 */
function isUsableRequestId(value) {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= MAX_INBOUND_LENGTH &&
    SAFE_ID_PATTERN.test(value)
  );
}
