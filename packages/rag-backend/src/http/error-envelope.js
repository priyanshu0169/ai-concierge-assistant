import { toAppError } from './middleware/to-app-error.js';

const GENERIC_MESSAGE = 'An unexpected error occurred. Please try again.';

/**
 * The single error shape the whole API produces:
 *
 * ```json
 * { "error": { "code": "...", "message": "...", "requestId": "..." } }
 * ```
 *
 * Extracted from the error middleware in Stage 7 because a second delivery path needed
 * it. A streamed response cannot use the middleware - its status line was sent before the
 * failure happened - so it has to build the envelope itself. Building a *second* one
 * would mean two implementations of the rule that matters here: a 5xx message never
 * reaches a client, because internal messages routinely carry dependency hostnames,
 * ports and query fragments. One of the two copies would eventually stop masking.
 *
 * @param {{ error: unknown, requestId: string, includeStack?: boolean }} input
 * @returns {{ error: Record<string, unknown> }}
 */
export function buildErrorEnvelope(input) {
  const { requestId, includeStack = false } = input;
  const appError = toAppError(input.error);

  return {
    error: {
      code: appError.code,
      message: appError.expose ? appError.message : GENERIC_MESSAGE,
      requestId,
      ...(appError.expose && appError.details ? { details: appError.details } : {}),
      ...(includeStack && appError.stack ? { stack: appError.stack } : {}),
    },
  };
}
