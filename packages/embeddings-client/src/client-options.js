import { ConfigurationError, formatIssues } from '@shopsage/platform';
import { z } from 'zod';
import { PROVIDER_NAMES } from './providers/index.js';

/**
 * `batchSize` ceiling of 128: hosted endpoints and TEI both reject an oversized batch,
 * and failing here names the setting rather than a status code.
 */
const settingsSchema = z.object({
  provider: z.enum(/** @type {[string, ...string[]]} */ (PROVIDER_NAMES)).default('openai'),
  baseUrl: z.string().min(1).refine(isHttpUrl, { message: 'must be an absolute http(s) URL' }),
  /** Absent for a self-hosted service on a private network; required by a gateway. */
  apiKey: z.string().min(1).optional(),
  authStyle: z.enum(['bearer', 'api-key']).default('bearer'),
  model: z.string().min(1),
  dimensions: z.number().int().positive(),
  batchSize: z.number().int().min(1).max(128).default(16),
  timeoutMs: z.number().int().positive().default(30_000),
  maxAttempts: z.number().int().min(1).max(10).default(3),
  queryPrefix: z.string().default(''),
});

/** @typedef {Readonly<z.infer<typeof settingsSchema>>} EmbeddingsSettings */

/**
 * Validate and freeze the client's settings.
 *
 * No path is resolved here any more. Where the embeddings route lives is a property of
 * the wire format, so each provider derives its own URLs from `baseUrl` - which is what
 * lets one base URL serve `/embeddings` for a gateway and `/embed` for TEI.
 *
 * @param {import('./types.js').EmbeddingsClientOptions} options
 * @returns {EmbeddingsSettings}
 * @throws {ConfigurationError} If any setting is missing or invalid.
 */
export function resolveEmbeddingsSettings(options) {
  const result = settingsSchema.safeParse(options);

  if (!result.success) {
    throw new ConfigurationError('Embeddings client configuration is invalid', {
      details: { issues: formatIssues(result.error) },
    });
  }

  return Object.freeze(result.data);
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
