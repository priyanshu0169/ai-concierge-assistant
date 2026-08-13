import { z } from 'zod';
import { ConfigurationError } from '../errors/errors.js';
import { formatIssues } from '../validation/format-issues.js';
import { booleanFlag, csvList, httpUrl } from './zod-helpers.js';

const positiveInt = () => z.coerce.number().int().positive();

/**
 * Environment schema.
 *
 * Scope rule: this file describes INFRASTRUCTURE and SECRETS only - where
 * things are, how long to wait, which credential to present. Customer-facing
 * behaviour lives in the site profile. If a new setting would ever differ
 * between two stores running the same deployment, it does not belong here.
 *
 * See docs/adr/0004 and docs/Configuration.md.
 */
export const envSchema = z.object({
  // --- Runtime ---
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  SERVICE_NAME: z.string().min(1).default('shopsage-backend'),
  LOG_LEVEL: z.enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal']).default('info'),
  LOG_FORMAT: z.enum(['json', 'pretty']).default('json'),
  SITE_PROFILE_PATH: z.string().min(1).default('./config/site-profile.json'),

  // --- HTTP ---
  CORS_ALLOWED_ORIGINS: csvList().default('*'),
  REQUEST_TIMEOUT_MS: positiveInt().default(30_000),
  SHUTDOWN_TIMEOUT_MS: positiveInt().default(10_000),
  /**
   * Enable only when the service really is behind a trusted reverse proxy.
   * Trusting `X-Forwarded-For` unconditionally would let any caller spoof the
   * client IP that rate limiting and audit logs depend on.
   */
  TRUST_PROXY: booleanFlag().default('false'),

  /**
   * --- LLM gateway (any OpenAI-compatible endpoint) ---
   *
   * Optional *in this schema*, mandatory for any process that answers a
   * customer. The schema is shared by every entry point, and the ingestion CLI
   * and scraper never call a model - forcing them to carry gateway credentials
   * they will not use would be a false dependency. The backend's composition
   * root requires them and refuses to boot without them. See docs/adr/0013.
   */
  LLM_API_KEY: z.string().min(1).optional(),
  LLM_BASE_URL: httpUrl().optional(),
  LLM_MODEL: z.string().min(1).optional(),
  LLM_TEMPERATURE: z.coerce.number().min(0).max(2).default(0.2),
  LLM_MAX_TOKENS: positiveInt().default(1024),
  /** Per-attempt budget, not a total: `LLM_MAX_ATTEMPTS` multiplies it. */
  LLM_TIMEOUT_MS: positiveInt().default(60_000),
  LLM_MAX_ATTEMPTS: positiveInt().max(10).default(3),
  /** Azure OpenAI authenticates with an `api-key` header; everyone else uses a bearer token. */
  LLM_AUTH_STYLE: z.enum(['bearer', 'api-key']).default('bearer'),
  /**
   * Ask the gateway for token counts on streamed responses. On by default
   * because cost visibility should not be opt-in; disable it for the stricter
   * gateways that reject the unrecognised `stream_options` field.
   */
  LLM_STREAM_INCLUDE_USAGE: z
    .enum(['true', 'false'])
    .default('true')
    .transform((value) => value === 'true'),

  /**
   * --- Embeddings ---
   *
   * Backend-agnostic. `openai` speaks the OpenAI embeddings wire format to any
   * compatible endpoint - typically the same gateway the LLM uses, with the same
   * credential. `tei` speaks to a self-hosted HuggingFace inference server.
   *
   * Switching between them is these variables and a re-ingestion; no application
   * code knows which is configured. See docs/adr/0018.
   */
  EMBEDDING_PROVIDER: z.enum(['openai', 'tei']).default('openai'),
  EMBEDDING_BASE_URL: httpUrl().optional(),
  /** Omitted for a self-hosted service on a private network. */
  EMBEDDING_API_KEY: z.string().min(1).optional(),
  EMBEDDING_AUTH_STYLE: z.enum(['bearer', 'api-key']).default('bearer'),
  EMBEDDING_MODEL: z.string().min(1).default('text-embedding-3-small'),
  /**
   * Must match the model's native output width. A mismatch is rejected on every
   * response rather than silently corrupting similarity: 1536 for
   * `text-embedding-3-small`, 1024 for `BAAI/bge-m3`, 384 for `bge-small-en-v1.5`.
   */
  EMBEDDING_DIMENSIONS: positiveInt().default(1536),
  /** Documents per request. Both backends reject an oversized batch. */
  EMBEDDING_BATCH_SIZE: positiveInt().max(128).default(16),
  /** Generous: CPU inference over a batch is slow, and a gateway can be too. */
  EMBEDDING_TIMEOUT_MS: positiveInt().default(30_000),
  /**
   * Instruction prepended to queries only, never to documents.
   *
   * Empty for `text-embedding-3-small` and `bge-m3`, which need none. It exists
   * because the smaller BGE models were trained with an asymmetric query
   * instruction, and omitting it degrades retrieval with no error at all.
   */
  EMBEDDING_QUERY_PREFIX: z.string().default(''),

  // --- Vector database ---
  /**
   * `localhost`, not the Docker service name — and this default can never actually run
   * inside Docker, which is exactly why. `docker-compose.yml` hardcodes `QDRANT_URL` in
   * the backend service's own `environment:` block, and a compose `environment:` entry
   * always wins over a value from `.env` (`env_file:`) for the same key — so this
   * default, and anything `.env` sets for the same variable, is dead code for the
   * container. It only ever fires for a bare `node` process with no `.env` at all: the
   * ingestion CLI, a test runner, a script someone wrote - and Qdrant's container port
   * is published to the host precisely so that case works. See docs/Docker.md.
   */
  QDRANT_URL: httpUrl().default('http://localhost:6333'),
  QDRANT_API_KEY: z.string().min(1).optional(),
  QDRANT_COLLECTION: z.string().min(1).default('shopsage_knowledge'),
  QDRANT_TIMEOUT_MS: positiveInt().default(10_000),

  // --- Authentication (Magento-issued session tokens) ---
  /**
   * Deliberately no default in production.
   *
   * Serving an unauthenticated assistant is a legitimate choice for a deployment behind a
   * VPN whose proxy already authenticates, and a catastrophic accident everywhere else.
   * Requiring the decision means nobody arrives at it by forgetting - the same rule as
   * `CONVERSATION_STORE` (ADR 0024) and `LLM_*` (ADR 0013). Outside production it defaults
   * to off, so a developer needs no Magento to ask a question.
   */
  AUTH_ENABLED: booleanFlag().optional(),
  /** Expected `iss`. The Magento instance that mints tokens. */
  AUTH_ISSUER: z.string().min(1).optional(),
  /**
   * Expected `aud`, store-specific by agreement: `shopsage-<store-id>`.
   *
   * Store-specific so that one Magento estate cannot have a token minted for one
   * deployment accepted by another.
   */
  AUTH_AUDIENCE: z.string().min(1).optional(),
  AUTH_JWKS_URL: httpUrl().optional(),
  /**
   * The algorithm this deployment will perform, pinned.
   *
   * Never read from the token: choosing a verification method from a value the caller
   * supplies is the classic JWT break. `HS256` is absent permanently - a symmetric key
   * would let ShopSage mint tokens, so a compromise here would become an identity
   * compromise for the store.
   */
  AUTH_ALGORITHM: z.enum(['ES256', 'RS256']).default('ES256'),
  /** Two servers, two clocks. Without tolerance, drift produces inexplicable 401s. */
  AUTH_CLOCK_SKEW_SECONDS: positiveInt().default(60),
  AUTH_JWKS_CACHE_TTL_MS: positiveInt().default(600_000),

  // --- Metrics ---
  /**
   * Publish `GET /metrics` in the Prometheus exposition format.
   *
   * Off by default, which is the opposite of the usual advice and right here: the endpoint publishes how
   * many customers asked questions, how many tokens the store paid for, and which dependencies are
   * failing. That is a business intelligence feed for a competitor and a map of what is broken for
   * anybody probing, so it exists when an operator asks for it rather than by default.
   */
  METRICS_ENABLED: booleanFlag().default('false'),
  /**
   * The scraper's credential. **Required whenever metrics are enabled** - the backend refuses to boot
   * with the endpoint on and no token, rather than serving it open.
   *
   * A bearer token rather than an IP allow-list, because the deployment topology is not knowable from
   * here: in Kubernetes the scraper's address is whatever the pod got today.
   */
  METRICS_TOKEN: z.string().min(16).optional(),

  // --- Rate limiting and capacity ---
  /**
   * Off is a deliberate, visible choice rather than the default.
   *
   * Both chat endpoints are unauthenticated and cost money per request, so shipping
   * without a ceiling is a cost-exhaustion risk before it is an availability one. An
   * operator who wants the proxy to own throttling can turn this off; nobody gets there
   * by forgetting.
   */
  RATE_LIMIT_ENABLED: booleanFlag().default('true'),
  RATE_LIMIT_WINDOW_MS: positiveInt().default(60_000),
  /**
   * Generous for a human, restrictive for a script. A customer sends a question every few
   * seconds at most; thirty a minute leaves room for impatience without leaving room for
   * a loop.
   */
  RATE_LIMIT_MAX_REQUESTS: positiveInt().default(30),
  /**
   * Streams are counted separately from requests because they are *held*, not spent.
   * Two per client covers a second browser tab and stops nothing legitimate.
   */
  MAX_CONCURRENT_STREAMS_PER_CLIENT: positiveInt().default(2),
  /**
   * The real cost ceiling: the most answers one process will generate at once, whatever
   * the number of clients under their individual limits.
   */
  MAX_CONCURRENT_STREAMS: positiveInt().default(50),

  // --- Conversation history ---
  /**
   * Which implementation of the `ConversationStore` port to use.
   *
   * Deliberately **no default**. `memory` is correct for development and for a single
   * replica, and silently wrong for two - some requests remember a conversation and some
   * do not, which reads as a flaky assistant rather than as a configuration mistake. Only
   * the operator knows the replica count, so the choice is theirs to make explicitly;
   * the backend supplies `memory` for itself outside production and refuses to guess
   * inside it. See ADR 0024 and `composition/conversation-store-options.js`.
   */
  CONVERSATION_STORE: z.enum(['memory', 'redis']).optional(),
  REDIS_URL: z
    .string()
    .regex(/^rediss?:\/\/.+/u, 'must be a redis:// or rediss:// URL')
    .optional(),
  REDIS_KEY_PREFIX: z.string().min(1).default('shopsage:conv'),
  /**
   * Per-operation budget, the same guarantee `QDRANT_TIMEOUT_MS` gives.
   *
   * A conversation read sits directly in a customer's request, so an unbounded one is a
   * hung page. Lower than the Qdrant default because this is a local, in-memory store:
   * if it has not answered in five seconds it is not going to.
   */
  REDIS_TIMEOUT_MS: positiveInt().default(5_000),

  /**
   * Capabilities the **synthetic guest session** holds when `AUTH_ENABLED=false`.
   *
   * Development only, and ignored entirely when authentication is on - a real session's scopes come
   * from a verified token and nothing else. This exists because with auth off a developer could not
   * exercise `orderTracking` or the cart at all, which made those paths unreachable outside a
   * deployment with a real issuer.
   *
   * Defaults to `chat` alone, deliberately. The synthetic session should look like the least
   * privileged real one, so the gating path is exercised locally rather than bypassed - a developer
   * seeing a superset of a guest's tools is how a gating bug survives until production. Widening it is
   * a decision an operator makes on purpose, and the backend warns when they have.
   */
  DEV_SESSION_SCOPES: csvList().default('chat'),

  // --- Commerce connector (HTTP only) ---
  /**
   * Where the store's commerce connector lives, ending before `/assistant/v1`.
   *
   * Optional in the schema and **required in practice**, but only when a commerce feature is
   * enabled - which the site profile decides, and this file cannot see. That check lives in the
   * composition root, where both halves are in scope: see `toCommerceClientOptions`. A store
   * running knowledge search only needs no connector at all, and demanding one would make every
   * such deployment carry a setting it will never use.
   */
  MAGENTO_API_URL: httpUrl().optional(),
  /**
   * ShopSage's **own** credential, identifying the service to the connector.
   *
   * Distinct from the customer's session token, which arrives per request and is forwarded. This
   * says "the caller is ShopSage"; the session token says "on behalf of this customer". Collapsing
   * them would make a stolen customer token sufficient to impersonate the service.
   */
  MAGENTO_API_TOKEN: z.string().min(1).optional(),
  /**
   * Per-call budget. Lower than the LLM's, because this sits inside a tool call that itself sits
   * inside a customer's request: the model still has to read the result and write an answer after
   * this returns, so the connector does not get to spend the whole turn.
   */
  MAGENTO_TIMEOUT_MS: positiveInt().default(5_000),
  /**
   * Attempts for an idempotent read. Two, not three: a commerce lookup is inside a turn a customer
   * is waiting through, and a third attempt buys little while the wait compounds. Writes will not
   * retry at any setting - that is a property of the adapter, not a number here.
   */
  MAGENTO_MAX_ATTEMPTS: positiveInt().default(2),
});

/** @typedef {z.infer<typeof envSchema>} EnvConfig */

/**
 * Validate raw environment variables.
 *
 * Empty values are treated as absent. Operators routinely leave `FOO=` in an
 * env file for a setting they have not filled in yet; interpreting that as the
 * empty string would defeat every default in the schema.
 *
 * @param {Record<string, string | undefined>} source Usually `process.env`.
 * @returns {EnvConfig}
 * @throws {ConfigurationError} If any variable is invalid.
 */
export function parseEnv(source) {
  const result = envSchema.safeParse(stripEmptyValues(source));

  if (!result.success) {
    throw new ConfigurationError('Environment configuration is invalid', {
      details: { issues: formatIssues(result.error) },
    });
  }

  return result.data;
}

/**
 * @param {Record<string, string | undefined>} source
 * @returns {Record<string, string>}
 */
function stripEmptyValues(source) {
  /** @type {Record<string, string>} */
  const cleaned = {};

  for (const [key, value] of Object.entries(source)) {
    if (typeof value === 'string' && value.trim().length > 0) {
      cleaned[key] = value;
    }
  }

  return cleaned;
}
