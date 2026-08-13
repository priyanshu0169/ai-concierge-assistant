import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { withRetry } from '../src/async/with-retry.js';
import { AppError } from '../src/errors/app-error.js';
import {
  RateLimitError,
  TimeoutError,
  UpstreamError,
  ValidationError,
} from '../src/errors/errors.js';

/**
 * A sleep double that records what it was asked to wait for. Every test here
 * runs in real time because nothing actually sleeps.
 *
 * @returns {{ delays: number[], sleep: (ms: number) => Promise<void> }}
 */
function recordingSleep() {
  /** @type {number[]} */
  const delays = [];

  return {
    delays,
    sleep: (ms) => {
      delays.push(ms);
      return Promise.resolve();
    },
  };
}

/**
 * @param {unknown[]} outcomes Resolved values, or errors to throw.
 * @returns {{ calls: number, operation: (attempt: number) => Promise<unknown> }}
 */
function scriptedOperation(outcomes) {
  const state = { calls: 0 };

  return {
    get calls() {
      return state.calls;
    },
    operation: (attempt) => {
      state.calls += 1;
      const outcome = outcomes[attempt - 1];

      return outcome instanceof Error ? Promise.reject(outcome) : Promise.resolve(outcome);
    },
  };
}

describe('withRetry', () => {
  it('returns the first success without sleeping', async () => {
    const { delays, sleep } = recordingSleep();

    const result = await withRetry(() => Promise.resolve('answer'), { sleep });

    assert.equal(result, 'answer');
    assert.deepEqual(delays, []);
  });

  it('retries a retryable failure and returns the eventual success', async () => {
    const { delays, sleep } = recordingSleep();
    const script = scriptedOperation([new UpstreamError('gateway blipped'), 'answer']);

    const result = await withRetry(script.operation, { sleep, random: () => 0.5 });

    assert.equal(result, 'answer');
    assert.equal(script.calls, 2);
    assert.equal(delays.length, 1);
  });

  it('gives up after maxAttempts and throws the last error', async () => {
    const { delays, sleep } = recordingSleep();
    const last = new UpstreamError('still failing');
    const script = scriptedOperation([
      new UpstreamError('first'),
      new UpstreamError('second'),
      last,
    ]);

    await assert.rejects(
      () => withRetry(script.operation, { maxAttempts: 3, sleep, random: () => 0.5 }),
      (error) => {
        assert.equal(error, last);
        return true;
      },
    );

    assert.equal(script.calls, 3);
    // Two waits for three attempts: no one sleeps after the final failure.
    assert.equal(delays.length, 2);
  });

  it('does not retry an error the taxonomy marks as final', async () => {
    const { sleep } = recordingSleep();
    const script = scriptedOperation([new ValidationError('bad input'), 'unreachable']);

    await assert.rejects(() => withRetry(script.operation, { sleep }), ValidationError);

    assert.equal(script.calls, 1);
  });

  it('does not retry a plain Error, because retryability must be declared', async () => {
    const script = scriptedOperation([new Error('who knows'), 'unreachable']);

    await assert.rejects(() => withRetry(script.operation), /who knows/);

    assert.equal(script.calls, 1);
  });

  it('lets the caller override which errors are worth repeating', async () => {
    const { sleep } = recordingSleep();
    // A timeout is retryable by default; an LLM caller excludes it deliberately.
    const script = scriptedOperation([new TimeoutError('slow'), 'unreachable']);

    await assert.rejects(
      () =>
        withRetry(script.operation, {
          sleep,
          isRetryable: (error) => error instanceof UpstreamError,
        }),
      TimeoutError,
    );

    assert.equal(script.calls, 1);
  });

  describe('backoff', () => {
    it('grows exponentially and stays inside the ceiling', async () => {
      const { delays, sleep } = recordingSleep();
      const failures = Array.from({ length: 5 }, () => new UpstreamError('down'));

      await assert.rejects(() =>
        withRetry(scriptedOperation(failures).operation, {
          maxAttempts: 5,
          baseDelayMs: 100,
          maxDelayMs: 350,
          sleep,
          random: () => 1,
        }),
      );

      // Windows 100, 200, 400→350, 800→350; equal jitter at random()=1 spends
      // the whole window.
      assert.deepEqual(delays, [100, 200, 350, 350]);
    });

    it('keeps jitter within half the window, so a retry is never immediate', async () => {
      const { delays, sleep } = recordingSleep();
      const failures = Array.from({ length: 2 }, () => new UpstreamError('down'));

      await assert.rejects(() =>
        withRetry(scriptedOperation(failures).operation, {
          maxAttempts: 2,
          baseDelayMs: 400,
          sleep,
          random: () => 0,
        }),
      );

      assert.deepEqual(delays, [200]);
    });

    it('honours an upstream Retry-After in preference to its own guess', async () => {
      const { delays, sleep } = recordingSleep();
      const throttled = new RateLimitError('slow down', { retryAfterSeconds: 2 });

      await assert.rejects(() =>
        withRetry(scriptedOperation([throttled, throttled]).operation, {
          maxAttempts: 2,
          baseDelayMs: 50,
          sleep,
        }),
      );

      assert.deepEqual(delays, [2000]);
    });

    it('clamps an absurd Retry-After to the ceiling', async () => {
      const { delays, sleep } = recordingSleep();
      const throttled = new RateLimitError('come back tomorrow', { retryAfterSeconds: 86_400 });

      await assert.rejects(() =>
        withRetry(scriptedOperation([throttled, throttled]).operation, {
          maxAttempts: 2,
          maxDelayMs: 5000,
          sleep,
        }),
      );

      assert.deepEqual(delays, [5000]);
    });
  });

  describe('cancellation', () => {
    it('abandons remaining attempts once the signal is aborted', async () => {
      const controller = new AbortController();
      const script = scriptedOperation([new UpstreamError('first'), 'unreachable']);

      controller.abort();

      await assert.rejects(
        () => withRetry(script.operation, { signal: controller.signal }),
        UpstreamError,
      );

      assert.equal(script.calls, 1);
    });

    it('stops if cancellation arrives during the backoff window', async () => {
      const controller = new AbortController();
      const script = scriptedOperation([new UpstreamError('first'), 'unreachable']);

      await assert.rejects(
        () =>
          withRetry(script.operation, {
            signal: controller.signal,
            sleep: () => {
              controller.abort();
              return Promise.resolve();
            },
          }),
        UpstreamError,
      );

      // The wait completed, but the attempt it was waiting for must not run.
      assert.equal(script.calls, 1);
    });
  });

  describe('observability', () => {
    it('reports every retry with the attempt, the delay and the cause', async () => {
      const { sleep } = recordingSleep();
      /** @type {import('../src/async/with-retry.js').RetryNotice[]} */
      const notices = [];
      const failure = new UpstreamError('gateway blipped');

      await withRetry(scriptedOperation([failure, 'answer']).operation, {
        sleep,
        random: () => 0.5,
        onRetry: (notice) => notices.push(notice),
      });

      assert.equal(notices.length, 1);
      assert.equal(notices[0].attempt, 1);
      assert.equal(notices[0].error, failure);
      assert.ok(notices[0].delayMs > 0);
    });

    it('passes the attempt number to the operation', async () => {
      const { sleep } = recordingSleep();
      /** @type {number[]} */
      const seen = [];

      await withRetry(
        (attempt) => {
          seen.push(attempt);
          return attempt < 3 ? Promise.reject(new UpstreamError('down')) : Promise.resolve('ok');
        },
        { maxAttempts: 3, sleep },
      );

      assert.deepEqual(seen, [1, 2, 3]);
    });
  });

  it('carries retryAfterSeconds on any AppError, not only rate limits', () => {
    // The field lives on the base class so an outbound client can attach an
    // upstream Retry-After without having to raise a customer-facing 429.
    const error = new AppError('upstream asked us to wait', { retryAfterSeconds: 3 });

    assert.equal(error.retryAfterSeconds, 3);
    assert.equal(error.toJSON().retryAfterSeconds, 3);
  });
});
