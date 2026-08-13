import { createMemoryProposalStore } from '@shopsage/assistant-core';
import { createRedisProposalStore } from '@shopsage/conversation-store';
import { createMagentoCart } from '@shopsage/magento-client';
import { ConfigurationError } from '@shopsage/platform';
import { cartFeaturesEnabled, toCommerceClientOptions } from './commerce-options.js';

/**
 * @typedef {{
 *   store: import('@shopsage/assistant-core').ConversationStore,
 *   health?: () => Promise<void>,
 *   onShutdown: (() => Promise<void>)[],
 *   connection?: ReturnType<typeof import('@shopsage/conversation-store').createConnection>,
 * }} ConversationStoreBundle
 */

/**
 * Build the cart side: a proposal store and the write client, or neither.
 *
 * Both or neither, deliberately. A proposal store with no write client would accept confirmations it
 * cannot execute; a write client with no store would have nothing to execute. Returning them together
 * is what lets the routes be mounted only when the whole path exists.
 *
 * @param {{
 *   config: Readonly<import('@shopsage/platform').AppConfig>,
 *   logger: import('@shopsage/platform').Logger,
 *   conversations: ConversationStoreBundle,
 * }} input
 * @returns {{
 *   proposals: import('@shopsage/assistant-core').CartProposalStore,
 *   cart: import('@shopsage/assistant-core').CommerceCart,
 *   health?: () => Promise<void>,
 *   onShutdown: (() => Promise<void>)[],
 * } | undefined}
 */
export function buildCart(input) {
  const { config, logger } = input;
  const features = cartFeaturesEnabled(config.siteProfile);

  if (features.length === 0) return undefined;

  // Already validated: a cart feature is in COMMERCE_FEATURES, so boot has failed by now if there is no
  // connector. Asserted rather than assumed, because a silent `undefined` here would mount a
  // confirmation route with nothing behind it.
  const options = toCommerceClientOptions(config);

  if (options === undefined) {
    throw new ConfigurationError('a cart feature is enabled without a commerce connector', {
      details: { features, variable: 'MAGENTO_API_URL' },
    });
  }

  const proposals = buildProposalStore(input);

  logger.info('cart confirmation configured', {
    features,
    proposalStore: input.conversations.connection === undefined ? 'memory' : 'redis',
  });

  return {
    proposals: proposals.store,
    cart: createMagentoCart({ ...options, logger: logger.child({ component: 'magento-cart' }) }),
    ...(proposals.health === undefined ? {} : { health: proposals.health }),
    onShutdown: proposals.onShutdown,
  };
}

/**
 * Choose an implementation of the `CartProposalStore` port.
 *
 * **Follows the conversation store's choice** rather than adding a variable of its own. An operator who
 * has said "this deployment has more than one replica" has already answered this question, and a
 * deployment where conversations are shared but proposals are not would produce a confirmation button
 * that works four times in five - the worst possible way to discover the mistake.
 *
 * The Redis implementation shares the conversation store's connection. Two clients to the same server
 * from one process is two reconnect loops and two error streams for two key prefixes that could not
 * care less about each other.
 *
 * @param {{
 *   config: Readonly<import('@shopsage/platform').AppConfig>,
 *   logger: import('@shopsage/platform').Logger,
 *   conversations: ConversationStoreBundle,
 * }} input
 * @returns {{
 *   store: import('@shopsage/assistant-core').CartProposalStore,
 *   health?: () => Promise<void>,
 *   onShutdown: (() => Promise<void>)[],
 * }}
 */
function buildProposalStore(input) {
  const { config, logger } = input;

  if (input.conversations.connection === undefined) {
    return {
      store: createMemoryProposalStore({
        logger,
        isProduction: config.env.NODE_ENV === 'production',
      }),
      onShutdown: [],
    };
  }

  const store = createRedisProposalStore({
    url: /** @type {string} */ (config.env.REDIS_URL),
    keyPrefix: `${config.env.REDIS_KEY_PREFIX}:proposal`,
    timeoutMs: config.env.REDIS_TIMEOUT_MS,
    connection: input.conversations.connection,
    logger: logger.child({ component: 'cart-proposals' }),
  });

  // No `close` here. The connection belongs to the conversation store, which closes it; closing a
  // shared connection twice is a wasted call at best and a shutdown error at worst.
  return { store, health: store.health, onShutdown: [] };
}
