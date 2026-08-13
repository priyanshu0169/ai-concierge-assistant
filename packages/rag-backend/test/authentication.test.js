import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { createKeyStore, verifyToken } from '@shopsage/session-token';
import { createApp } from '../src/app.js';
import { createHealthService } from '../src/health/health-service.js';
import {
  createAuthenticationMiddleware,
  createUnauthenticatedMiddleware,
} from '../src/http/middleware/authenticate.js';
import { readJson, startTestServer } from './helpers/start-test-server.js';
import { buildTestConfig, createStubAssistant } from './helpers/test-doubles.js';
import { createLogger } from '@shopsage/platform';

/**
 * Authentication at the HTTP boundary, driven by the **real** verifier and the shared
 * contract vectors — not a stub. The unit tests in `@shopsage/session-token` prove the
 * verifier; this proves the wiring: which routes are covered, what a client is told, what is
 * logged, and that the session reaches the domain.
 */
const FIXTURE = JSON.parse(
  readFileSync(new URL('../../session-token/test/vectors/vectors.json', import.meta.url), 'utf8'),
);

const tokenFor = (/** @type {string} */ id) =>
  FIXTURE.vectors.find((/** @type {any} */ vector) => vector.id === id).token;

/**
 * @param {{ enabled?: boolean, now?: number, production?: boolean }} [options]
 */
function buildApp(options = {}) {
  // `test-store` in the shared config, but the vectors were minted for `demo-store`, so the
  // profile has to agree with the fixture or every token is a tenancy violation.
  const config = buildTestConfig({
    env: {
      RATE_LIMIT_ENABLED: 'false',
      ...(options.production === true ? { NODE_ENV: 'production' } : {}),
    },
  });
  const siteProfile = {
    ...config.siteProfile,
    identity: { ...config.siteProfile.identity, siteId: FIXTURE.parameters.siteId },
  };
  const assistant = createStubAssistant();
  /** @type {any[]} */
  const records = [];
  const logger = createLogger({
    level: 'trace',
    sink: { write: (line) => records.push(JSON.parse(line)) },
  });

  const keys = createKeyStore({
    url: 'https://store.example.com/jwks.json',
    fetchImpl: () => Promise.resolve(new Response(JSON.stringify(FIXTURE.jwks), { status: 200 })),
  });

  const authentication =
    options.enabled === false
      ? createUnauthenticatedMiddleware({ siteId: FIXTURE.parameters.siteId, logger })
      : createAuthenticationMiddleware({
          verify: (token) =>
            verifyToken(token, {
              issuer: FIXTURE.parameters.issuer,
              audience: FIXTURE.parameters.audience,
              siteId: FIXTURE.parameters.siteId,
              algorithm: FIXTURE.parameters.algorithm,
              resolveKey: keys.resolveKey,
              now: () => options.now ?? FIXTURE.vectors[0].now,
            }),
        });

  return {
    assistant,
    records,
    app: createApp({
      config: /** @type {any} */ ({ ...config, siteProfile }),
      logger,
      healthService: createHealthService({ serviceName: 'test', version: '0.1.0-test' }),
      assistant,
      authentication,
    }),
  };
}

/**
 * @param {import('./helpers/start-test-server.js').TestServer} server
 * @param {string} [token]
 */
const ask = (server, token) =>
  server.request('/v1/chat', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(token === undefined ? {} : { authorization: `Bearer ${token}` }),
    },
    body: JSON.stringify({ message: 'How long for returns?' }),
  });

describe('authentication', () => {
  it('accepts a valid token and answers', async () => {
    const built = buildApp();
    const server = await startTestServer(built.app);

    try {
      assert.equal((await ask(server, tokenFor('valid'))).status, 200);
    } finally {
      await server.close();
    }
  });

  it('refuses a request with no token', async () => {
    const built = buildApp();
    const server = await startTestServer(built.app);

    try {
      const response = await ask(server);
      const body = await readJson(response);

      assert.equal(response.status, 401);
      assert.equal(body.error.code, 'UNAUTHORIZED');
      assert.equal(built.assistant.requests.length, 0, 'must not reach the domain');
    } finally {
      await server.close();
    }
  });

  it('ignores an Authorization header that is not a bearer token', async () => {
    const built = buildApp();
    const server = await startTestServer(built.app);

    try {
      const response = await server.request('/v1/chat', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Basic ${Buffer.from('user:pass').toString('base64')}`,
        },
        body: JSON.stringify({ message: 'Hi.' }),
      });

      assert.equal(response.status, 401);
    } finally {
      await server.close();
    }
  });

  it('reports an expired token distinctly, so a widget knows to refresh', async () => {
    // Collapsing this into UNAUTHORIZED would make a routine fifteen-minute expiry
    // indistinguishable from a real rejection, and a widget would give up instead of
    // fetching a new token.
    const built = buildApp();
    const server = await startTestServer(built.app);

    try {
      const response = await ask(server, tokenFor('expired'));

      assert.equal(response.status, 401);
      assert.equal((await readJson(response)).error.code, 'TOKEN_EXPIRED');
    } finally {
      await server.close();
    }
  });

  it('never tells a caller which check failed', async () => {
    // Knowing that the *audience* was wrong rather than the signature is exactly what an
    // attacker would use to work out what to change next.
    //
    // Asserted under production, where the guarantee has to hold: outside it the envelope
    // also carries a stack, and a stack names the functions it passed through. This test
    // found a real leak — a 401 is an exposed error, so the reason in `details` was being
    // published until the middleware started stripping it.
    const built = buildApp({ production: true });
    const server = await startTestServer(built.app);

    try {
      for (const id of ['wrong-signing-key', 'wrong-audience', 'wrong-sid', 'alg-none']) {
        const body = JSON.stringify(await readJson(await ask(server, tokenFor(id))));

        for (const leak of ['signature', 'audience', 'tenancy', 'algorithm', 'sid', 'reason']) {
          assert.ok(!body.includes(leak), `${id} leaked "${leak}"`);
        }
      }
    } finally {
      await server.close();
    }
  });

  it('still distinguishes an expiry in production, because a client acts on it', async () => {
    const built = buildApp({ production: true });
    const server = await startTestServer(built.app);

    try {
      const body = await readJson(await ask(server, tokenFor('expired')));

      assert.equal(body.error.code, 'TOKEN_EXPIRED');
      assert.equal(body.error.details, undefined);
      assert.equal(body.error.stack, undefined);
    } finally {
      await server.close();
    }
  });

  describe('what it logs', () => {
    /** @param {string} id */
    async function reasonFor(id) {
      const built = buildApp();
      const server = await startTestServer(built.app);

      try {
        await ask(server, tokenFor(id));

        return built.records.find((record) => record.msg === 'session token rejected');
      } finally {
        await server.close();
      }
    }

    it('records the precise reason, which the caller never sees', async () => {
      assert.equal((await reasonFor('wrong-audience'))?.reason, 'audience_mismatch');
    });

    it('treats an expiry as ordinary', async () => {
      // Every customer, every fifteen minutes, by design. A warning here would train an
      // operator to ignore the log.
      assert.equal((await reasonFor('expired'))?.level, 'info');
    });

    it('treats a forged algorithm as an attack', async () => {
      // Base rate zero in honest traffic.
      assert.equal((await reasonFor('alg-none'))?.level, 'error');
    });

    it('treats a bad signature as an attack', async () => {
      assert.equal((await reasonFor('wrong-signing-key'))?.level, 'error');
    });

    it('treats another store’s token as an attack', async () => {
      assert.equal((await reasonFor('wrong-sid'))?.level, 'error');
    });
  });

  describe('the session it produces', () => {
    it('passes the scopes to the domain, so capability gating can apply', async () => {
      const built = buildApp();
      const server = await startTestServer(built.app);

      try {
        await ask(server, tokenFor('valid'));

        assert.deepEqual(built.assistant.requests.at(-1)?.scopes, ['chat', 'orders']);
      } finally {
        await server.close();
      }
    });

    it('passes an empty scope list through rather than refusing', async () => {
      // A token with no usable scope is a perfectly valid token. The request succeeds and the
      // capability is simply absent — a verifier that 401s here has the contract wrong.
      const built = buildApp();
      const server = await startTestServer(built.app);

      try {
        const response = await ask(server, tokenFor('invalid-scope'));

        assert.equal(response.status, 200);
        assert.deepEqual(built.assistant.requests.at(-1)?.scopes, []);
      } finally {
        await server.close();
      }
    });
  });

  it('leaves the health endpoints open', async () => {
    // An orchestrator has no token and must never need one.
    const built = buildApp();
    const server = await startTestServer(built.app);

    try {
      assert.equal((await server.request('/health')).status, 200);
      assert.equal((await server.request('/health/info')).status, 200);
    } finally {
      await server.close();
    }
  });

  describe('when disabled', () => {
    it('serves a synthetic guest session rather than no session', async () => {
      // `req.session` stays non-optional, so no handler grows a fallback — and a fallback in
      // an authorisation path is how a gate stops gating.
      const built = buildApp({ enabled: false });
      const server = await startTestServer(built.app);

      try {
        assert.equal((await ask(server)).status, 200);
        assert.deepEqual(built.assistant.requests.at(-1)?.scopes, ['chat']);
      } finally {
        await server.close();
      }
    });

    it('says so, loudly, at construction', () => {
      const built = buildApp({ enabled: false });

      const warning = built.records.find((record) => record.msg === 'authentication is disabled');
      assert.equal(warning?.level, 'warn');
      assert.match(String(warning?.remediation), /AUTH_ENABLED=true/u);
    });
  });
});
