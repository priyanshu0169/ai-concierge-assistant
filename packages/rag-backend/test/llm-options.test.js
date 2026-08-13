import assert from 'node:assert/strict';
import { ConfigurationError, parseEnv } from '@shopsage/platform';
import { describe, it } from 'node:test';
import { toLlmClientOptions } from '../src/composition/llm-options.js';

const COMPLETE = {
  LLM_API_KEY: 'sk-test-000111222333',
  LLM_BASE_URL: 'https://gateway.internal/v1',
  LLM_MODEL: 'some-model',
};

describe('toLlmClientOptions', () => {
  it('maps the environment onto the client options', () => {
    const options = toLlmClientOptions(
      parseEnv({ ...COMPLETE, LLM_TEMPERATURE: '0.5', LLM_MAX_TOKENS: '2048' }),
    );

    assert.equal(options.apiKey, COMPLETE.LLM_API_KEY);
    assert.equal(options.baseUrl, COMPLETE.LLM_BASE_URL);
    assert.equal(options.model, COMPLETE.LLM_MODEL);
    assert.equal(options.temperature, 0.5);
    assert.equal(options.maxTokens, 2048);
  });

  it('carries the operational defaults through', () => {
    const options = toLlmClientOptions(parseEnv(COMPLETE));

    assert.equal(options.timeoutMs, 60_000);
    assert.equal(options.maxAttempts, 3);
    assert.equal(options.authStyle, 'bearer');
    assert.equal(options.includeStreamUsage, true);
  });

  it('passes the compatibility switches through', () => {
    const options = toLlmClientOptions(
      parseEnv({
        ...COMPLETE,
        LLM_AUTH_STYLE: 'api-key',
        LLM_STREAM_INCLUDE_USAGE: 'false',
        LLM_MAX_ATTEMPTS: '5',
      }),
    );

    assert.equal(options.authStyle, 'api-key');
    assert.equal(options.includeStreamUsage, false);
    assert.equal(options.maxAttempts, 5);
  });

  describe('when the gateway is not configured', () => {
    it('refuses to build, so the backend cannot boot without a model', () => {
      // A misconfigured assistant is worse than an absent one: it answers a
      // customer's first question with a 502.
      assert.throws(() => toLlmClientOptions(parseEnv({})), ConfigurationError);
    });

    it('names every missing variable at once', () => {
      // One variable per boot attempt is a miserable way to configure a service.
      try {
        toLlmClientOptions(parseEnv({}));
        assert.fail('expected a ConfigurationError');
      } catch (error) {
        assert.ok(error instanceof ConfigurationError);
        assert.deepEqual(error.details?.missing, ['LLM_API_KEY', 'LLM_BASE_URL', 'LLM_MODEL']);
        assert.match(String(error.details?.remediation), /environment/);
      }
    });

    it('names the environment variable, not the client option', () => {
      try {
        toLlmClientOptions(parseEnv({ LLM_BASE_URL: COMPLETE.LLM_BASE_URL, LLM_MODEL: 'm' }));
        assert.fail('expected a ConfigurationError');
      } catch (error) {
        assert.ok(error instanceof ConfigurationError);
        assert.deepEqual(error.details?.missing, ['LLM_API_KEY']);
      }
    });

    it('does not expose the failure to an external caller', () => {
      try {
        toLlmClientOptions(parseEnv({}));
        assert.fail('expected a ConfigurationError');
      } catch (error) {
        assert.ok(error instanceof ConfigurationError);
        assert.equal(error.expose, false);
      }
    });
  });

  it('treats a blank credential as absent, matching how operators write env files', () => {
    // `LLM_API_KEY=` is a placeholder somebody meant to fill in, not a key.
    assert.throws(
      () => toLlmClientOptions(parseEnv({ ...COMPLETE, LLM_API_KEY: '   ' })),
      ConfigurationError,
    );
  });
});
