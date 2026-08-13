import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { AppError } from '../src/errors/app-error.js';
import { ERROR_CODES } from '../src/errors/error-codes.js';
import {
  ConfigurationError,
  RateLimitError,
  TimeoutError,
  UpstreamError,
  ValidationError,
} from '../src/errors/errors.js';
import { serializeError } from '../src/errors/serialize-error.js';

describe('AppError', () => {
  it('defaults to a non-exposed internal error', () => {
    const error = new AppError('boom');

    assert.equal(error.code, ERROR_CODES.INTERNAL_ERROR);
    assert.equal(error.status, 500);
    assert.equal(error.expose, false);
    assert.equal(error.retryable, false);
    assert.equal(error.name, 'AppError');
  });

  it('exposes client errors by default so their message can be returned', () => {
    assert.equal(new AppError('bad input', { status: 400 }).expose, true);
  });

  it('reports its own subclass name', () => {
    assert.equal(new ValidationError('nope').name, 'ValidationError');
  });

  it('preserves the cause chain', () => {
    const root = new Error('socket hang up');
    const error = new UpstreamError('gateway failed', { cause: root });

    assert.equal(error.cause, root);
  });

  it('serializes without leaking the cause into the payload', () => {
    const error = new ValidationError('field missing', { details: { field: 'message' } });

    assert.deepEqual(error.toJSON(), {
      name: 'ValidationError',
      code: ERROR_CODES.VALIDATION_FAILED,
      status: 400,
      message: 'field missing',
      retryable: false,
      details: { field: 'message' },
    });
  });

  it('identifies its own instances', () => {
    assert.equal(AppError.is(new TimeoutError('slow')), true);
    assert.equal(AppError.is(new Error('plain')), false);
    assert.equal(AppError.is('not an error'), false);
  });
});

describe('error taxonomy', () => {
  it('maps each error to the status and exposure an HTTP boundary needs', () => {
    /** @type {[AppError, number, boolean, boolean][]} */
    const cases = [
      [new ValidationError('x'), 400, true, false],
      [new RateLimitError('x'), 429, true, true],
      [new TimeoutError('x'), 504, false, true],
      [new UpstreamError('x'), 502, false, true],
      [new ConfigurationError('x'), 500, false, false],
    ];

    for (const [error, status, expose, retryable] of cases) {
      assert.equal(error.status, status, `${error.name} status`);
      assert.equal(error.expose, expose, `${error.name} expose`);
      assert.equal(error.retryable, retryable, `${error.name} retryable`);
    }
  });

  it('carries a retry hint on rate limit errors', () => {
    assert.equal(new RateLimitError('slow down', { retryAfterSeconds: 30 }).retryAfterSeconds, 30);
  });
});

describe('serializeError', () => {
  it('keeps diagnostics that JSON.stringify would otherwise discard', () => {
    const serialized = serializeError(new Error('plain failure'));

    assert.equal(serialized.name, 'Error');
    assert.equal(serialized.message, 'plain failure');
    assert.ok(typeof serialized.stack === 'string');
  });

  it('walks the cause chain', () => {
    const error = new UpstreamError('outer', { cause: new Error('inner') });
    const serialized = serializeError(error);
    const cause = /** @type {Record<string, unknown>} */ (serialized.cause);

    assert.equal(cause.message, 'inner');
  });

  it('handles thrown non-errors', () => {
    assert.deepEqual(serializeError('just a string'), {
      name: 'NonError',
      message: 'just a string',
    });
    assert.equal(serializeError({ weird: true }).name, 'NonError');
  });

  it('stops walking a self-referential cause chain', () => {
    const error = new Error('loop');
    Object.defineProperty(error, 'cause', { value: error });

    assert.doesNotThrow(() => serializeError(error));
  });
});
