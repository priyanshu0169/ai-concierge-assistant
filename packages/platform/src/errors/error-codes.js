/**
 * Stable, machine-readable error codes.
 *
 * These codes are part of the public API contract: they appear in HTTP error
 * responses and in logs, and clients (including the widget) may branch on
 * them. Treat renaming a code as a breaking change.
 */
export const ERROR_CODES = Object.freeze({
  /** Malformed or semantically invalid input from the caller. */
  VALIDATION_FAILED: 'VALIDATION_FAILED',
  /** The caller did not supply usable credentials. */
  UNAUTHORIZED: 'UNAUTHORIZED',
  /**
   * The credential was well-formed and correctly signed, but has expired.
   *
   * Distinct from `UNAUTHORIZED` because the correct client response differs: a
   * widget seeing this refreshes its session token and retries once, while
   * `UNAUTHORIZED` means stop. Collapsing the two would make an expiry — which
   * is routine, every fifteen minutes — indistinguishable from a real
   * rejection. See docs/proposals/0001-assistant-session-token.md.
   */
  TOKEN_EXPIRED: 'TOKEN_EXPIRED',
  /** The caller is known but not permitted to perform the action. */
  FORBIDDEN: 'FORBIDDEN',
  /** The addressed resource does not exist. */
  NOT_FOUND: 'NOT_FOUND',
  /** The caller exceeded an allowed request rate. */
  RATE_LIMITED: 'RATE_LIMITED',
  /** An operation exceeded its time budget. */
  TIMEOUT: 'TIMEOUT',
  /** A downstream dependency failed or returned an unusable response. */
  UPSTREAM_FAILURE: 'UPSTREAM_FAILURE',
  /** A dependency is reachable but not ready to serve traffic. */
  SERVICE_UNAVAILABLE: 'SERVICE_UNAVAILABLE',
  /** Invalid or missing configuration; almost always fatal at boot. */
  CONFIGURATION_INVALID: 'CONFIGURATION_INVALID',
  /** Unclassified failure. Anything reaching a client with this code is a bug. */
  INTERNAL_ERROR: 'INTERNAL_ERROR',
});

/** @typedef {(typeof ERROR_CODES)[keyof typeof ERROR_CODES]} ErrorCode */
