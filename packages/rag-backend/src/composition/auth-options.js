import { ConfigurationError } from '@shopsage/platform';

/**
 * Decide whether this instance authenticates, and refuse to guess in production.
 *
 * The same rule as `CONVERSATION_STORE` and `LLM_*`: configuration with no defensible
 * default is required rather than assumed. Off is a legitimate choice for a deployment
 * whose proxy already authenticates and a catastrophic accident anywhere else, and only an
 * operator knows which this is.
 *
 * @param {import('@shopsage/platform').EnvConfig} env
 * @returns {boolean}
 */
export function resolveAuthEnabled(env) {
  if (env.AUTH_ENABLED !== undefined) return env.AUTH_ENABLED;
  if (env.NODE_ENV !== 'production') return false;

  throw new ConfigurationError('Authentication is not configured', {
    details: {
      missing: ['AUTH_ENABLED'],
      remediation:
        'set AUTH_ENABLED=true with AUTH_ISSUER, AUTH_AUDIENCE and AUTH_JWKS_URL, or AUTH_ENABLED=false to accept unauthenticated requests',
    },
  });
}

/**
 * Map the environment onto what the verifier needs.
 *
 * The same seam as `llm-options.js` and the rest: `@shopsage/session-token` takes plain
 * options and knows nothing about ShopSage's configuration schema.
 *
 * `siteId` comes from the **site profile**, not the environment, and is compared against the
 * token's `sid`. That is the tenancy check: a correctly signed token minted for another
 * store must not work here, and this is the pairing that stops it.
 *
 * @param {{
 *   env: import('@shopsage/platform').EnvConfig,
 *   siteProfile: import('@shopsage/platform').SiteProfile,
 * }} config
 */
export function toAuthOptions(config) {
  const { env, siteProfile } = config;

  assertConfigured(env);

  return {
    issuer: /** @type {string} */ (env.AUTH_ISSUER),
    audience: /** @type {string} */ (env.AUTH_AUDIENCE),
    siteId: siteProfile.identity.siteId,
    algorithm: env.AUTH_ALGORITHM,
    clockSkewSeconds: env.AUTH_CLOCK_SKEW_SECONDS,
    jwksUrl: /** @type {string} */ (env.AUTH_JWKS_URL),
    jwksCacheTtlMs: env.AUTH_JWKS_CACHE_TTL_MS,
  };
}

/**
 * Require everything that has no defensible default, and name all of it at once.
 *
 * None of these can be guessed, and each one wrong produces a 401 on every request rather
 * than a message saying what to set — which is the difference between a five-minute fix and
 * an afternoon.
 *
 * @param {import('@shopsage/platform').EnvConfig} env
 * @throws {ConfigurationError}
 */
function assertConfigured(env) {
  /** @type {string[]} */
  const missing = [];

  if (env.AUTH_ISSUER === undefined) missing.push('AUTH_ISSUER');
  if (env.AUTH_AUDIENCE === undefined) missing.push('AUTH_AUDIENCE');
  if (env.AUTH_JWKS_URL === undefined) missing.push('AUTH_JWKS_URL');

  if (missing.length === 0) return;

  throw new ConfigurationError('Authentication configuration is incomplete', {
    details: {
      missing,
      remediation:
        'AUTH_ISSUER and AUTH_AUDIENCE must match what the Magento module mints (audience is shopsage-<store-id>); AUTH_JWKS_URL is its published key set',
    },
  });
}
