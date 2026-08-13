/**
 * @shopsage/conversation-store - durable conversation history.
 *
 * An outbound adapter, the same shape as `vector-repository`: it satisfies a port the
 * domain declared (`ConversationStore`, in `assistant-core/src/types.js`) and keeps its
 * backend invisible above this line. Nothing outside this package mentions Redis, a key
 * format, or a TTL.
 *
 * `assistant-core` ships an in-memory implementation of the same port, which is correct
 * for development and for a single replica and wrong for anything else. This package is
 * what makes a second replica possible. See docs/adr/0024.
 *
 * From Stage 9b it holds two stores, not one: conversation history and **cart proposals**. They share a
 * single connection - two clients to the same Redis from one process is two reconnect loops for no
 * benefit - which is why `createConnection` is exported. Their data models are unrelated: a conversation
 * is an append-only list with a sliding idle TTL, a proposal is a single value read exactly once by
 * `GETDEL`. The second replica argument is sharper for proposals: a confirmation reaching an instance
 * that never saw the proposal is a button that does nothing. See docs/adr/0029.
 */

export { createConnection } from './redis/connection.js';
export { createRedisConversationStore } from './redis/create-redis-conversation-store.js';
export { createRedisProposalStore } from './redis/create-redis-proposal-store.js';

/**
 * @typedef {import('./redis/create-redis-conversation-store.js').RedisConversationStoreOptions} RedisConversationStoreOptions
 * @typedef {import('./redis/create-redis-proposal-store.js').RedisProposalStoreOptions} RedisProposalStoreOptions
 */
