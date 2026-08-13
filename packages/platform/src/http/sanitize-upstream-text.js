import { REDACTED } from '../logger/redact.js';

/** Enough of an error body to diagnose the failure, not enough to fill a log. */
const MAX_LENGTH = 500;

/** Below this length a "secret" is too generic to search and replace safely. */
const MIN_SECRET_LENGTH = 8;

/**
 * Credential shapes that providers echo back in error messages.
 *
 * Narrow on purpose. A pattern loose enough to catch every possible token also
 * redacts the words that explain the failure, and an error body nobody can read has
 * its own cost.
 */
const SECRET_LIKE_PATTERNS = [
  // Hyphens are part of the token, not a boundary: real keys look like
  // `sk-proj-Ab12...`, and stopping at the first separator masks nothing.
  /\b(?:sk|pk|rk)[_-][A-Za-z0-9_-]{8,}/g,
  /\bBearer\s+[A-Za-z0-9._-]{8,}/gi,
];

/**
 * Make an upstream error body safe to log.
 *
 * This exists because providers quote the credential back at you: OpenAI's own 401
 * body reads `Incorrect API key provided: sk-...`. Logging that verbatim writes the
 * key into log storage, which is usually retained longer and read more widely than
 * anything else in the system - a real leak, and a silent one.
 *
 * Lives in `platform` because every authenticated outbound client needs it and none
 * of them differ on it. It knows nothing about any provider: it is given a secret and
 * a string, and it removes the one from the other.
 *
 * Whitespace is collapsed so a multi-line body cannot break one-record-per-line log
 * parsing, or forge a second record.
 *
 * @param {string} text Raw upstream body.
 * @param {string} [secret] The credential this client presents.
 * @returns {string}
 */
export function sanitizeUpstreamText(text, secret) {
  if (typeof text !== 'string' || text === '') return '';

  const collapsed = text.replace(/\s+/g, ' ').trim();
  const withoutSecret =
    secret !== undefined && secret.length >= MIN_SECRET_LENGTH
      ? collapsed.split(secret).join(REDACTED)
      : collapsed;

  const masked = SECRET_LIKE_PATTERNS.reduce(
    (current, pattern) => current.replace(pattern, REDACTED),
    withoutSecret,
  );

  // Truncate last: cutting before masking could leave a partial credential.
  return masked.length > MAX_LENGTH ? `${masked.slice(0, MAX_LENGTH)}…` : masked;
}
