import { createClient } from '@redis/client';

/**
 * Ceiling on reconnect backoff.
 *
 * The client retries forever by default, which is right - a store that comes back should
 * be used again without a restart - but the default delay grows without bound, so a long
 * outage leaves an instance waiting minutes after the store has recovered.
 */
const MAX_RECONNECT_DELAY_MS = 3_000;

/**
 * @typedef {import('@redis/client').RedisClientType} RedisClient
 */

/**
 * Build a client and manage the one-time connect.
 *
 * Connecting is **not** done at construction. `docs/adr/0008` and `docs/adr/0014` settled
 * that the application does not wait for its dependencies: it starts, and reports
 * readiness honestly. Blocking the boot on Redis would turn a store outage into a service
 * that cannot start at all, which is strictly worse than one that starts and says so.
 *
 * So the connect is lazy and memoized. A failed attempt clears the memo, because a
 * permanently-rejected promise would make the first failure permanent - the store would
 * never recover without a restart, which is exactly what the reconnect strategy exists to
 * avoid.
 *
 * @param {{
 *   url: string,
 *   logger?: import('@shopsage/platform').Logger,
 *   clientFactory?: () => RedisClient,
 * }} options
 */
export function createConnection(options) {
  const client =
    options.clientFactory === undefined ? defaultClient(options.url) : options.clientFactory();

  // Node throws on an 'error' event with no listener, so an unreachable store would take
  // the process down rather than failing one request. The reconnect strategy handles
  // recovery; this only has to make the failure visible.
  client.on('error', (/** @type {Error} */ error) => {
    options.logger?.warn('conversation store connection error', { err: error });
  });

  /** @type {Promise<unknown> | undefined} */
  let connecting;

  return {
    client,

    async connected() {
      connecting ??= client.connect().catch((error) => {
        connecting = undefined;
        throw error;
      });

      await connecting;

      return client;
    },

    async close() {
      if (!client.isOpen) return;

      // `destroy` rather than `quit`: by the time this runs the process is shutting down,
      // and waiting for in-flight replies risks outliving the shutdown timeout.
      await client.close();
    },
  };
}

/**
 * @param {string} url
 * @returns {RedisClient}
 */
function defaultClient(url) {
  return /** @type {RedisClient} */ (
    createClient({
      url,
      socket: {
        // Bounds one TCP attempt. Without it a host that accepts nothing - a firewall
        // that drops rather than refuses - leaves the attempt open for the OS default,
        // which is measured in minutes.
        connectTimeout: 3_000,
        reconnectStrategy: (retries) => Math.min(2 ** retries * 50, MAX_RECONNECT_DELAY_MS),
      },
    })
  );
}
