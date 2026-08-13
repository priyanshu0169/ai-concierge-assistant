import { buildErrorEnvelope } from '../error-envelope.js';
import { getRequestPath } from '../request-path.js';
import { toAppError } from './to-app-error.js';

/**
 * Terminal error handler. Produces the single error envelope used by the whole
 * API, so clients - including the widget - only ever parse one shape.
 *
 * The envelope itself lives in `error-envelope.js`, shared with the streaming route,
 * which cannot reach this middleware: by the time a stream fails its status line is
 * already sent.
 *
 * @param {{ includeStack?: boolean }} [options] Stacks are for local debugging only.
 * @returns {import('express').ErrorRequestHandler}
 */
export function createErrorHandlerMiddleware(options = {}) {
  const { includeStack = false } = options;

  return function handleError(error, req, res, next) {
    // Once the response has started there is no way to send an envelope;
    // delegate to Express so it destroys the connection.
    if (res.headersSent) {
      next(error);
      return;
    }

    const appError = toAppError(error);
    logError(req, appError);

    // `Retry-After` is the one piece of an error that belongs in a header rather than the
    // body: HTTP clients, proxies and browsers act on it automatically, and a caller that
    // is told how long to wait backs off instead of hammering. Set here, from the error
    // itself, so every error that carries a wait says so — rather than each throw site
    // remembering to set a header.
    if (appError.retryAfterSeconds !== undefined) {
      res.setHeader('Retry-After', Math.ceil(appError.retryAfterSeconds));
    }

    res
      .status(appError.status)
      .json(buildErrorEnvelope({ error: appError, requestId: req.requestId, includeStack }));
  };
}

/**
 * @param {import('express').Request} req
 * @param {import('@shopsage/platform').AppError} appError
 */
function logError(req, appError) {
  const isClientError = appError.status < 500;
  const message = isClientError ? 'request rejected' : 'request failed';
  const fields = { method: req.method, path: getRequestPath(req), err: appError };

  if (isClientError) {
    req.log.warn(message, fields);
    return;
  }

  req.log.error(message, fields);
}
