import assert from 'node:assert/strict';
import { RateLimitError, ServiceUnavailableError } from '@shopsage/platform';
import { describe, it } from 'node:test';
import { createConcurrencyGuard } from '../src/http/rate-limit/concurrency-guard.js';
import { createTokenBucket } from '../src/http/rate-limit/token-bucket.js';

describe('createTokenBucket', () => {
  /** @param {{ windowMs?: number, maxRequests?: number }} [options] */
  function buildBucket(options = {}) {
    let clock = 1_000_000;

    return {
      advance: (/** @type {number} */ ms) => (clock += ms),
      bucket: createTokenBucket({
        windowMs: options.windowMs ?? 60_000,
        maxRequests: options.maxRequests ?? 3,
        now: () => clock,
      }),
    };
  }

  it('allows a new client up to its limit', () => {
    const { bucket } = buildBucket();

    assert.deepEqual(
      [bucket.take('a'), bucket.take('a'), bucket.take('a')].map((d) => d.allowed),
      [true, true, true],
    );
  });

  it('refuses the request after the limit', () => {
    const { bucket } = buildBucket();

    for (let i = 0; i < 3; i += 1) bucket.take('a');

    assert.equal(bucket.take('a').allowed, false);
  });

  it('counts each client separately', () => {
    const { bucket } = buildBucket();

    for (let i = 0; i < 3; i += 1) bucket.take('a');

    assert.equal(bucket.take('b').allowed, true);
  });

  it('refills continuously rather than resetting on a boundary', () => {
    // The reason for a bucket over a fixed window: a window permits a double-rate burst
    // across its edge — the full allowance at 11:59:59 and the full allowance again at
    // 12:00:00, from a limiter configured for one window's worth per minute.
    const { bucket, advance } = buildBucket({ windowMs: 60_000, maxRequests: 3 });

    for (let i = 0; i < 3; i += 1) bucket.take('a');
    assert.equal(bucket.take('a').allowed, false);

    // A third of a window restores exactly one token, not the whole allowance.
    advance(20_000);
    assert.equal(bucket.take('a').allowed, true);
    assert.equal(bucket.take('a').allowed, false);
  });

  it('never accrues more than one window of allowance while idle', () => {
    const { bucket, advance } = buildBucket({ maxRequests: 3 });

    advance(60_000 * 100);

    assert.deepEqual(
      [1, 2, 3, 4].map(() => bucket.take('a').allowed),
      [true, true, true, false],
    );
  });

  it('reports the remaining budget on every decision', () => {
    // Sent as a header on success too, so a client can slow down before it is refused.
    const { bucket } = buildBucket({ maxRequests: 3 });

    assert.deepEqual(
      [bucket.take('a'), bucket.take('a')].map((d) => d.remaining),
      [2, 1],
    );
  });

  it('tells a refused client how long to wait for one request, not for a full bucket', () => {
    const { bucket } = buildBucket({ windowMs: 60_000, maxRequests: 3 });

    for (let i = 0; i < 3; i += 1) bucket.take('a');
    const denied = bucket.take('a');

    // One token accrues every 20s; a full bucket takes 60s. Advising the longer wait
    // would keep a client idle three times as long as it needs to be.
    assert.equal(denied.retryAfterSeconds, 20);
    assert.equal(denied.resetSeconds, 60);
  });

  it('never advises a wait of zero seconds', () => {
    // `Retry-After: 0` invites an immediate retry, which is refused again.
    const { bucket } = buildBucket({ windowMs: 1_000, maxRequests: 1000 });

    for (let i = 0; i < 1000; i += 1) bucket.take('a');

    assert.ok(bucket.take('a').retryAfterSeconds >= 1);
  });

  it('bounds how many clients it tracks', () => {
    // The key comes from a client address, so an unbounded map is a memory-exhaustion
    // hole inside the middleware meant to prevent one.
    const { bucket } = buildBucket();

    for (let i = 0; i < 10_050; i += 1) bucket.take(`client-${i}`);

    assert.ok(bucket.size() <= 10_000, `tracked ${bucket.size()} clients`);
  });

  it('keeps the most recently seen clients when evicting', () => {
    const { bucket } = buildBucket();

    bucket.take('regular');
    for (let i = 0; i < 10_050; i += 1) {
      bucket.take(`flood-${i}`);
      // Keep the legitimate client active throughout the flood.
      if (i % 100 === 0) bucket.take('regular');
    }

    assert.ok(bucket.size() <= 10_000);
  });
});

describe('createConcurrencyGuard', () => {
  const buildGuard = (/** @type {{ maxPerClient?: number, maxTotal?: number }} */ o = {}) =>
    createConcurrencyGuard({ maxPerClient: o.maxPerClient ?? 2, maxTotal: o.maxTotal ?? 3 });

  it('allows a client up to its own ceiling', () => {
    const guard = buildGuard();

    guard.acquire('a');
    guard.acquire('a');

    assert.equal(guard.inFlight(), 2);
  });

  it('refuses a client past its own ceiling with a 429', () => {
    // The client's fault, so it is told it is being throttled.
    const guard = buildGuard();

    guard.acquire('a');
    guard.acquire('a');

    assert.throws(
      () => guard.acquire('a'),
      (error) => {
        assert.ok(error instanceof RateLimitError);
        assert.equal(error.details?.scope, 'client');
        assert.ok((error.retryAfterSeconds ?? 0) > 0);
        return true;
      },
    );
  });

  it('refuses past the global ceiling with a 503, not a 429', () => {
    // Not any one client's fault. Telling a well-behaved customer they are throttled
    // when the service is simply full would be a lie, and the two must stay
    // distinguishable in a dashboard.
    const guard = buildGuard({ maxPerClient: 5, maxTotal: 2 });

    guard.acquire('a');
    guard.acquire('b');

    assert.throws(
      () => guard.acquire('c'),
      (error) => {
        assert.ok(error instanceof ServiceUnavailableError);
        assert.equal(error.details?.scope, 'service');
        return true;
      },
    );
  });

  it('frees the slot when the release is called', () => {
    const guard = buildGuard();
    const release = guard.acquire('a');

    guard.acquire('a');
    release();

    assert.equal(guard.inFlight(), 1);
    assert.doesNotThrow(() => guard.acquire('a'));
  });

  it('ignores a second release, so a ceiling cannot drift upward', () => {
    // A release is plausibly reached twice on an aborted stream. Counting down twice
    // would let the guard permit more than its configured maximum, permanently.
    const guard = buildGuard();
    const release = guard.acquire('a');

    release();
    release();

    assert.equal(guard.inFlight(), 0);
  });

  it('forgets a client once it holds nothing', () => {
    // Otherwise this is an unbounded map keyed by client address — the same hole the
    // rate limiter's eviction closes.
    const guard = buildGuard();

    guard.acquire('a')();
    guard.acquire('a');
    guard.acquire('a');

    assert.doesNotThrow(() => guard.acquire('b'));
  });

  it('a client at its ceiling does not block another client', () => {
    const guard = buildGuard({ maxPerClient: 1, maxTotal: 10 });

    guard.acquire('a');

    assert.doesNotThrow(() => guard.acquire('b'));
  });
});
