import { RateLimitError, ServiceUnavailableError } from '@shopsage/platform';

/**
 * A count of in-flight work, per client and in total.
 *
 * Rate limiting alone does not bound a streamed request. A stream is one request that
 * holds a connection, a socket and an LLM generation open for the length of an answer, so
 * a client well inside its *rate* can still hold twenty of them at once — and the cost is
 * paid for the whole time, not at the moment of the request.
 *
 * Two ceilings, because they answer different questions:
 *
 * - **Per client** is a fairness question, and exceeding it is the client's fault: `429`.
 * - **Global** is a capacity question, and exceeding it is not any one client's fault:
 *   `503` with a `Retry-After`. Telling a well-behaved customer they are being throttled
 *   when the service is simply full would be a lie, and the two need to stay
 *   distinguishable in a dashboard.
 *
 * Counting per process is not an approximation here, unlike the rate limiter's: a
 * connection is held by one process, so a per-process ceiling is exactly the thing that
 * bounds that process's sockets and memory.
 *
 * @param {{ maxPerClient: number, maxTotal: number }} options
 */
export function createConcurrencyGuard(options) {
  const { maxPerClient, maxTotal } = options;

  /** @type {Map<string, number>} */
  const perClient = new Map();
  let total = 0;

  return {
    /**
     * Reserve a slot, returning the function that releases it.
     *
     * A caller that forgets to release leaks a slot permanently, so the release is handed
     * back rather than left to a matching `release(key)` call somebody has to remember.
     *
     * @param {string} key
     * @returns {() => void}
     * @throws {RateLimitError | ServiceUnavailableError}
     */
    acquire(key) {
      const held = perClient.get(key) ?? 0;

      if (held >= maxPerClient) {
        throw new RateLimitError('Too many concurrent requests', {
          details: { limit: maxPerClient, scope: 'client' },
          retryAfterSeconds: 5,
        });
      }

      if (total >= maxTotal) {
        throw new ServiceUnavailableError('The assistant is at capacity', {
          details: { limit: maxTotal, scope: 'service' },
          retryAfterSeconds: 5,
        });
      }

      perClient.set(key, held + 1);
      total += 1;

      let released = false;

      return () => {
        // Idempotent: a release can plausibly be reached twice on an aborted stream, and
        // double-counting down would let the ceiling drift upward over time.
        if (released) return;
        released = true;

        total -= 1;
        const remaining = (perClient.get(key) ?? 1) - 1;

        // Delete rather than store a zero, or this becomes an unbounded map keyed by
        // client address - the hole the rate limiter's eviction exists to close.
        if (remaining <= 0) perClient.delete(key);
        else perClient.set(key, remaining);
      };
    },

    /** Visible for tests and for the operational record. */
    inFlight: () => total,
  };
}
