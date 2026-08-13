import { UpstreamError } from '@shopsage/platform';
import { createConnection } from './connection.js';
import { withDeadline } from './with-deadline.js';

const DEFAULT_KEY_PREFIX = 'shopsage:proposal';
const DEFAULT_TIMEOUT_MS = 5_000;

/**
 * @typedef {object} RedisProposalStoreOptions
 * @property {string} url
 * @property {string} [keyPrefix] Default `shopsage:proposal`.
 * @property {number} [timeoutMs] Per-operation budget. Default 5000.
 * @property {import('@shopsage/platform').Logger} [logger]
 * @property {ReturnType<typeof createConnection>} [connection] Share the conversation store's.
 * @property {() => import('./connection.js').RedisClient} [clientFactory] Injection seam for tests.
 */

/**
 * Cart proposals in Redis.
 *
 * Satisfies the domain's `CartProposalStore` port. Separate from the conversation store because the two
 * hold genuinely different things — a conversation is an append-only list with a sliding idle TTL, a
 * proposal is a single value that is read exactly once — but they **share one connection**, because two
 * clients to the same Redis from one process is two reconnect loops and two sets of error logs for no
 * benefit.
 *
 * **`GETDEL` is the whole design.** The port promises `consume` is take-once, and this is the one
 * command that delivers it: read and delete in a single atomic operation, so a double-tapped
 * confirmation has exactly one winner and the loser sees nothing. A `GET` followed by a `DEL` would be
 * a race with a basket on the other end of it, and the window is precisely as wide as a customer
 * clicking twice — which is to say, wide.
 *
 * The TTL is derived from the proposal's own `expiresAt` rather than configured. A proposal that
 * expires at a stated time and lingers in storage past it is a contradiction the code should not be
 * able to express.
 *
 * @param {RedisProposalStoreOptions} options
 * @returns {import('@shopsage/assistant-core').CartProposalStore & {
 *   health: () => Promise<void>,
 *   close: () => Promise<void>,
 * }}
 */
export function createRedisProposalStore(options) {
  const prefix = options.keyPrefix ?? DEFAULT_KEY_PREFIX;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const connection = options.connection ?? createConnection(options);

  /**
   * `siteId` in the key, not in a filter. Cross-tenant reads become structurally impossible rather
   * than something a caller must remember — the same reasoning as the conversation store and the
   * vector store, reached the same way each time.
   *
   * @param {string} siteId
   * @param {string} id
   */
  const keyFor = (siteId, id) => `${prefix}:${siteId}:${id}`;

  /**
   * @template T
   * @param {string} label
   * @param {(client: import('./connection.js').RedisClient) => Promise<T>} operation
   * @returns {Promise<T>}
   */
  const run = (label, operation) =>
    withUpstreamErrors(withDeadline(connection.connected().then(operation), { timeoutMs, label }));

  return {
    async save(proposal) {
      const ttlSeconds = ttlFor(proposal);

      // Already expired, so there is nothing worth storing. Redis rejects a non-positive `EX`, and
      // writing it with a floor of one second would create a proposal that is expired the moment it
      // exists — a confirmation button that cannot work. The domain checks the expiry again on
      // confirmation, so silence here is safe.
      if (ttlSeconds <= 0) return;

      await run('save proposal', (client) =>
        client.set(keyFor(proposal.siteId, proposal.id), JSON.stringify(proposal), {
          expiration: { type: 'EX', value: ttlSeconds },
        }),
      );
    },

    async consume(query) {
      const raw = await run('consume proposal', (client) =>
        client.getDel(keyFor(query.siteId, query.id)),
      );

      if (typeof raw !== 'string') return undefined;

      return decode(raw, { logger: options.logger });
    },

    async health() {
      await run('proposal health', (client) => client.ping());
    },

    close: () => connection.close(),
  };
}

/**
 * @param {import('@shopsage/assistant-core').CartProposal} proposal
 * @returns {number}
 */
function ttlFor(proposal) {
  return Math.ceil((Date.parse(proposal.expiresAt) - Date.now()) / 1000);
}

/**
 * @param {string} raw
 * @param {{ logger?: import('@shopsage/platform').Logger }} context
 * @returns {import('@shopsage/assistant-core').CartProposal | undefined}
 */
function decode(raw, context) {
  try {
    const parsed = JSON.parse(raw);

    // Checked rather than trusted. The value has already been deleted by `GETDEL`, so a malformed
    // entry cannot be retried — reporting it as absent is the only honest outcome, and it is one the
    // confirmation endpoint already handles.
    if (typeof parsed?.id === 'string' && typeof parsed.subject === 'string') return parsed;
  } catch {
    // Falls through.
  }

  context.logger?.warn('proposal store skipped an unreadable entry', {
    remediation: 'usually a stored format from an older release; the customer can ask again',
  });

  return undefined;
}

/**
 * @template T
 * @param {Promise<T>} operation
 * @returns {Promise<T>}
 */
async function withUpstreamErrors(operation) {
  try {
    return await operation;
  } catch (error) {
    if (error instanceof UpstreamError) throw error;

    throw new UpstreamError('The proposal store is unavailable', {
      cause: error,
      retryable: true,
    });
  }
}
