import { AppError } from './app-error.js';

const MAX_CAUSE_DEPTH = 4;

/**
 * Convert an unknown thrown value into a plain, log-safe object.
 *
 * Node's default JSON serialization of `Error` produces `{}`, which silently
 * destroys diagnostics. Every log path routes errors through here instead.
 *
 * @param {unknown} value The thrown value. May be anything.
 * @param {number} [depth] Internal recursion guard for the `cause` chain.
 * @returns {Record<string, unknown>}
 */
export function serializeError(value, depth = 0) {
  if (!(value instanceof Error)) {
    return { name: 'NonError', message: safeStringify(value) };
  }

  const base = AppError.is(value) ? value.toJSON() : { name: value.name, message: value.message };

  /** @type {Record<string, unknown>} */
  const serialized = { ...base, stack: value.stack };

  const cause = /** @type {{ cause?: unknown }} */ (value).cause;
  if (cause !== undefined && depth < MAX_CAUSE_DEPTH) {
    serialized.cause = serializeError(cause, depth + 1);
  }

  return serialized;
}

/**
 * @param {unknown} value
 * @returns {string}
 */
function safeStringify(value) {
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}
