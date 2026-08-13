import { ConfigurationError, formatIssues } from '@shopsage/platform';
import { z } from 'zod';

const settingsSchema = z.object({
  url: z.string().min(1).refine(isHttpUrl, { message: 'must be an absolute http(s) URL' }),
  collection: z
    .string()
    .min(1)
    .max(255)
    .regex(/^[A-Za-z0-9_-]+$/, 'must contain only letters, digits, hyphens and underscores'),
  dimensions: z.number().int().positive(),
  apiKey: z.string().min(1).optional(),
  timeoutMs: z.number().int().positive().default(10_000),
  maxAttempts: z.number().int().min(1).max(10).default(3),
});

/** @typedef {Readonly<z.infer<typeof settingsSchema>>} QdrantSettings */

/**
 * Validate and freeze the adapter's settings.
 *
 * The collection name is pattern-checked because it goes straight into a URL
 * path. It comes from configuration rather than from a request, so this is not
 * the front line - but a name with a slash in it would produce a baffling 404
 * rather than a clear configuration error.
 *
 * @param {import('../types.js').QdrantRepositoryOptions} options
 * @returns {QdrantSettings}
 * @throws {ConfigurationError} If any setting is missing or invalid.
 */
export function resolveQdrantSettings(options) {
  const result = settingsSchema.safeParse(options);

  if (!result.success) {
    throw new ConfigurationError('Vector repository configuration is invalid', {
      details: { issues: formatIssues(result.error) },
    });
  }

  return Object.freeze(result.data);
}

/**
 * Build an absolute Qdrant URL.
 *
 * Uses the base URL's own path as a prefix, so an instance behind a reverse
 * proxy at `/qdrant` works. `new URL(path, base)` would silently discard it.
 *
 * @param {QdrantSettings} settings
 * @param {string} pathname Path relative to the Qdrant root, without a leading slash.
 * @param {Record<string, string>} [query]
 * @returns {string}
 */
export function qdrantUrl(settings, pathname, query) {
  const url = new URL(settings.url);
  url.pathname = `${url.pathname.replace(/\/+$/, '')}/${pathname}`;

  for (const [key, value] of Object.entries(query ?? {})) {
    url.searchParams.set(key, value);
  }

  return url.toString();
}

/**
 * @param {QdrantSettings} settings
 * @returns {string} URL-safe collection path segment.
 */
export function collectionPath(settings) {
  return `collections/${settings.collection}`;
}

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
