import { ConfigurationError } from '@shopsage/platform';

/**
 * Decide which conversation store this instance runs, and refuse to guess in production.
 *
 * The choice cannot be defaulted safely. `memory` is correct for development and for a
 * single replica; behind two it breaks in the confusing way, where some requests remember
 * a conversation and some do not — which a customer experiences as an assistant that
 * forgets at random, and which no log line points at. Only the operator knows the replica
 * count.
 *
 * So: outside production the backend picks `memory` for itself, because a developer should
 * not need Redis to ask a question. Inside production an unset `CONVERSATION_STORE` is a
 * boot failure naming both options. That is the same rule as `LLM_*`
 * ([ADR 0013](../../../../docs/adr/0013-required-config-per-entry-point.md)): configuration with
 * no defensible default is required rather than assumed, and an instance that looks healthy
 * while behaving wrongly is worse than one that visibly failed to start.
 *
 * Choosing `memory` in production is still allowed. It is correct at one replica, and
 * banning it would block a legitimate deployment to protect against a different one.
 *
 * @param {import('@shopsage/platform').EnvConfig} env
 * @returns {'memory' | 'redis'}
 */
export function resolveConversationStore(env) {
  if (env.CONVERSATION_STORE !== undefined) return env.CONVERSATION_STORE;
  if (env.NODE_ENV !== 'production') return 'memory';

  throw new ConfigurationError('Conversation store is not configured', {
    details: {
      missing: ['CONVERSATION_STORE'],
      remediation:
        'set CONVERSATION_STORE=redis (with REDIS_URL) for more than one replica, or CONVERSATION_STORE=memory to accept per-process history',
    },
  });
}

/**
 * Map the environment and site profile onto the Redis store's options.
 *
 * The same seam as `llm-options.js` and `retrieval-options.js`: the adapter takes plain
 * options and knows nothing about ShopSage's configuration schema.
 *
 * Note which side each value comes from. The address is infrastructure, so it is
 * environment. The **lifetime** of a conversation is a product decision that differs
 * between stores, so it comes from the site profile — and it is
 * `conversation.sessionIdleTimeoutMinutes`, a key that has existed since Stage 1 and until
 * now did nothing. A sliding TTL is exactly what an idle timeout means.
 *
 * Storage is `conversation.maxStoredMessages`, which is deliberately **not** the prompt limit.
 * This comment previously argued that keeping more than is replayed would be "paying to store text
 * nothing reads" - true on cost, wrong on optionality. The trim is permanent, storage measures at
 * ~310 bytes per message, and a conversation Redis has already discarded cannot be summarised,
 * reviewed, or turned into an eval case later. Retention is the cheap side of this trade.
 *
 * @param {{
 *   env: import('@shopsage/platform').EnvConfig,
 *   siteProfile: import('@shopsage/platform').SiteProfile,
 * }} config
 * @returns {import('@shopsage/conversation-store').RedisConversationStoreOptions}
 */
export function toRedisStoreOptions(config) {
  const { env, siteProfile } = config;

  if (env.REDIS_URL === undefined) {
    throw new ConfigurationError('Conversation store configuration is incomplete', {
      details: {
        missing: ['REDIS_URL'],
        remediation:
          'CONVERSATION_STORE=redis requires REDIS_URL, for example redis://shopsage-redis:6379',
      },
    });
  }

  return {
    url: env.REDIS_URL,
    keyPrefix: env.REDIS_KEY_PREFIX,
    timeoutMs: env.REDIS_TIMEOUT_MS,
    ttlSeconds: siteProfile.conversation.sessionIdleTimeoutMinutes * 60,
    maxStoredMessages: siteProfile.conversation.maxStoredMessages,
  };
}
