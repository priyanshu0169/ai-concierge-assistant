import { UpstreamError } from '@shopsage/platform';

/**
 * Bound an operation that cannot be cancelled.
 *
 * `platform`'s `withTimeout` is deliberately a **cancellation** primitive: it hands the
 * operation an `AbortSignal` and expects it to stop. That is the right shape for `fetch`,
 * which every other outbound call in ShopSage uses, and it is the wrong shape here -
 * a Redis command takes no signal, so `withTimeout` would wait forever for something that
 * is never going to answer.
 *
 * This is the weaker guarantee that fits: the **caller** stops waiting, and the operation
 * is left to finish or fail on its own. That is enough, because the point is to bound a
 * customer's request rather than to reclaim a socket - the client owns the connection and
 * reconnects by itself.
 *
 * Found the hard way. Without it, stopping Redis made `/health/ready` hang indefinitely
 * rather than report `down`, because nothing in the path had a deadline: the client
 * retries connecting forever by design, and every layer above it simply waited.
 *
 * @template T
 * @param {Promise<T>} operation
 * @param {{ timeoutMs: number, label: string }} options
 * @returns {Promise<T>}
 */
export function withDeadline(operation, options) {
  const { timeoutMs, label } = options;

  // The abandoned promise still settles eventually, and an unobserved rejection would
  // take the process down.
  operation.catch(() => {});

  /** @type {NodeJS.Timeout} */
  let timer;

  const deadline = new Promise((_resolve, reject) => {
    timer = setTimeout(
      () =>
        reject(
          new UpstreamError(`Conversation store did not respond within ${timeoutMs}ms`, {
            details: { operation: label, timeoutMs },
          }),
        ),
      timeoutMs,
    );
    timer.unref?.();
  });

  return Promise.race([operation, deadline]).finally(() => clearTimeout(timer));
}
