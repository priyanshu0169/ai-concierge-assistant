import { ConfigurationError } from '@shopsage/platform';

/**
 * Settings with no defensible default. A gateway address, a credential and a
 * model name cannot be guessed, and an assistant without them cannot do its
 * only job.
 */
const REQUIRED_VARIABLES = ['LLM_API_KEY', 'LLM_BASE_URL', 'LLM_MODEL'];

/**
 * Map the environment onto `@shopsage/llm-client` options.
 *
 * This is the seam that keeps the LLM client independent of ShopSage's
 * environment schema: the client takes plain options, and this function - inside
 * the composition root, the only place allowed to know about `process.env` - is
 * the single translation between the two.
 *
 * It is also where the LLM configuration becomes **mandatory**. The shared
 * environment schema keeps `LLM_*` optional because the ingestion CLI and
 * scraper never call a model; requiring it here means the *backend* refuses to
 * start without it, while entry points that do not need a gateway are not forced
 * to carry credentials for one. See docs/adr/0013.
 *
 * @param {import('@shopsage/platform').EnvConfig} env
 * @returns {import('@shopsage/llm-client').LlmClientOptions}
 * @throws {ConfigurationError} If any required variable is absent.
 */
export function toLlmClientOptions(env) {
  assertGatewayConfigured(env);

  return {
    apiKey: /** @type {string} */ (env.LLM_API_KEY),
    baseUrl: /** @type {string} */ (env.LLM_BASE_URL),
    model: /** @type {string} */ (env.LLM_MODEL),
    temperature: env.LLM_TEMPERATURE,
    maxTokens: env.LLM_MAX_TOKENS,
    timeoutMs: env.LLM_TIMEOUT_MS,
    maxAttempts: env.LLM_MAX_ATTEMPTS,
    authStyle: env.LLM_AUTH_STYLE,
    includeStreamUsage: env.LLM_STREAM_INCLUDE_USAGE,
  };
}

/**
 * Report every missing variable at once.
 *
 * One variable per boot attempt is a miserable way to configure a service, and
 * the error names the variables rather than the client's option names so the
 * message matches what the operator actually edits.
 *
 * @param {import('@shopsage/platform').EnvConfig} env
 * @throws {ConfigurationError}
 */
function assertGatewayConfigured(env) {
  const source = /** @type {Record<string, unknown>} */ (env);
  const missing = REQUIRED_VARIABLES.filter((name) => source[name] === undefined);

  if (missing.length === 0) return;

  throw new ConfigurationError('LLM gateway configuration is incomplete', {
    details: {
      missing,
      remediation: 'set these variables in the environment; see docs/Configuration.md',
    },
  });
}
