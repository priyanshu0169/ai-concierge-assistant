/**
 * How many distinct clients one process tracks before evicting the oldest.
 *
 * A bound is not optional. The key is derived from a client address, which on a public
 * endpoint is attacker-supplied in effect — an unbounded map keyed by it is a
 * memory-exhaustion hole inside the very middleware meant to prevent one.
 *
 * Eviction favours the attacker slightly: flooding from many addresses can push a
 * legitimate client's bucket out and hand it a fresh allowance. That is the right way
 * round. The alternative — refusing new clients once full — turns a flood into a total
 * outage, which is the outcome rate limiting exists to avoid.
 */
const MAX_TRACKED_CLIENTS = 10_000;

/**
 * @typedef {object} RateLimitDecision
 * @property {boolean} allowed
 * @property {number} limit Requests permitted per window.
 * @property {number} remaining Whole requests still available.
 * @property {number} resetSeconds Until the bucket is full again.
 * @property {number} retryAfterSeconds Until **one** request is available. Only useful when denied.
 */

/**
 * A token bucket per client.
 *
 * Chosen over a fixed window because a fixed window permits a double-rate burst across a
 * boundary — 30 requests at 11:59:59 and 30 more at 12:00:00 is 60 in a second, from a
 * limiter configured for 30 a minute. A bucket refills continuously, so the rate holds
 * everywhere, and it still allows a legitimate burst up to its capacity.
 *
 * Chosen over a sliding-window log because a log costs memory proportional to traffic,
 * which is the wrong shape for something whose job is to survive a flood. This is two
 * numbers per client.
 *
 * **State is per process.** With N replicas the effective allowance is N times the
 * configured one. That is accepted rather than overlooked: it is an imprecision an
 * operator corrects by dividing, not a correctness bug like per-replica conversation
 * history was, and it keeps a Redis round trip — plus a failure mode, plus a fail-open
 * policy — off every request. See docs/adr/0025.
 *
 * @param {{ windowMs: number, maxRequests: number, now?: () => number }} options
 */
export function createTokenBucket(options) {
  const { windowMs, maxRequests, now = Date.now } = options;
  const refillPerMs = maxRequests / windowMs;

  /** @type {Map<string, { tokens: number, at: number }>} */
  const buckets = new Map();

  return {
    /**
     * Spend one token for `key`, and say what happened.
     *
     * @param {string} key
     * @returns {RateLimitDecision}
     */
    take(key) {
      const at = now();
      const existing = buckets.get(key);
      const tokens =
        existing === undefined
          ? maxRequests
          : // Continuous refill: whatever was left, plus what has accrued since, capped.
            Math.min(maxRequests, existing.tokens + Math.max(0, at - existing.at) * refillPerMs);
      const allowed = tokens >= 1;

      // Re-inserting moves the key to the end of the Map's insertion order, which is what
      // makes eviction below drop the least recently *seen* client.
      buckets.delete(key);
      buckets.set(key, { tokens: allowed ? tokens - 1 : tokens, at });

      evictOldest(buckets);

      return {
        allowed,
        limit: maxRequests,
        remaining: Math.max(0, Math.floor(allowed ? tokens - 1 : tokens)),
        resetSeconds: secondsFor(maxRequests - tokens, refillPerMs),
        retryAfterSeconds: Math.max(1, secondsFor(1 - tokens, refillPerMs)),
      };
    },

    /** Visible for tests and for the boot record. */
    size: () => buckets.size,
  };
}

/**
 * @param {number} tokensNeeded
 * @param {number} refillPerMs
 * @returns {number}
 */
function secondsFor(tokensNeeded, refillPerMs) {
  if (tokensNeeded <= 0) return 0;

  return Math.ceil(tokensNeeded / refillPerMs / 1000);
}

/**
 * @param {Map<string, unknown>} buckets
 */
function evictOldest(buckets) {
  while (buckets.size > MAX_TRACKED_CLIENTS) {
    const oldest = buckets.keys().next().value;

    if (oldest === undefined) return;
    buckets.delete(oldest);
  }
}
