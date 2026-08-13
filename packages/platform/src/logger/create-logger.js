import { buildRecord } from './build-record.js';
import { resolveFormatter } from './format-record.js';
import { LOG_LEVELS, isLogLevel } from './levels.js';

/**
 * @typedef {object} LogSink
 * @property {(chunk: string) => unknown} write
 */

/**
 * @typedef {(message: string, fields?: Record<string, unknown>) => void} LogFn
 */

/**
 * @typedef {object} Logger
 * @property {import('./levels.js').LogLevel} level
 * @property {LogFn} trace
 * @property {LogFn} debug
 * @property {LogFn} info
 * @property {LogFn} warn
 * @property {LogFn} error
 * @property {LogFn} fatal
 * @property {(bindings: Record<string, unknown>) => Logger} child Derive a logger carrying extra fields.
 * @property {(level: import('./levels.js').LogLevel) => boolean} isLevelEnabled
 */

/**
 * @typedef {object} CreateLoggerOptions
 * @property {import('./levels.js').LogLevel} [level] Minimum severity to emit. Default `info`.
 * @property {string} [name] Logger name, emitted as `name`. Default `shopsage`.
 * @property {Record<string, unknown>} [bindings] Fields added to every record.
 * @property {LogSink} [sink] Where records are written. Default `process.stdout`.
 * @property {'json' | 'pretty'} [format] Wire format. Default `json`.
 * @property {() => Date} [clock] Injectable clock, for deterministic tests.
 */

/**
 * Create a structured logger.
 *
 * Deliberately dependency-free. A logging library would bring transports,
 * worker threads and a plugin system we do not need; what we do need is
 * guaranteed secret redaction and correlation-id propagation, which is easier
 * to guarantee in sixty lines we own. See docs/adr/0007.
 *
 * Records are written as one JSON object per line to stdout, following the
 * twelve-factor rule that a process logs to its stream and the platform owns
 * routing.
 *
 * @param {CreateLoggerOptions} [options]
 * @returns {Logger}
 */
export function createLogger(options = {}) {
  const {
    level = 'info',
    name = 'shopsage',
    bindings = {},
    sink = process.stdout,
    format = 'json',
    clock = () => new Date(),
  } = options;

  const effectiveLevel = isLogLevel(level) ? level : 'info';
  const threshold = LOG_LEVELS[effectiveLevel];
  const formatRecord = resolveFormatter(format);

  /**
   * @param {import('./levels.js').LogLevel} levelName
   * @param {string} message
   * @param {Record<string, unknown>} [fields]
   */
  function write(levelName, message, fields) {
    if (LOG_LEVELS[levelName] < threshold) return;

    const record = buildRecord({
      level: levelName,
      name,
      message,
      time: clock(),
      bindings,
      fields,
    });

    sink.write(formatRecord(record));
  }

  return {
    level: effectiveLevel,
    trace: (message, fields) => write('trace', message, fields),
    debug: (message, fields) => write('debug', message, fields),
    info: (message, fields) => write('info', message, fields),
    warn: (message, fields) => write('warn', message, fields),
    error: (message, fields) => write('error', message, fields),
    fatal: (message, fields) => write('fatal', message, fields),
    isLevelEnabled: (candidate) => LOG_LEVELS[candidate] >= threshold,
    child: (extraBindings) =>
      createLogger({ ...options, bindings: { ...bindings, ...extraBindings } }),
  };
}
