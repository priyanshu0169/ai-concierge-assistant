import { TimeoutError } from '../errors/errors.js';

/**
 * Run an operation under a hard time budget.
 *
 * The operation receives an `AbortSignal` and is expected to honour it - this
 * is a cancellation primitive, not just a race. `fetch` honours it natively,
 * which is why every outbound HTTP call in ShopSage goes through here.
 *
 * @template T
 * @param {(signal: AbortSignal) => Promise<T>} operation
 * @param {{ timeoutMs: number, signal?: AbortSignal, label?: string }} options
 * @returns {Promise<T>} Resolves with the operation result.
 * @throws {TimeoutError} If the budget elapses first.
 */
export async function withTimeout(operation, options) {
  const { timeoutMs, signal: externalSignal, label = 'operation' } = options;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  timer.unref?.();

  const signal = externalSignal
    ? AbortSignal.any([externalSignal, controller.signal])
    : controller.signal;

  try {
    return await operation(signal);
  } catch (cause) {
    if (controller.signal.aborted) {
      throw new TimeoutError(`${label} timed out after ${timeoutMs}ms`, {
        cause,
        details: { label, timeoutMs },
      });
    }
    throw cause;
  } finally {
    clearTimeout(timer);
  }
}
