/**
 * @typedef {object} RateLimiter
 * @property {() => Promise<void>} acquire Resolves when the next request may go out.
 */

/**
 * Space requests at least a fixed interval apart.
 *
 * Politeness is not optional. A crawler is an unannounced visitor to someone's
 * production website, and an impolite one gets the deployment's IP blocked - which
 * looks, from inside, like the site mysteriously going down.
 *
 * A minimum interval rather than a token bucket, deliberately: a bucket permits a
 * burst, and a burst is exactly what a small store's server cannot absorb. The cost
 * is that a crawl takes as long as it takes, which is the correct trade for content
 * that changes daily at most.
 *
 * @param {{
 *   requestsPerSecond: number,
 *   sleep?: (ms: number) => Promise<void>,
 *   now?: () => number,
 * }} options
 * @returns {RateLimiter}
 */
export function createRateLimiter(options) {
  const { requestsPerSecond, sleep = defaultSleep, now = () => Date.now() } = options;
  const minimumIntervalMs = 1000 / requestsPerSecond;

  let nextAllowedAt = 0;

  return {
    async acquire() {
      const currentTime = now();
      const waitMs = nextAllowedAt - currentTime;

      // Scheduled from the slot, not from completion time, so a slow response does
      // not add its latency to the gap before the next request.
      nextAllowedAt = Math.max(currentTime, nextAllowedAt) + minimumIntervalMs;

      if (waitMs > 0) await sleep(waitMs);
    },
  };
}

/**
 * @param {number} ms
 * @returns {Promise<void>}
 */
function defaultSleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
