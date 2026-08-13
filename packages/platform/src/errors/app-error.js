import { ERROR_CODES } from './error-codes.js';

/**
 * @typedef {object} AppErrorOptions
 * @property {import('./error-codes.js').ErrorCode} [code] Stable machine-readable code.
 * @property {number} [status] HTTP status to use if this error reaches an HTTP boundary.
 * @property {Record<string, unknown>} [details] Structured context. Must never contain secrets.
 * @property {unknown} [cause] The underlying error, preserved for logging.
 * @property {boolean} [retryable] Whether retrying the same operation could succeed.
 * @property {number} [retryAfterSeconds] Earliest point a retry is worth attempting.
 * @property {boolean} [expose] Whether `message` is safe to return to an external caller.
 */

/**
 * Base class for every deliberately raised error in ShopSage.
 *
 * The distinction that matters is `expose`: an exposed message is written for
 * an end user or API consumer, while an unexposed message is written for an
 * operator and is replaced by a generic string at the HTTP boundary. This is
 * what stops internal detail from leaking into the storefront.
 */
export class AppError extends Error {
  /**
   * @param {string} message
   * @param {AppErrorOptions} [options]
   */
  constructor(message, options = {}) {
    const {
      code = ERROR_CODES.INTERNAL_ERROR,
      status = 500,
      details,
      cause,
      retryable = false,
      retryAfterSeconds,
      expose = status < 500,
    } = options;

    super(message, cause === undefined ? undefined : { cause });

    this.name = new.target.name;
    this.code = code;
    this.status = status;
    this.retryable = retryable;
    this.expose = expose;
    /**
     * How long to wait before retrying, when the failing party said so.
     *
     * Lives on the base class rather than only on `RateLimitError` because
     * `withRetry` honours it generically: any error that knows when it may be
     * retried should be able to say so, whoever raised it.
     *
     * @type {number | undefined}
     */
    this.retryAfterSeconds = retryAfterSeconds;
    /** @type {Record<string, unknown> | undefined} */
    this.details = details;

    Error.captureStackTrace?.(this, new.target);
  }

  /**
   * Serialize for structured logging. Never includes the stack of the cause
   * chain - the logger handles that separately.
   *
   * @returns {Record<string, unknown>}
   */
  toJSON() {
    return {
      name: this.name,
      code: this.code,
      status: this.status,
      message: this.message,
      retryable: this.retryable,
      ...(this.retryAfterSeconds === undefined
        ? {}
        : { retryAfterSeconds: this.retryAfterSeconds }),
      ...(this.details === undefined ? {} : { details: this.details }),
    };
  }

  /**
   * @param {unknown} value
   * @returns {value is AppError}
   */
  static is(value) {
    return value instanceof AppError;
  }
}
