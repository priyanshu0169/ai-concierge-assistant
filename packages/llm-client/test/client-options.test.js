import assert from 'node:assert/strict';
import { ConfigurationError } from '@shopsage/platform';
import { describe, it } from 'node:test';
import { buildAuthHeaders, resolveClientSettings } from '../src/client-options.js';
import { TEST_API_KEY, testClientOptions } from './helpers/fake-gateway.js';

describe('resolveClientSettings', () => {
  it('applies the defaults a commerce assistant should have', () => {
    const settings = resolveClientSettings(testClientOptions());

    // Low temperature by default: a store assistant quoting a return policy
    // should not improvise.
    assert.equal(settings.temperature, 0.2);
    assert.equal(settings.maxTokens, 1024);
    assert.equal(settings.timeoutMs, 60_000);
    assert.equal(settings.maxAttempts, 3);
    assert.equal(settings.authStyle, 'bearer');
    assert.equal(settings.includeStreamUsage, true);
  });

  it('freezes the settings, so nothing can retune the client at runtime', () => {
    const settings = resolveClientSettings(testClientOptions());

    assert.equal(Object.isFrozen(settings), true);
  });

  describe('endpoint resolution', () => {
    /**
     * @param {string} baseUrl
     * @returns {string}
     */
    const endpointFor = (baseUrl) => resolveClientSettings(testClientOptions({ baseUrl })).endpoint;

    it('appends the completions path to an API base', () => {
      assert.equal(
        endpointFor('https://gateway.test/v1'),
        'https://gateway.test/v1/chat/completions',
      );
    });

    it('tolerates a trailing slash', () => {
      assert.equal(
        endpointFor('https://gateway.test/v1/'),
        'https://gateway.test/v1/chat/completions',
      );
    });

    it('accepts a host with no path', () => {
      assert.equal(endpointFor('http://localhost:8000'), 'http://localhost:8000/chat/completions');
    });

    it('leaves a full completions URL alone', () => {
      // Operators paste the whole URL from a provider's console. Appending to it
      // would produce /chat/completions/chat/completions.
      assert.equal(
        endpointFor('https://gateway.test/v1/chat/completions'),
        'https://gateway.test/v1/chat/completions',
      );
    });

    it('preserves the query string, which Azure OpenAI needs', () => {
      const azure =
        'https://acct.openai.azure.com/openai/deployments/gpt/chat/completions?api-version=2024-06-01';

      assert.equal(endpointFor(azure), azure);
    });
  });

  describe('authentication style', () => {
    it('presents a bearer token by default', () => {
      const settings = resolveClientSettings(testClientOptions());

      assert.deepEqual(buildAuthHeaders(settings), { authorization: `Bearer ${TEST_API_KEY}` });
    });

    it('presents an api-key header for Azure OpenAI', () => {
      const settings = resolveClientSettings(testClientOptions({ authStyle: 'api-key' }));

      assert.deepEqual(buildAuthHeaders(settings), { 'api-key': TEST_API_KEY });
    });
  });

  describe('rejection', () => {
    /**
     * @param {Record<string, unknown>} overrides
     * @param {RegExp} expectedPath
     */
    function assertRejected(overrides, expectedPath) {
      try {
        resolveClientSettings(
          /** @type {import('../src/types.js').LlmClientOptions} */ ({
            ...testClientOptions(),
            ...overrides,
          }),
        );
        assert.fail('expected a ConfigurationError');
      } catch (error) {
        assert.ok(error instanceof ConfigurationError);
        assert.equal(error.expose, false);
        const issues = /** @type {{ path: string }[]} */ (error.details?.issues);
        assert.match(issues[0].path, expectedPath);
      }
    }

    it('refuses to construct without a credential', () => {
      assertRejected({ apiKey: undefined }, /apiKey/);
    });

    it('refuses to construct without a model', () => {
      assertRejected({ model: undefined }, /model/);
    });

    it('refuses a non-http base URL', () => {
      assertRejected({ baseUrl: 'ftp://gateway.test' }, /baseUrl/);
    });

    it('refuses a temperature outside the supported range', () => {
      assertRejected({ temperature: 5 }, /temperature/);
    });

    it('refuses a non-positive timeout', () => {
      assertRejected({ timeoutMs: 0 }, /timeoutMs/);
    });

    it('never puts the credential in the error', () => {
      try {
        resolveClientSettings(
          /** @type {import('../src/types.js').LlmClientOptions} */ ({
            ...testClientOptions(),
            model: '',
          }),
        );
        assert.fail('expected a ConfigurationError');
      } catch (error) {
        assert.ok(!JSON.stringify(error).includes(TEST_API_KEY));
      }
    });
  });
});
