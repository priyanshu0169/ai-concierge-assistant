export const REDACTED = '[redacted]';

const MAX_DEPTH = 6;

/**
 * Key names whose values must never be written to a log sink.
 *
 * This is a defence in depth control, not a licence to log credentials. The
 * primary rule is still "do not pass secrets to the logger"; this catches the
 * cases where a secret rides along inside a config object or an HTTP header
 * bag that someone logged wholesale.
 *
 * `token(?!s)` is the one deliberately narrow clause. Credentials are singular
 * (`token`, `accessToken`, `MAGENTO_API_TOKEN`); *counts* are plural
 * (`promptTokens`, `totalTokens`, `maxTokens`). Matching the plural form
 * silently destroyed every LLM cost measurement the platform records - a
 * redaction rule that eats the data it was never meant to protect is not a
 * safer rule, it is a broken one. Nothing in ShopSage names a credential in the
 * plural, and a log record that reads `promptTokens: "[redacted]"` teaches
 * whoever sees it to stop trusting the redactor.
 */
const SENSITIVE_KEY_PATTERN =
  /(api[-_]?key|access[-_]?key|token(?!s)|secret|password|passwd|credential|authorization|auth|cookie|session[-_]?id|bearer|signature)/i;

/**
 * Recursively copy a value, replacing values under sensitive keys.
 *
 * Cycles are broken with a placeholder rather than throwing, because a logger
 * must never be the reason a request fails.
 *
 * @param {unknown} value
 * @param {{ depth?: number, seen?: WeakSet<object> }} [state]
 * @returns {unknown}
 */
export function redact(value, state = {}) {
  const { depth = 0, seen = new WeakSet() } = state;

  if (value === null || typeof value !== 'object') return value;
  if (depth >= MAX_DEPTH) return '[truncated]';
  if (seen.has(value)) return '[circular]';
  seen.add(value);

  if (Array.isArray(value)) {
    return value.map((item) => redact(item, { depth: depth + 1, seen }));
  }

  return redactObject(value, depth, seen);
}

/**
 * @param {object} source
 * @param {number} depth
 * @param {WeakSet<object>} seen
 * @returns {Record<string, unknown>}
 */
function redactObject(source, depth, seen) {
  /** @type {Record<string, unknown>} */
  const result = {};

  for (const [key, entry] of Object.entries(source)) {
    result[key] = SENSITIVE_KEY_PATTERN.test(key)
      ? REDACTED
      : redact(entry, { depth: depth + 1, seen });
  }

  return result;
}

/**
 * @param {string} key
 * @returns {boolean}
 */
export function isSensitiveKey(key) {
  return SENSITIVE_KEY_PATTERN.test(key);
}
