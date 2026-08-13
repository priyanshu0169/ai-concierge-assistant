/**
 * @typedef {object} LogRecord
 * @property {string} time
 * @property {string} level
 * @property {string} name
 * @property {string} msg
 */

/**
 * Serialize a log record as a single line of JSON.
 *
 * Single-line JSON is the production format: it survives container log
 * collection and is directly queryable in any log aggregator.
 *
 * @param {Record<string, unknown>} record
 * @returns {string}
 */
export function formatJson(record) {
  return `${JSON.stringify(record)}\n`;
}

/**
 * Serialize a log record for human consumption.
 *
 * Development only. Never enable in production: this format is lossy and
 * cannot be parsed reliably.
 *
 * @param {Record<string, unknown>} record
 * @returns {string}
 */
export function formatPretty(record) {
  const { time, level, name, msg, ...rest } = record;
  const label = String(level ?? 'info')
    .toUpperCase()
    .padEnd(5);
  const context = Object.keys(rest).length > 0 ? ` ${JSON.stringify(rest)}` : '';

  return `${String(time)} ${label} [${String(name)}] ${String(msg)}${context}\n`;
}

/**
 * @param {'json' | 'pretty'} format
 * @returns {(record: Record<string, unknown>) => string}
 */
export function resolveFormatter(format) {
  return format === 'pretty' ? formatPretty : formatJson;
}
