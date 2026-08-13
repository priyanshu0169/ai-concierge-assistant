import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { createApp } from '../src/app.js';
import { createHealthService } from '../src/health/health-service.js';
import { readJson, startTestServer } from './helpers/start-test-server.js';
import {
  buildTestConfig,
  createSilentLogger,
  createStubAssistant,
  createStubAuthentication,
} from './helpers/test-doubles.js';

/**
 * `GET /v1/config` is the widget's bootstrap, and the tests that matter most here are the
 * **exclusions**. It is browser-facing and unauthenticated, so anything that reaches it
 * reaches everyone.
 */
function buildApp() {
  return createApp({
    config: buildTestConfig(),
    logger: createSilentLogger(),
    healthService: createHealthService({ serviceName: 'test', version: '0.1.0-test' }),
    assistant: createStubAssistant(),
    // Deliberately a middleware that would reject: the config route must not reach it.
    authentication: (_req, _res, next) => next(new Error('authentication must not run')),
  });
}

describe('GET /v1/config', () => {
  /** @type {import('./helpers/start-test-server.js').TestServer} */
  let server;

  before(async () => {
    server = await startTestServer(buildApp());
  });

  after(async () => {
    await server.close();
  });

  it('serves without a session token', async () => {
    // The widget has none until a customer opens the panel, and every field here is about to
    // be painted into a public page anyway.
    const response = await server.request('/v1/config');

    assert.equal(response.status, 200);
  });

  it('publishes what a widget needs to render itself', async () => {
    const body = await readJson(await server.request('/v1/config'));

    assert.deepEqual(Object.keys(body).sort(), [
      'assistantName',
      'branding',
      'companyName',
      'fallbackMessage',
      'features',
      'limits',
      'locale',
      'quickReplies',
      'welcomeMessage',
    ]);
  });

  describe('what it must never publish', () => {
    /** @returns {Promise<string>} */
    const serialized = async () =>
      JSON.stringify(await readJson(await server.request('/v1/config')));

    it('excludes the system prompt', async () => {
      // The single most important exclusion. A store's prompt is how it constrains the model,
      // so publishing it hands anyone trying to talk the assistant out of its instructions
      // the exact text to work around.
      const body = await serialized();

      assert.ok(!body.includes('systemPrompt'));
      assert.ok(!body.includes('helpful shopping assistant'));
    });

    it('excludes retrieval tuning, which is nobody else’s business', async () => {
      const body = await serialized();

      for (const leak of ['minScore', 'topK', 'maxContextCharacters', 'retrieval']) {
        assert.ok(!body.includes(leak), `leaked ${leak}`);
      }
    });

    it('excludes content sources and ingestion settings', async () => {
      const body = await serialized();

      for (const leak of ['content', 'sources', 'ingestion', 'chunk']) {
        assert.ok(!body.includes(leak), `leaked ${leak}`);
      }
    });

    it('excludes integration addresses and the site id', async () => {
      const body = await serialized();

      for (const leak of ['backendUrl', 'magento', 'siteId', 'integrations']) {
        assert.ok(!body.includes(leak), `leaked ${leak}`);
      }
    });

    it('excludes the no-answer message, which the backend applies', async () => {
      // Deciding an answer is empty is not the widget's job, so it has no use for the copy.
      assert.ok(!(await serialized()).includes('noAnswerMessage'));
    });

    it('names its fields rather than deleting unsafe ones', async () => {
      // An allow-list makes a newly added profile field invisible until somebody decides it
      // belongs here. A deny-list would publish it the day it is added.
      const body = await readJson(await server.request('/v1/config'));

      assert.deepEqual(Object.keys(body.features), ['streaming']);
      assert.deepEqual(Object.keys(body.limits), ['maxUserMessageLength']);
    });
  });

  it('resolves identity placeholders in customer-facing copy', async () => {
    // Found by reading a live response, not the schema: a store writing "Hi! I'm
    // {{assistantName}}." would have had a customer greeted with the braces. The same
    // substitution the domain applies to the system prompt, using the same function.
    const withPlaceholders = buildTestConfig();
    const profile = {
      ...withPlaceholders.siteProfile,
      prompts: {
        ...withPlaceholders.siteProfile.prompts,
        welcomeMessage: "Hi! I'm {{assistantName}} from {{companyName}}.",
        fallbackMessage: '{{assistantName}} is having trouble.',
        quickReplies: ['What can {{assistantName}} do?'],
      },
    };

    const app = createApp({
      config: /** @type {any} */ ({ ...withPlaceholders, siteProfile: profile }),
      logger: createSilentLogger(),
      healthService: createHealthService({ serviceName: 'test', version: '0.1.0-test' }),
      assistant: createStubAssistant(),
      authentication: createStubAuthentication(),
    });
    const other = await startTestServer(app);

    try {
      const body = await readJson(await other.request('/v1/config'));

      assert.equal(body.welcomeMessage, "Hi! I'm Helper from Test Store.");
      assert.equal(body.fallbackMessage, 'Helper is having trouble.');
      assert.deepEqual(body.quickReplies, ['What can Helper do?']);
      assert.ok(!JSON.stringify(body).includes('{{'), 'no placeholder may survive');
    } finally {
      await other.close();
    }
  });

  it('carries the branding a widget themes itself from', async () => {
    const body = await readJson(await server.request('/v1/config'));

    assert.match(body.branding.primaryColor, /^#[0-9a-f]{3,6}$/iu);
    assert.ok(['bottom-right', 'bottom-left'].includes(body.branding.position));
    assert.equal(typeof body.branding.launcherLabel, 'string');
  });

  it('tells the widget the message ceiling, so it can stop a customer early', async () => {
    // Otherwise the widget either invents a limit or discovers the real one with a 400.
    const body = await readJson(await server.request('/v1/config'));

    assert.equal(body.limits.maxUserMessageLength, 2000);
  });

  it('is cacheable, because it changes only on a deployment', async () => {
    const response = await server.request('/v1/config');

    assert.match(response.headers.get('cache-control') ?? '', /max-age=\d+/u);
    await response.text();
  });

  it('handles only GET, and leaves any other method to the authenticated chain', async () => {
    // A POST to this path is not a config request, so it falls through to `/v1`'s
    // authentication like anything else there — in production that is a 401, not a 404. The
    // main app under test throws from authentication to prove GET never reaches it, so this
    // needs an app whose authentication behaves.
    const withRealAuth = createApp({
      config: buildTestConfig(),
      logger: createSilentLogger(),
      healthService: createHealthService({ serviceName: 'test', version: '0.1.0-test' }),
      assistant: createStubAssistant(),
      authentication: createStubAuthentication(),
    });
    const other = await startTestServer(withRealAuth);

    try {
      assert.equal((await other.request('/v1/config', { method: 'POST' })).status, 404);
    } finally {
      await other.close();
    }
  });
});
