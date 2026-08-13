/**
 * An in-memory stand-in for the parts of the Redis client this adapter uses.
 *
 * Deliberately implements the semantics for real — `rPush` appends, `lTrim` keeps a
 * window, `lRange` handles negative indices, `getDel` actually deletes — rather than recording calls
 * and asserting on them. A test that only checks "lTrim was called with -12 and -1" passes just as
 * happily when the arguments are the wrong way round, and one that checks "getDel was called" passes
 * against a `get` followed by a `del`, which is the race the whole design avoids.
 *
 * @param {{ failWith?: Error, failOn?: 'connect' | 'command' }} [options]
 */
export function createFakeRedis(options = {}) {
  /** @type {Map<string, string[]>} */
  const lists = new Map();
  /** @type {Map<string, number>} */
  const ttls = new Map();
  /** @type {Map<string, string>} */
  const values = new Map();
  /** @type {string[]} */
  const calls = [];

  const fail = (/** @type {'connect' | 'command'} */ stage) => {
    if (options.failWith !== undefined && (options.failOn ?? 'command') === stage) {
      throw options.failWith;
    }
  };

  /** @param {string} key */
  const listFor = (key) => lists.get(key) ?? [];

  const api = {
    lists,
    ttls,
    values,
    calls,
    isOpen: false,
    /** @type {((error: Error) => void)[]} */
    errorHandlers: [],

    /**
     * @param {string} event
     * @param {(error: Error) => void} handler
     */
    on(event, handler) {
      if (event === 'error') api.errorHandlers.push(handler);
      return api;
    },

    connect() {
      calls.push('connect');
      fail('connect');
      api.isOpen = true;

      return Promise.resolve(api);
    },

    close() {
      calls.push('close');
      api.isOpen = false;

      return Promise.resolve();
    },

    ping() {
      calls.push('ping');
      fail('command');

      return Promise.resolve('PONG');
    },

    /**
     * @param {string} key
     * @param {string} value
     * @param {{ expiration?: { type: string, value: number } }} [options]
     */
    set(key, value, options = {}) {
      calls.push('set');
      fail('command');

      values.set(key, value);
      if (options.expiration !== undefined) ttls.set(key, options.expiration.value);

      return Promise.resolve('OK');
    },

    /**
     * Read and delete, atomically. Implemented for real rather than recorded, because the whole point
     * of the adapter using `GETDEL` is that the second call gets nothing - and a test that asserted
     * "getDel was called" would pass just as happily against a `get` followed by a `del`.
     *
     * @param {string} key
     */
    getDel(key) {
      calls.push('getDel');
      fail('command');

      const held = values.get(key);

      values.delete(key);

      return Promise.resolve(held ?? null);
    },

    /**
     * @param {string} key
     * @param {number} start
     * @param {number} stop
     */
    lRange(key, start, stop) {
      calls.push(`lRange ${key} ${start} ${stop}`);
      fail('command');

      const list = listFor(key);
      const from = start < 0 ? Math.max(list.length + start, 0) : start;
      const to = stop < 0 ? list.length + stop : stop;

      return Promise.resolve(list.slice(from, to + 1));
    },

    multi() {
      /** @type {(() => void)[]} */
      const queued = [];

      const chain = {
        /**
         * @param {string} key
         * @param {string[]} values
         */
        rPush(key, values) {
          queued.push(() => lists.set(key, [...listFor(key), ...values]));
          return chain;
        },

        /**
         * @param {string} key
         * @param {number} start
         * @param {number} stop
         */
        lTrim(key, start, stop) {
          queued.push(() => {
            const list = listFor(key);
            const from = start < 0 ? Math.max(list.length + start, 0) : start;
            const to = stop < 0 ? list.length + stop : stop;

            lists.set(key, list.slice(from, to + 1));
          });
          return chain;
        },

        /**
         * @param {string} key
         * @param {number} seconds
         */
        expire(key, seconds) {
          queued.push(() => ttls.set(key, seconds));
          return chain;
        },

        exec() {
          calls.push('exec');
          fail('command');

          for (const step of queued) step();

          return Promise.resolve([]);
        },
      };

      return chain;
    },
  };

  return api;
}
