import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createLogger } from '@shopsage/platform';
import express from 'express';
import { createRequestIdMiddleware } from '../src/http/middleware/request-id.js';
import { createRequestLoggerMiddleware } from '../src/http/middleware/request-logger.js';
import { getRequestPath } from '../src/http/request-path.js';
import { startTestServer } from './helpers/start-test-server.js';

/**
 * An app whose routes live in a *mounted* router, which is what makes this
 * test meaningful: Express rewrites `req.url` while dispatching into a mounted
 * router, so a logger that reads `req.path` after the fact records the path
 * relative to the mount point instead of the real one.
 *
 * @param {{ write: (chunk: string) => void }} sink
 * @returns {import('express').Express}
 */
function buildMountedApp(sink) {
  const app = express();
  const nested = express.Router();

  nested.get('/', (_req, res) => {
    res.json({ ok: true });
  });
  nested.get('/info', (_req, res) => {
    res.json({ ok: true });
  });

  app.use(createRequestIdMiddleware({ logger: createLogger({ sink }) }));
  app.use(createRequestLoggerMiddleware());
  app.use('/health', nested);

  return app;
}

/**
 * @param {string} path
 * @returns {Promise<Record<string, unknown>>}
 */
async function logRecordFor(path) {
  /** @type {string[]} */
  const lines = [];
  const server = await startTestServer(
    buildMountedApp({
      write: (chunk) => {
        lines.push(chunk);
      },
    }),
  );

  try {
    await server.request(path);
    // `finish` fires as the response completes; give the listener a turn.
    await new Promise((resolve) => setImmediate(resolve));

    const completion = lines
      .map((line) => JSON.parse(line))
      .find((r) => r.msg === 'request completed');
    assert.ok(completion, 'expected a request completion record');

    return completion;
  } finally {
    await server.close();
  }
}

describe('getRequestPath', () => {
  it('strips the query string so customer text cannot reach access logs', () => {
    const req = /** @type {import('express').Request} */ (
      /** @type {unknown} */ ({ originalUrl: '/v1/chat?message=my%20order%20number%20is%2012345' })
    );

    assert.equal(getRequestPath(req), '/v1/chat');
  });

  it('returns a path unchanged when there is no query string', () => {
    const req = /** @type {import('express').Request} */ (
      /** @type {unknown} */ ({ originalUrl: '/health/ready' })
    );

    assert.equal(getRequestPath(req), '/health/ready');
  });

  it('normalises an empty path to the root', () => {
    const req = /** @type {import('express').Request} */ (
      /** @type {unknown} */ ({ originalUrl: '?a=1' })
    );

    assert.equal(getRequestPath(req), '/');
  });
});

describe('request logging', () => {
  it('logs the full path for a route inside a mounted router', async () => {
    // Regression: this previously logged "/" because req.url is rewritten
    // during dispatch into the mounted router.
    const record = await logRecordFor('/health');

    assert.equal(record.path, '/health');
    assert.equal(record.method, 'GET');
    assert.equal(record.status, 200);
  });

  it('logs the full path for a nested route', async () => {
    // Regression: this previously logged "/info".
    const record = await logRecordFor('/health/info');

    assert.equal(record.path, '/health/info');
  });

  it('records duration and correlation id', async () => {
    const record = await logRecordFor('/health');

    assert.equal(typeof record.durationMs, 'number');
    assert.match(String(record.requestId), /^[0-9a-f-]{36}$/);
  });
});
