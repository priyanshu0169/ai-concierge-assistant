import { serializeError } from '../errors/serialize-error.js';
import { redact } from './redact.js';

/**
 * @typedef {object} BuildRecordInput
 * @property {string} level
 * @property {string} name
 * @property {string} message
 * @property {Date} time
 * @property {Record<string, unknown>} bindings Fields inherited from the parent logger.
 * @property {Record<string, unknown>} [fields] Fields supplied at the call site.
 */

/**
 * Shape a log record: merge bindings, serialize errors, strip secrets.
 *
 * Precedence is bindings first, then call-site fields, then the reserved
 * envelope keys. Reserved keys win so `time`/`level`/`msg` always mean what a
 * log query expects them to mean.
 *
 * @param {BuildRecordInput} input
 * @returns {Record<string, unknown>}
 */
export function buildRecord(input) {
  const { level, name, message, time, bindings, fields } = input;

  const merged = { ...bindings, ...fields };
  const normalized = normalizeErrorFields(merged);

  return {
    time: time.toISOString(),
    level,
    name,
    msg: message,
    .../** @type {Record<string, unknown>} */ (redact(normalized)),
  };
}

/**
 * Replace `Error` instances anywhere in the top level of the field bag with
 * their serialized form, so they survive JSON encoding.
 *
 * @param {Record<string, unknown>} fields
 * @returns {Record<string, unknown>}
 */
function normalizeErrorFields(fields) {
  /** @type {Record<string, unknown>} */
  const result = {};

  for (const [key, value] of Object.entries(fields)) {
    result[key] = value instanceof Error ? serializeError(value) : value;
  }

  return result;
}
