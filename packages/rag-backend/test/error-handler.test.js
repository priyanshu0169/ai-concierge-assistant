import assert from 'node:assert/strict';
import express from 'express';
import { RateLimitError, UpstreamError, ValidationError } from '@shopsage/platform';
import { describe, it } from 'node:test';
import { createErrorHandlerMiddleware } from '../src/http/middleware/error-handler.js';
import { createRequestIdMiddleware } from '../src/http/middleware/request-id.js';
import { startTestServer } from './helpers/start-test-server.js';
import { createSilentLogger } from './helpers/test-doubles.js';

/**
 * Minimal app whose only job is to throw a chosen error, so the handler can be
 * exercised without a real route.
 *
 * @param {unknown} error
 * @param {{ includeStack?: boolean }} [options]
 * @returns {import('express').Express}
 */
function buildThrowingApp(error, options = {}) {
  const app = express();

  app.use(createRequestIdMiddleware({ logger: createSilentLogger() }));
  app.get('/boom', () => {
    throw error;
  });
  app.use(createErrorHandlerMiddleware(options));

  return app;
}

/**
 * @param {unknown} error
 * @param {{ includeStack?: boolean }} [options]
 * @returns {Promise<{ status: number, body: any }>}
 */
async function requestBoom(error, options) {
  const server = await startTestServer(buildThrowingApp(error, options));

  try {
    const response = await server.request('/boom');
    return { status: response.status, body: await response.json() };
  } finally {
    await server.close();
  }
}

describe('error handler', () => {
  it('returns the message of an exposed error verbatim', async () => {
    const { status, body } = await requestBoom(
      new ValidationError('message must not be empty', { details: { field: 'message' } }),
    );

    assert.equal(status, 400);
    assert.equal(body.error.code, 'VALIDATION_FAILED');
    assert.equal(body.error.message, 'message must not be empty');
    assert.deepEqual(body.error.details, { field: 'message' });
  });

  it('masks the message of an internal error', async () => {
    const { status, body } = await requestBoom(
      new UpstreamError('LLM gateway at https://internal-gw/v1 returned 500'),
    );

    // The customer sees a generic message; the operator sees the real one in
    // the logs, correlated by request id.
    assert.equal(status, 502);
    assert.equal(body.error.code, 'UPSTREAM_FAILURE');
    assert.equal(body.error.message, 'An unexpected error occurred. Please try again.');
    assert.equal(body.error.details, undefined);
  });

  it('masks an unclassified throw as a 500 without leaking its message', async () => {
    const { status, body } = await requestBoom(new Error('connect ECONNREFUSED 10.0.0.4:6333'));

    assert.equal(status, 500);
    assert.equal(body.error.code, 'INTERNAL_ERROR');
    assert.ok(!body.error.message.includes('10.0.0.4'));
  });

  it('masks a thrown non-error value', async () => {
    const { status, body } = await requestBoom('a bare string');

    assert.equal(status, 500);
    assert.equal(body.error.code, 'INTERNAL_ERROR');
  });

  it('always includes the request id, so a report can be traced to a log line', async () => {
    const { body } = await requestBoom(new RateLimitError('too many requests'));

    assert.match(body.error.requestId, /^[0-9a-f-]{36}$/);
  });

  it('omits stacks by default and includes them only when asked', async () => {
    const withoutStack = await requestBoom(new Error('x'));
    const withStack = await requestBoom(new Error('x'), { includeStack: true });

    assert.equal(withoutStack.body.error.stack, undefined);
    assert.ok(typeof withStack.body.error.stack === 'string');
  });
});
