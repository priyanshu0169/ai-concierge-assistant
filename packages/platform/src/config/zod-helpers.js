import { z } from 'zod';

/**
 * @param {string} value
 * @returns {boolean}
 */
function isHttpUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}

/**
 * A string constrained to an absolute http(s) URL.
 *
 * Implemented with a refinement rather than zod's built-in URL check so the
 * accepted protocols are explicit and stable across zod versions.
 *
 * @returns {z.ZodEffects<z.ZodString, string, string>}
 */
export function httpUrl() {
  return z.string().refine(isHttpUrl, { message: 'must be an absolute http(s) URL' });
}

/**
 * A comma-separated environment value parsed into a trimmed, non-empty list.
 *
 * @returns {z.ZodEffects<z.ZodString, string[], string>}
 */
export function csvList() {
  return z.string().transform((value) =>
    value
      .split(',')
      .map((entry) => entry.trim())
      .filter((entry) => entry.length > 0),
  );
}

/**
 * An environment flag, written as `true` or `false`.
 *
 * Only those two spellings. The tempting alternative — treating any non-empty value as
 * true — makes `FLAG=false` mean **on**, which is the kind of thing that is discovered in
 * production by someone who thought they had disabled a feature.
 *
 * @returns {z.ZodEffects<z.ZodEnum<['true', 'false']>, boolean, 'true' | 'false'>}
 */
export function booleanFlag() {
  return z.enum(['true', 'false']).transform((value) => value === 'true');
}

/**
 * A hexadecimal CSS colour, e.g. `#1f2937`.
 *
 * @returns {z.ZodString}
 */
export function hexColor() {
  return z.string().regex(/^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/, 'must be a hex colour');
}

/**
 * A string that must compile as a regular expression.
 *
 * Crawl include/exclude patterns come from a site profile, and a malformed one
 * would otherwise throw partway through a crawl - after the pipeline had already
 * spent time and network on it. Compiling at boot turns that into a
 * configuration error naming the offending pattern.
 *
 * @returns {z.ZodEffects<z.ZodString, string, string>}
 */
export function regexPattern() {
  return z
    .string()
    .min(1)
    .refine(
      (value) => {
        try {
          new RegExp(value);
          return true;
        } catch {
          return false;
        }
      },
      { message: 'must be a valid regular expression' },
    );
}

/**
 * A URL-safe identifier used for site and collection names.
 *
 * @returns {z.ZodString}
 */
export function slug() {
  return z
    .string()
    .min(2)
    .max(64)
    .regex(/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/, 'must be a lowercase slug');
}
