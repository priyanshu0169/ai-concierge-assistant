import { ConfigurationError, formatIssues } from '@shopsage/platform';
import { z } from 'zod';

const COMPLETIONS_PATH = 'chat/completions';

/**
 * Client construction options.
 *
 * Not `.strict()`: the same object also carries the injected collaborators
 * (`logger`, `fetchImpl`, `sleep`, `random`), which zod strips. Typos in a
 * setting name are caught by `LlmClientOptions` at the type level instead.
 */
const settingsSchema = z.object({
  apiKey: z.string().min(1),
  baseUrl: z.string().min(1).refine(isHttpUrl, { message: 'must be an absolute http(s) URL' }),
  model: z.string().min(1),
  temperature: z.number().min(0).max(2).default(0.2),
  maxTokens: z.number().int().positive().default(1024),
  timeoutMs: z.number().int().positive().default(60_000),
  maxAttempts: z.number().int().min(1).max(10).default(3),
  authStyle: z.enum(['bearer', 'api-key']).default('bearer'),
  includeStreamUsage: z.boolean().default(true),
});

/**
 * @typedef {Readonly<z.infer<typeof settingsSchema> & { endpoint: string }>} LlmClientSettings
 */

/**
 * Validate and freeze the client's settings.
 *
 * Runs once, at construction, so a misconfigured gateway is a boot failure
 * rather than a surprise on a customer's first question.
 *
 * @param {import('./types.js').LlmClientOptions} options
 * @returns {LlmClientSettings}
 * @throws {ConfigurationError} If any setting is missing or invalid.
 */
export function resolveClientSettings(options) {
  const result = settingsSchema.safeParse(options);

  if (!result.success) {
    throw new ConfigurationError('LLM client configuration is invalid', {
      details: { issues: formatIssues(result.error) },
    });
  }

  return Object.freeze({ ...result.data, endpoint: resolveEndpoint(result.data.baseUrl) });
}

/**
 * Credential header for the configured authentication style.
 *
 * Two styles rather than one because Azure OpenAI is on the compatibility list
 * and authenticates with `api-key`; every other OpenAI-compatible gateway uses
 * a bearer token.
 *
 * @param {LlmClientSettings} settings
 * @returns {Record<string, string>}
 */
export function buildAuthHeaders(settings) {
  return settings.authStyle === 'api-key'
    ? { 'api-key': settings.apiKey }
    : { authorization: `Bearer ${settings.apiKey}` };
}

/**
 * Derive the chat-completions URL from the configured base.
 *
 * Accepts both an API base (`https://gateway/v1`) and a complete completions
 * URL, because Azure's path embeds a deployment name and an `api-version` query
 * that no amount of guessing would reconstruct. Query strings are preserved for
 * exactly that reason.
 *
 * No `/v1` is ever inferred: silently inventing a path segment turns a wrong
 * base URL into a 404 that looks like a missing model.
 *
 * @param {string} baseUrl
 * @returns {string}
 */
function resolveEndpoint(baseUrl) {
  const url = new URL(baseUrl);
  const basePath = url.pathname.replace(/\/+$/, '');

  if (basePath.endsWith(`/${COMPLETIONS_PATH}`)) return url.toString();

  url.pathname = `${basePath}/${COMPLETIONS_PATH}`;

  return url.toString();
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
