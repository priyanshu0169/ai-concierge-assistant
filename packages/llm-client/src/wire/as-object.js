/**
 * Narrow an unknown JSON value to an indexable record.
 *
 * Every field of a gateway response is untrusted: "OpenAI-compatible" endpoints
 * differ in which keys they send, send `null` where the spec implies an object,
 * and occasionally send a bare string on error. Treating a non-object as an
 * empty record lets the parsers read fields with `??` defaults instead of
 * guarding every access, and keeps a malformed response a normalization
 * problem rather than a `TypeError`.
 *
 * @param {unknown} value
 * @returns {Record<string, unknown>}
 */
export function asObject(value) {
  return value !== null && typeof value === 'object'
    ? /** @type {Record<string, unknown>} */ (value)
    : {};
}
