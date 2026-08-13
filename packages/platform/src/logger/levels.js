/**
 * Numeric severities. Higher wins; a logger emits a record when the record's
 * severity is greater than or equal to the configured threshold.
 */
export const LOG_LEVELS = Object.freeze({
  trace: 10,
  debug: 20,
  info: 30,
  warn: 40,
  error: 50,
  fatal: 60,
});

/** @typedef {keyof typeof LOG_LEVELS} LogLevel */

/** @type {readonly LogLevel[]} */
export const LOG_LEVEL_NAMES = Object.freeze(/** @type {LogLevel[]} */ (Object.keys(LOG_LEVELS)));

/**
 * @param {unknown} value
 * @returns {value is LogLevel}
 */
export function isLogLevel(value) {
  return typeof value === 'string' && Object.hasOwn(LOG_LEVELS, value);
}
