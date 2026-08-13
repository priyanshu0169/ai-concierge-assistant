import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { TimeoutError } from '../src/errors/errors.js';
import { withTimeout } from '../src/async/with-timeout.js';

/**
 * @param {number} ms
 * @param {AbortSignal} [signal]
 * @returns {Promise<string>}
 */
function delay(ms, signal) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => resolve('done'), ms);
    signal?.addEventListener('abort', () => {
      clearTimeout(timer);
      reject(new Error('aborted'));
    });
  });
}

describe('withTimeout', () => {
  it('resolves when the operation finishes inside the budget', async () => {
    const result = await withTimeout(() => Promise.resolve('value'), { timeoutMs: 1000 });

    assert.equal(result, 'value');
  });

  it('throws a TimeoutError once the budget elapses', async () => {
    await assert.rejects(
      () => withTimeout((signal) => delay(500, signal), { timeoutMs: 20, label: 'slow call' }),
      (error) => {
        assert.ok(error instanceof TimeoutError);
        assert.match(error.message, /slow call timed out after 20ms/);
        assert.equal(error.retryable, true);
        return true;
      },
    );
  });

  it('aborts the operation rather than merely losing the race', async () => {
    let aborted = false;

    await assert.rejects(() =>
      withTimeout(
        (signal) => {
          signal.addEventListener('abort', () => {
            aborted = true;
          });
          return delay(500, signal);
        },
        { timeoutMs: 20 },
      ),
    );

    assert.equal(aborted, true);
  });

  it('propagates operation failures unchanged', async () => {
    const failure = new Error('upstream refused');

    await assert.rejects(
      () => withTimeout(() => Promise.reject(failure), { timeoutMs: 1000 }),
      (error) => {
        assert.equal(error, failure);
        return true;
      },
    );
  });

  it('honours an externally supplied signal', async () => {
    const controller = new AbortController();
    const pending = withTimeout((signal) => delay(500, signal), {
      timeoutMs: 5000,
      signal: controller.signal,
    });

    controller.abort();

    await assert.rejects(pending, (error) => {
      // External cancellation is not a timeout, so it must not be reclassified.
      assert.ok(!(error instanceof TimeoutError));
      return true;
    });
  });
});
