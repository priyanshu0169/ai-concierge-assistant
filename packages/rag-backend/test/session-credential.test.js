import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createLogger } from '@shopsage/platform';
import { createKeyStore, verifyToken } from '@shopsage/session-token';
import { after, before, describe, it } from 'node:test';
import { createApp } from '../src/app.js';
import { createHealthService } from '../src/health/health-service.js';
import { createAuthenticationMiddleware } from '../src/http/middleware/authenticate.js';
import { startTestServer } from './helpers/start-test-server.js';
import {
  buildTestConfig,
  createSilentLogger,
  createStubAssistant,
} from './helpers/test-doubles.js';

/**
 * How the customer's session token reaches the commerce connector, and where it must not go.
 *
 * Driven by the **real** verifier and the shared contract vectors, because the property under test
 * is about a real token: that it is forwarded intact to the domain, and that it appears in no log
 * line on the way.
 */
const FIXTURE = JSON.parse(
  readFileSync(new URL('../../session-token/test/vectors/vectors.json', import.meta.url), 'utf8'),
);

const VALID_TOKEN = FIXTURE.vectors.find((/** @type {any} */ v) => v.id === 'valid').token;

function buildApp() {
  const config = buildTestConfig({ env: { RATE_LIMIT_ENABLED: 'false' } });
  const siteProfile = {
    ...config.siteProfile,
    identity: { ...config.siteProfile.identity, siteId: FIXTURE.parameters.siteId },
  };
  const assistant = createStubAssistant();
  /** @type {any[]} */
  const records = [];

  const keys = createKeyStore({
    url: 'https://issuer.example.com/jwks.json',
    fetchImpl: /** @type {any} */ (
      () => Promise.resolve(new Response(JSON.stringify(FIXTURE.jwks)))
    ),
  });

  const app = createApp({
    config: { ...config, siteProfile },
    logger: createLogger({
      level: 'trace',
      sink: { write: (line) => records.push(JSON.parse(line)) },
    }),
    healthService: createHealthService({ serviceName: 'test', version: '0.1.0-test' }),
    assistant,
    authentication: createAuthenticationMiddleware({
      verify: (token) =>
        verifyToken(token, {
          issuer: FIXTURE.parameters.issuer,
          audience: FIXTURE.parameters.audience,
          siteId: FIXTURE.parameters.siteId,
          algorithm: 'ES256',
          clockSkewSeconds: 60,
          now: () => FIXTURE.parameters.validAt * 1000,
          resolveKey: keys.resolveKey,
        }),
    }),
  });

  return { app, assistant, records };
}

describe('forwarding the session token to the commerce connector', () => {
  /** @type {import('./helpers/start-test-server.js').TestServer} */
  let server;
  /** @type {ReturnType<typeof createStubAssistant>} */
  let assistant;
  /** @type {any[]} */
  let records;

  before(async () => {
    const built = buildApp();

    assistant = built.assistant;
    records = built.records;
    server = await startTestServer(built.app);

    await server.request('/v1/chat', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${VALID_TOKEN}`,
      },
      body: JSON.stringify({ message: 'do you sell wool hoodies?' }),
    });

    // The streamed path too, in the same setup. The two call sites are separate object literals, so a
    // field added to one and forgotten on the other is exactly the shape of the defect above - and it
    // would have shown up only for stores with streaming on, which is almost all of them.
    const stream = await server.request('/v1/chat/stream', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'text/event-stream',
        authorization: `Bearer ${VALID_TOKEN}`,
      },
      body: JSON.stringify({ message: 'and internationally?' }),
    });

    await stream.text();
  });

  after(() => server?.close());

  it('hands the domain the token verbatim', () => {
    // Verbatim, because the connector minted it and verifies it. Re-signing or re-encoding it here
    // would make ShopSage a second issuer, which the accepted contract forbids.
    assert.equal(assistant.requests[0].credential, VALID_TOKEN);
  });

  it('hands the domain the session scopes alongside it', () => {
    assert.deepEqual(assistant.requests[0].scopes, ['chat', 'orders']);
  });

  it('hands the domain the pseudonymous subject on both paths', () => {
    // A real defect this did not catch until it was tried against a running stack: without the subject
    // the domain falls back to the conversation id, and the confirmation endpoint - which compares
    // against `req.session.subject` - then refuses every cart proposal it was handed. Every prepared
    // change was unconfirmable, with the whole suite green.
    assert.equal(assistant.requests.length, 2);

    for (const request of assistant.requests) {
      assert.match(String(request.subject), /^ps_/u, JSON.stringify(request));
    }
  });

  it('writes the token to no log line at all', () => {
    // The reason the token is kept off `req.session`: the session is bound into the request logger,
    // so a credential on it would be one careless `{ session }` away from log storage.
    assert.ok(records.length > 0, 'the request should have been logged');
    assert.ok(!JSON.stringify(records).includes(VALID_TOKEN));
  });

  it('still logs the pseudonymous subject, which is what a support trace follows', () => {
    const logged = records.find((entry) => entry.subject !== undefined);

    assert.ok(logged);
    assert.match(logged.subject, /^ps_/u);
  });
});

describe('when authentication is disabled', () => {
  it('forwards no credential, because there is no token to forward', async () => {
    const config = buildTestConfig({ env: { RATE_LIMIT_ENABLED: 'false' } });
    const assistant = createStubAssistant();
    const app = createApp({
      config,
      logger: createSilentLogger(),
      healthService: createHealthService({ serviceName: 'test', version: '0.1.0-test' }),
      assistant,
      // The synthetic guest middleware, which is what runs with AUTH_ENABLED=false.
      authentication: (req, _res, next) => {
        // eslint-disable-next-line no-param-reassign
        req.session = {
          subject: 'dev:127.0.0.1',
          siteId: 'test-store',
          scopes: ['chat'],
          tokenId: 'dev',
          expiresAt: 0,
        };
        next();
      },
    });
    const server = await startTestServer(app);

    try {
      await server.request('/v1/chat', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ message: 'hello' }),
      });

      // Absent rather than an empty string. A commerce read with no credential is a read the
      // connector can reject on its own terms; a blank bearer looks like a malformed one.
      assert.equal('credential' in assistant.requests[0], false);
    } finally {
      await server.close();
    }
  });
});
