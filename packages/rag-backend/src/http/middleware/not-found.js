import { NotFoundError } from '@shopsage/platform';
import { getRequestPath } from '../request-path.js';

/**
 * Convert unmatched routes into the standard error envelope.
 *
 * Registered after all routers and before the error handler, so a typo in a
 * client URL produces the same response shape as every other failure.
 *
 * @param {import('express').Request} req
 * @param {import('express').Response} _res
 * @param {import('express').NextFunction} next
 */
export function handleNotFound(req, _res, next) {
  next(new NotFoundError(`Route not found: ${req.method} ${getRequestPath(req)}`));
}
