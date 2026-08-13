import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { describe, it } from 'node:test';
import { registerGracefulShutdown } from '../src/lifecycle/graceful-shutdown.js';
import { createSilentLogger } from './helpers/test-doubles.js';

/**
 * The teardown hooks existed from Stage 1 and were unused until the conversation store
 * needed a connection closed. Untested wiring that suddenly becomes load-bearing is
 * exactly the kind of thing that turns out never to have worked.
 *
 * `processRef` and the server are injected, so nothing here signals or exits for real.
 *
 * @param {{ onShutdown?: (() => Promise<void> | void)[], serverError?: Error }} [options]
 */
function buildShutdown(options = {}) {
  /** @type {string[]} */
  const order = [];
  /** @type {number[]} */
  const exits = [];

  const server = {
    close: (/** @type {(error?: Error) => void} */ done) => {
      order.push('server closed');
      done(options.serverError);
    },
  };

  const processRef = Object.assign(new EventEmitter(), {
    exit: (/** @type {number} */ code) => {
      exits.push(code);
    },
  });

  const shutdown = registerGracefulShutdown({
    server: /** @type {any} */ (server),
    logger: createSilentLogger(),
    processRef: /** @type {any} */ (processRef),
    onShutdown: options.onShutdown ?? [],
  });

  return { shutdown, order, exits, processRef };
}

describe('registerGracefulShutdown', () => {
  it('runs teardown hooks', async () => {
    /** @type {string[]} */
    const ran = [];
    const { shutdown } = buildShutdown({
      onShutdown: [
        () => {
          ran.push('store closed');
        },
      ],
    });

    await shutdown('test');

    assert.deepEqual(ran, ['store closed']);
  });

  it('closes the server before the hooks, so nothing is torn down under a live request', async () => {
    // A Redis connection closed while a request is still answering turns a clean deploy
    // into a handful of 502s.
    /** @type {string[]} */
    const order = [];
    const built = buildShutdown({
      onShutdown: [
        () => {
          order.push('hook');
        },
      ],
    });

    await built.shutdown('test');

    assert.deepEqual([...built.order, ...order], ['server closed', 'hook']);
  });

  it('runs every hook even when one fails', async () => {
    /** @type {string[]} */
    const ran = [];
    const { shutdown, exits } = buildShutdown({
      onShutdown: [
        () => Promise.reject(new Error('store refused to close')),
        () => {
          ran.push('second');
        },
      ],
    });

    await shutdown('test');

    assert.deepEqual(ran, ['second']);
    // A teardown that failed is not a reason to exit non-zero: the process is going away
    // regardless, and a false failure signal makes every deploy look broken.
    assert.deepEqual(exits, [0]);
  });

  it('exits non-zero when the server itself fails to close', async () => {
    const { shutdown, exits } = buildShutdown({ serverError: new Error('still listening') });

    await shutdown('test');

    assert.deepEqual(exits, [1]);
  });

  it('shuts down once, however many signals arrive', async () => {
    let closes = 0;
    const { shutdown } = buildShutdown({
      onShutdown: [
        () => {
          closes += 1;
        },
      ],
    });

    await Promise.all([shutdown('SIGTERM'), shutdown('SIGINT')]);

    assert.equal(closes, 1);
  });

  it('treats SIGTERM as a clean shutdown', async () => {
    const { processRef, exits } = buildShutdown();

    processRef.emit('SIGTERM');
    await new Promise((resolve) => setImmediate(resolve));

    assert.deepEqual(exits, [0]);
  });

  it('treats an uncaught exception as fatal', async () => {
    // After one the process is in unknown state, and serving customers from unknown state
    // is worse than restarting.
    const { processRef, exits } = buildShutdown();

    processRef.emit('uncaughtException', new Error('boom'));
    await new Promise((resolve) => setImmediate(resolve));

    assert.deepEqual(exits, [1]);
  });
});
