import { createConversationManager, createMemoryConversationStore } from '@shopsage/assistant-core';
import { createConnection, createRedisConversationStore } from '@shopsage/conversation-store';
import { createKeyStore, verifyToken } from '@shopsage/session-token';
import { createEmbeddingsClient } from '@shopsage/embeddings-client';
import { createLlmClient } from '@shopsage/llm-client';
import { createLogger, loadConfig } from '@shopsage/platform';
import { createQdrantRepository } from '@shopsage/vector-repository';
import packageJson from '../../package.json' with { type: 'json' };
import { createApp } from '../app.js';
import { createKnowledgeRetriever } from '../retrieval/create-knowledge-retriever.js';
import {
  createAuthenticationMiddleware,
  createUnauthenticatedMiddleware,
} from '../http/middleware/authenticate.js';
import { instrumentAssistant } from '../observability/instrument-assistant.js';
import { observePorts } from '../observability/instrument-ports.js';
import { resolveAuthEnabled, toAuthOptions } from './auth-options.js';
import { buildCart } from './build-cart.js';
import { buildHealthService } from './build-health.js';
import { buildCommerceClient } from './build-commerce.js';
import { buildMetrics } from './build-metrics.js';
import { resolveConversationStore, toRedisStoreOptions } from './conversation-store-options.js';
import { toEmbeddingsClientOptions, toVectorRepositoryOptions } from './retrieval-options.js';
import { toLlmClientOptions } from './llm-options.js';

/**
 * @typedef {object} Application
 * @property {import('express').Express} app
 * @property {Readonly<import('@shopsage/platform').AppConfig>} config
 * @property {import('@shopsage/platform').Logger} logger
 * @property {import('../health/health-service.js').HealthService} healthService
 * @property {(() => Promise<void>)[]} onShutdown Resources the process must release.
 */

/**
 * The composition root.
 *
 * This is the only place in the backend allowed to read `process.env`,
 * construct concrete dependencies, or decide which implementation satisfies
 * which port. Every other module receives what it needs as an argument, which
 * is what keeps them unit-testable and keeps swapping a vector store or LLM
 * provider a single-file change.
 *
 * @param {{ env?: Record<string, string | undefined>, cwd?: string }} [options]
 * @returns {Promise<Application>}
 */
export async function buildApplication(options = {}) {
  const config = await loadConfig(options);
  const logger = createRootLogger(config);

  warnOnPermissiveCors(config, logger);

  // Built before anything it instruments, so a decorator never has to cope with a registry arriving
  // late. `undefined` when metrics are off, and every wrapping below is then a no-op by construction.
  const metrics = buildMetrics(config, logger);

  const { llmClient, embeddingsClient, vectorRepository } = buildOutboundClients(config, logger);

  const conversations = buildConversationStore(config, logger);
  const commerce = buildCommerceClient(config, logger);
  const cart = buildCart({ config, logger, conversations });
  const auth = buildAuthentication(config, logger);

  logGatewayConfiguration(config, logger);

  const healthService = buildHealthService({
    config,
    vectorRepository,
    embeddingsClient,
    conversations,
    cart,
    auth,
  });

  const { assistant, observed } = buildAssistant({
    config,
    logger,
    metrics,
    llmClient,
    embeddingsClient,
    vectorRepository,
    conversations,
    commerce,
    cart,
  });

  const app = createApp({
    config,
    logger,
    healthService,
    assistant,
    authentication: auth.middleware,
    ...(cart === undefined
      ? {}
      : {
          cart: {
            proposals: cart.proposals,
            cart: /** @type {import('@shopsage/assistant-core').CommerceCart} */ (observed.cart),
          },
        }),
    ...(metrics === undefined ? {} : { metrics }),
  });

  return {
    app,
    config,
    logger,
    healthService,
    onShutdown: [...conversations.onShutdown, ...(cart === undefined ? [] : cart.onShutdown)],
  };
}

/**
 * The outbound clients, constructed eagerly.
 *
 * Eagerly because each validates its own settings, so a misconfigured dependency is a boot failure with
 * a precise message rather than a 502 on a customer's first question (docs/adr/0013).
 *
 * @param {Readonly<import('@shopsage/platform').AppConfig>} config
 * @param {import('@shopsage/platform').Logger} logger
 */
function buildOutboundClients(config, logger) {
  return {
    llmClient: createLlmClient({
      ...toLlmClientOptions(config.env),
      logger: logger.child({ component: 'llm-client' }),
    }),
    embeddingsClient: createEmbeddingsClient({
      ...toEmbeddingsClientOptions(config.env),
      logger: logger.child({ component: 'embeddings-client' }),
    }),
    vectorRepository: createQdrantRepository({
      ...toVectorRepositoryOptions(config.env),
      logger: logger.child({ component: 'vector-repository' }),
    }),
  };
}

/**
 * Assemble the domain, and wrap what it was given.
 *
 * The line this whole arrangement exists for is in here: two concrete clients are combined into the
 * single `KnowledgeRetriever` port the domain declared, so the domain never learns that answering a
 * question involves embedding it.
 *
 * Then every port is wrapped in a counter **here** and nowhere else, and the manager itself last -
 * because the outcome of a turn is only visible from the reply it returns. `assistant-core` imports
 * nothing about metrics, no adapter carries a registry, and no test double had to change
 * (docs/adr/0030).
 *
 * @param {{
 *   config: Readonly<import('@shopsage/platform').AppConfig>,
 *   logger: import('@shopsage/platform').Logger,
 *   metrics: ReturnType<typeof buildMetrics>,
 *   llmClient: import('@shopsage/assistant-core').LanguageModel,
 *   embeddingsClient: import('@shopsage/embeddings-client').EmbeddingsClient,
 *   vectorRepository: import('@shopsage/vector-repository').VectorRepository,
 *   conversations: ReturnType<typeof buildConversationStore>,
 *   commerce: import('@shopsage/assistant-core').CommerceCatalogue | undefined,
 *   cart: ReturnType<typeof buildCart>,
 * }} input
 */
function buildAssistant(input) {
  const { config, logger, metrics, conversations, cart } = input;

  const retriever = createKnowledgeRetriever({
    embeddings: input.embeddingsClient,
    store: input.vectorRepository,
    logger: logger.child({ component: 'retrieval' }),
  });

  const observed = observePorts({
    metrics,
    modelName: /** @type {string} */ (config.env.LLM_MODEL),
    model: input.llmClient,
    retriever,
    store: conversations.store,
    commerce: input.commerce,
    cart: cart === undefined ? undefined : cart.cart,
  });

  const domainAssistant = createConversationManager({
    model: observed.model,
    retriever: observed.retriever,
    store: observed.store,
    // Absent for a knowledge-only store, and absent is a real state rather than a gap: the tool
    // registry offers no commerce tool without the matching feature flag, so nothing can reach for a
    // connector that is not here.
    ...(observed.commerce === undefined ? {} : { commerce: observed.commerce }),
    ...(cart === undefined ? {} : { proposals: cart.proposals }),
    siteProfile: config.siteProfile,
    logger: logger.child({ component: 'assistant-core' }),
  });

  return {
    observed,
    assistant:
      metrics === undefined
        ? domainAssistant
        : instrumentAssistant({
            assistant: domainAssistant,
            instruments: metrics.instruments,
            noAnswerMessage: config.siteProfile.prompts.noAnswerMessage,
          }),
  };
}

/**
 * Build the authentication boundary for `/v1`.
 *
 * The verifier is constructed here and nowhere else, and it holds only public keys: Magento
 * is the sole issuer, so there is nothing in this process that could mint a token for a
 * customer (docs/proposals/0001-assistant-session-token.md, decision 4).
 *
 * When authentication is off, a synthetic **guest** session is supplied rather than no
 * session at all. That keeps `req.session` non-optional, which means no handler grows a
 * fallback - and a fallback in an authorisation path is how a gate stops gating.
 *
 * @param {Readonly<import('@shopsage/platform').AppConfig>} config
 * @param {import('@shopsage/platform').Logger} logger
 * @returns {{ middleware: import('express').RequestHandler, health?: () => Promise<void> }}
 */
function buildAuthentication(config, logger) {
  if (!resolveAuthEnabled(config.env)) {
    return {
      middleware: createUnauthenticatedMiddleware({
        siteId: config.siteProfile.identity.siteId,
        logger,
        scopes: config.env.DEV_SESSION_SCOPES,
      }),
    };
  }

  const options = toAuthOptions(config);
  const keys = createKeyStore({
    url: options.jwksUrl,
    cacheTtlMs: options.jwksCacheTtlMs,
    logger: logger.child({ component: 'session-token' }),
  });

  logger.info('authentication configured', {
    issuer: options.issuer,
    audience: options.audience,
    algorithm: options.algorithm,
    // Host only, for the same reason every other boot record logs a host rather than a URL.
    jwksHost: new URL(options.jwksUrl).host,
    clockSkewSeconds: options.clockSkewSeconds,
  });

  return {
    middleware: createAuthenticationMiddleware({
      verify: (token) => verifyToken(token, { ...options, resolveKey: keys.resolveKey }),
    }),
    health: keys.health,
  };
}

/**
 * Choose an implementation of the `ConversationStore` port.
 *
 * The one place that knows there is a choice. Everything downstream - the conversation
 * manager, the routes, the domain - sees one port and cannot tell which side of this
 * branch it came from, which is what makes swapping backends a deployment decision rather
 * than a code change.
 *
 * @param {Readonly<import('@shopsage/platform').AppConfig>} config
 * @param {import('@shopsage/platform').Logger} logger
 * @returns {{
 *   store: import('@shopsage/assistant-core').ConversationStore,
 *   health?: () => Promise<void>,
 *   onShutdown: (() => Promise<void>)[],
 *   connection?: ReturnType<typeof createConnection>,
 * }}
 */
function buildConversationStore(config, logger) {
  const kind = resolveConversationStore(config.env);

  if (kind === 'memory') {
    return {
      store: createMemoryConversationStore({
        logger,
        isProduction: config.env.NODE_ENV === 'production',
        // The same profile value the Redis store turns into a TTL, so a conversation
        // expires after the same idle period whichever store is running.
        idleTimeoutMs: config.siteProfile.conversation.sessionIdleTimeoutMinutes * 60_000,
      }),
      onShutdown: [],
    };
  }

  const options = toRedisStoreOptions(config);
  // Created here rather than inside the store, so the proposal store can share it. Its **absence** on
  // the memory branch is also the signal `buildProposalStore` reads - one source of truth for "is this
  // deployment shared?", so the two stores cannot disagree about the answer.
  const connection = createConnection({
    url: options.url,
    logger: logger.child({ component: 'conversation-store' }),
  });
  const store = createRedisConversationStore({
    ...options,
    connection,
    logger: logger.child({ component: 'conversation-store' }),
  });

  logger.info('conversation store configured', {
    store: kind,
    // Host only, for the same reason the gateway record logs a host: a URL can carry a
    // credential.
    host: new URL(options.url).host,
    ttlSeconds: options.ttlSeconds,
    maxStoredMessages: options.maxStoredMessages,
  });

  return { store, health: store.health, onShutdown: [store.close], connection };
}

/**
 * @param {Readonly<import('@shopsage/platform').AppConfig>} config
 * @returns {import('@shopsage/platform').Logger}
 */
function createRootLogger(config) {
  return createLogger({
    level: config.env.LOG_LEVEL,
    format: config.env.LOG_FORMAT,
    name: config.env.SERVICE_NAME,
    bindings: {
      env: config.env.NODE_ENV,
      siteId: config.siteProfile.identity.siteId,
      version: packageJson.version,
    },
  });
}

/**
 * Record which gateway and model this instance will use.
 *
 * Host and model only. The full endpoint may carry a query string, and a
 * credential in a URL - some gateways do that - would be written straight to log
 * storage. One line at boot answers "which model is this store actually running?"
 * without anyone having to read the deployment's environment.
 *
 * @param {Readonly<import('@shopsage/platform').AppConfig>} config
 * @param {import('@shopsage/platform').Logger} logger
 */
function logGatewayConfiguration(config, logger) {
  logger.info('retrieval dependencies configured', {
    embeddingProvider: config.env.EMBEDDING_PROVIDER,
    embeddingModel: config.env.EMBEDDING_MODEL,
    embeddingDimensions: config.env.EMBEDDING_DIMENSIONS,
    // Host only: a base URL can carry a credential in its query string.
    embeddingHost: new URL(/** @type {string} */ (config.env.EMBEDDING_BASE_URL)).host,
    collection: config.env.QDRANT_COLLECTION,
  });

  logger.info('llm gateway configured', {
    model: config.env.LLM_MODEL,
    gatewayHost: new URL(/** @type {string} */ (config.env.LLM_BASE_URL)).host,
    timeoutMs: config.env.LLM_TIMEOUT_MS,
    maxAttempts: config.env.LLM_MAX_ATTEMPTS,
  });
}

/**
 * @param {Readonly<import('@shopsage/platform').AppConfig>} config
 * @param {import('@shopsage/platform').Logger} logger
 */
function warnOnPermissiveCors(config, logger) {
  const isProduction = config.env.NODE_ENV === 'production';
  const allowsAnyOrigin = config.env.CORS_ALLOWED_ORIGINS.includes('*');

  if (isProduction && allowsAnyOrigin) {
    logger.warn('CORS is open to every origin in production', {
      remediation: 'set CORS_ALLOWED_ORIGINS to the storefront origins',
    });
  }
}
