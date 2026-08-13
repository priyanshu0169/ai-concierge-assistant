import { getRequestPath } from '../request-path.js';

const NANOSECONDS_PER_MILLISECOND = 1_000_000n;

/**
 * Emit one structured record per completed request.
 *
 * The path comes from `getRequestPath`, which strips the query string - an
 * assistant API can carry customer text there, and access logs are the wrong
 * place for it. The request body is never logged for the same reason.
 *
 * @returns {import('express').RequestHandler}
 */
export function createRequestLoggerMiddleware() {
  return function logRequest(req, res, next) {
    const startedAt = process.hrtime.bigint();

    res.on('finish', () => {
      const durationMs = Number(
        (process.hrtime.bigint() - startedAt) / NANOSECONDS_PER_MILLISECOND,
      );

      req.log.info('request completed', {
        method: req.method,
        path: getRequestPath(req),
        status: res.statusCode,
        durationMs,
        ip: req.ip,
      });
    });

    next();
  };
}
