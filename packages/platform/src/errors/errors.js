import { AppError } from './app-error.js';
import { ERROR_CODES } from './error-codes.js';

/**
 * Invalid or missing configuration. Raised during boot and intended to crash
 * the process: a misconfigured assistant is worse than an absent one.
 */
export class ConfigurationError extends AppError {
  /**
   * @param {string} message
   * @param {{ details?: Record<string, unknown>, cause?: unknown }} [options]
   */
  constructor(message, options = {}) {
    super(message, {
      ...options,
      code: ERROR_CODES.CONFIGURATION_INVALID,
      status: 500,
      expose: false,
    });
  }
}

/** Caller supplied input that failed validation. Safe to echo back. */
export class ValidationError extends AppError {
  /**
   * @param {string} message
   * @param {{ details?: Record<string, unknown>, cause?: unknown }} [options]
   */
  constructor(message, options = {}) {
    super(message, {
      ...options,
      code: ERROR_CODES.VALIDATION_FAILED,
      status: 400,
      expose: true,
    });
  }
}

/** The requested resource does not exist. */
export class NotFoundError extends AppError {
  /**
   * @param {string} message
   * @param {{ details?: Record<string, unknown>, cause?: unknown }} [options]
   */
  constructor(message, options = {}) {
    super(message, { ...options, code: ERROR_CODES.NOT_FOUND, status: 404, expose: true });
  }
}

/** Missing or unusable credentials. */
export class UnauthorizedError extends AppError {
  /**
   * @param {string} message
   * @param {{ details?: Record<string, unknown>, cause?: unknown }} [options]
   */
  constructor(message, options = {}) {
    super(message, { ...options, code: ERROR_CODES.UNAUTHORIZED, status: 401, expose: true });
  }
}

/**
 * A credential that was valid and is no longer.
 *
 * Its own class rather than an `UnauthorizedError` with a note, because a caller is meant
 * to branch on it: refresh and retry once, rather than stop. An expiry is routine — every
 * fifteen minutes by design — and must not look like a rejection.
 */
export class TokenExpiredError extends AppError {
  /**
   * @param {string} message
   * @param {{ details?: Record<string, unknown>, cause?: unknown }} [options]
   */
  constructor(message, options = {}) {
    super(message, { ...options, code: ERROR_CODES.TOKEN_EXPIRED, status: 401, expose: true });
  }
}

/** Known caller, insufficient permission. */
export class ForbiddenError extends AppError {
  /**
   * @param {string} message
   * @param {{ details?: Record<string, unknown>, cause?: unknown }} [options]
   */
  constructor(message, options = {}) {
    super(message, { ...options, code: ERROR_CODES.FORBIDDEN, status: 403, expose: true });
  }
}

/** Caller exceeded an allowed request rate. */
export class RateLimitError extends AppError {
  /**
   * @param {string} message
   * @param {{ details?: Record<string, unknown>, cause?: unknown, retryAfterSeconds?: number }} [options]
   */
  constructor(message, options = {}) {
    super(message, {
      ...options,
      code: ERROR_CODES.RATE_LIMITED,
      status: 429,
      expose: true,
      retryable: true,
    });
  }
}

/** An operation exceeded its time budget. Retryable by definition. */
export class TimeoutError extends AppError {
  /**
   * @param {string} message
   * @param {{ details?: Record<string, unknown>, cause?: unknown }} [options]
   */
  constructor(message, options = {}) {
    super(message, {
      ...options,
      code: ERROR_CODES.TIMEOUT,
      status: 504,
      expose: false,
      retryable: true,
    });
  }
}

/**
 * A downstream dependency failed. Used by every outbound client (LLM gateway,
 * embeddings, Qdrant, Magento) so callers can handle dependency failure
 * uniformly without knowing which dependency failed.
 */
export class UpstreamError extends AppError {
  /**
   * @param {string} message
   * @param {{
   *   details?: Record<string, unknown>,
   *   cause?: unknown,
   *   retryable?: boolean,
   *   retryAfterSeconds?: number,
   * }} [options]
   */
  constructor(message, options = {}) {
    super(message, {
      retryable: true,
      ...options,
      code: ERROR_CODES.UPSTREAM_FAILURE,
      status: 502,
      expose: false,
    });
  }
}

/** A dependency is reachable but not ready. Drives readiness probes. */
export class ServiceUnavailableError extends AppError {
  /**
   * `retryAfterSeconds` is accepted here as well as on `RateLimitError`: "come back
   * later" is exactly what a 503 means, and a caller that is told *how much* later can
   * back off intelligently instead of hammering.
   *
   * @param {string} message
   * @param {{
   *   details?: Record<string, unknown>,
   *   cause?: unknown,
   *   retryAfterSeconds?: number,
   * }} [options]
   */
  constructor(message, options = {}) {
    super(message, {
      ...options,
      code: ERROR_CODES.SERVICE_UNAVAILABLE,
      status: 503,
      expose: true,
      retryable: true,
    });
  }
}
