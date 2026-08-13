import { UpstreamError } from '@shopsage/platform';
import { createConnection } from './connection.js';
import { decodeTurn, encodeTurn } from './turn-codec.js';
import { withDeadline } from './with-deadline.js';

const DEFAULT_KEY_PREFIX = 'shopsage:conv';
const DEFAULT_TIMEOUT_MS = 5_000;

/**
 * @typedef {object} RedisConversationStoreOptions
 * @property {string} url
 * @property {number} ttlSeconds How long an idle conversation survives.
 * @property {number} maxStoredMessages Hard cap on messages kept per conversation.
 * @property {string} [keyPrefix] Default `shopsage:conv`.
 * @property {number} [timeoutMs] Per-operation budget. Default 5000.
 * @property {import('@shopsage/platform').Logger} [logger]
 * @property {ReturnType<typeof createConnection>} [connection] Share one with the proposal store.
 * @property {() => import('./connection.js').RedisClient} [clientFactory] Injection seam for tests.
 */

/**
 * Conversation history in Redis.
 *
 * Satisfies the domain's `ConversationStore` port and adds two operational methods the
 * port does not carry - `health` and `close`. The port stays minimal because it describes
 * what the *domain* needs; readiness and shutdown are the composition root's business, and
 * it knows the concrete type.
 *
 * **Why Redis and not the database.** Conversation history is bounded-lifetime, write-
 * heavy, read-by-key state with no relational queries over it, and it should disappear on
 * its own. That is a TTL-shaped problem, and a store with native expiry does it without a
 * sweeper job that someone has to remember to run. See docs/adr/0024.
 *
 * **The data model.** One Redis list per conversation, JSON-encoded turns, keyed
 * `{prefix}:{siteId}:{conversationId}`. `siteId` sits in the key rather than inside the
 * value, which makes cross-tenant reads structurally impossible rather than a filter
 * somebody has to remember - the same reasoning as the vector store's tenancy
 * (docs/adr/0006), reached independently.
 *
 * @param {RedisConversationStoreOptions} options
 * @returns {import('@shopsage/assistant-core').ConversationStore & {
 *   health: () => Promise<void>,
 *   close: () => Promise<void>,
 * }}
 */
export function createRedisConversationStore(options) {
  const { ttlSeconds, maxStoredMessages, logger } = options;
  const prefix = options.keyPrefix ?? DEFAULT_KEY_PREFIX;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const connection = options.connection ?? createConnection(options);

  /**
   * @param {string} siteId
   * @param {string} conversationId
   */
  const keyFor = (siteId, conversationId) => `${prefix}:${siteId}:${conversationId}`;

  /**
   * Every path out of this package goes through here, so no operation can be added later
   * without a deadline and a taxonomy error.
   *
   * @template T
   * @param {string} label
   * @param {(client: import('./connection.js').RedisClient) => Promise<T>} operation
   * @returns {Promise<T>}
   */
  const run = (label, operation) =>
    withUpstreamErrors(withDeadline(connection.connected().then(operation), { timeoutMs, label }));

  return {
    async history({ siteId, conversationId, limit }) {
      const key = keyFor(siteId, conversationId);

      // Negative indices count from the end, so this is "the last `limit` messages"
      // without needing to know the length first.
      const raw = await run('history', (client) => client.lRange(key, -limit, -1));

      return decodeAll(raw, { key, logger });
    },

    async append({ siteId, conversationId, turns }) {
      if (turns.length === 0) return;

      const key = keyFor(siteId, conversationId);

      // One round trip, and atomic. Two tabs on one conversation would otherwise
      // interleave a read-modify-write and lose a turn - which is the reason the port
      // says `append` rather than `set`.
      await run('append', (client) =>
        client
          .multi()
          .rPush(key, turns.map(encodeTurn))
          // Bounds a conversation's stored size regardless of how long it runs.
          .lTrim(key, -maxStoredMessages, -1)
          // Sliding: refreshed on every write, so the TTL means "idle for this long",
          // not "created this long ago".
          .expire(key, ttlSeconds)
          .exec(),
      );
    },

    async health() {
      await run('health', (client) => client.ping());
    },

    close: () => connection.close(),
  };
}

/**
 * @param {string[]} raw
 * @param {{ key: string, logger?: import('@shopsage/platform').Logger }} context
 * @returns {import('@shopsage/assistant-core').ConversationTurn[]}
 */
function decodeAll(raw, context) {
  const turns = raw.map(decodeTurn).filter((turn) => turn !== undefined);

  if (turns.length !== raw.length) {
    context.logger?.warn('conversation store skipped unreadable entries', {
      key: context.key,
      skipped: raw.length - turns.length,
      remediation: 'usually a stored format from an older release; the conversation still works',
    });
  }

  return turns;
}

/**
 * Present a client failure as the platform's taxonomy rather than a vendor error.
 *
 * Nothing above this package should have to recognise a `SocketClosedUnexpectedlyError` to
 * know that a dependency is unavailable. An `UpstreamError` raised by the deadline is
 * already in the taxonomy and already says something more specific, so it passes through
 * rather than being wrapped into something vaguer.
 *
 * @template T
 * @param {Promise<T>} operation
 * @returns {Promise<T>}
 */
async function withUpstreamErrors(operation) {
  try {
    return await operation;
  } catch (error) {
    if (error instanceof UpstreamError) throw error;

    throw new UpstreamError('Conversation store is unavailable', {
      cause: error instanceof Error ? error : new Error(String(error)),
    });
  }
}
