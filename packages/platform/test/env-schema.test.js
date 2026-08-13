import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ConfigurationError } from '../src/errors/errors.js';
import { parseEnv } from '../src/config/env-schema.js';

describe('parseEnv', () => {
  it('applies defaults so an empty environment still boots', () => {
    const env = parseEnv({});

    assert.equal(env.NODE_ENV, 'development');
    assert.equal(env.PORT, 3000);
    assert.equal(env.LOG_LEVEL, 'info');
    // The hosted gateway is the default backend, so the defaults describe it. Both
    // must move together: 1536 is text-embedding-3-small's native width, and a
    // mismatch is rejected on every response.
    assert.equal(env.EMBEDDING_PROVIDER, 'openai');
    assert.equal(env.EMBEDDING_MODEL, 'text-embedding-3-small');
    assert.equal(env.EMBEDDING_DIMENSIONS, 1536);
    // `localhost`, not the Docker service name: Compose always overrides this variable
    // for the container regardless of what `.env` or this default says (see the schema
    // comment), so the default only ever matters for a bare `node` process outside
    // Docker - the ingestion CLI, a test, a one-off script - where `localhost` is the
    // address Qdrant's container port is actually published to.
    assert.equal(env.QDRANT_URL, 'http://localhost:6333');
    assert.equal(env.TRUST_PROXY, false);
    assert.deepEqual(env.CORS_ALLOWED_ORIGINS, ['*']);
  });

  it('coerces numeric strings, because every environment value is a string', () => {
    const env = parseEnv({ PORT: '8080', LLM_TEMPERATURE: '0.7', LLM_MAX_TOKENS: '2048' });

    assert.equal(env.PORT, 8080);
    assert.equal(env.LLM_TEMPERATURE, 0.7);
    assert.equal(env.LLM_MAX_TOKENS, 2048);
  });

  it('treats blank values as absent rather than as the empty string', () => {
    // Operators routinely leave `FOO=` in an env file for a setting they have
    // not filled in. That must fall back to the default, not fail validation.
    const env = parseEnv({ PORT: '', LLM_API_KEY: '   ', LOG_LEVEL: '' });

    assert.equal(env.PORT, 3000);
    assert.equal(env.LOG_LEVEL, 'info');
    assert.equal(env.LLM_API_KEY, undefined);
  });

  it('parses a comma separated origin allow-list', () => {
    const env = parseEnv({
      CORS_ALLOWED_ORIGINS: 'https://shop.example.com, https://www.example.com ,',
    });

    assert.deepEqual(env.CORS_ALLOWED_ORIGINS, [
      'https://shop.example.com',
      'https://www.example.com',
    ]);
  });

  it('parses TRUST_PROXY into a boolean', () => {
    assert.equal(parseEnv({ TRUST_PROXY: 'true' }).TRUST_PROXY, true);
    assert.equal(parseEnv({ TRUST_PROXY: 'false' }).TRUST_PROXY, false);
  });

  it('ignores unrelated environment variables', () => {
    // process.env carries hundreds of host variables; they must not be errors.
    assert.doesNotThrow(() => parseEnv({ PATH: '/usr/bin', HOME: '/root' }));
  });

  it('rejects an out-of-range port', () => {
    assert.throws(() => parseEnv({ PORT: '99999' }), ConfigurationError);
  });

  it('rejects a non-http LLM base URL', () => {
    assert.throws(() => parseEnv({ LLM_BASE_URL: 'ftp://gateway.internal' }), ConfigurationError);
  });

  it('rejects an unknown log level', () => {
    assert.throws(() => parseEnv({ LOG_LEVEL: 'verbose' }), ConfigurationError);
  });

  it('reports which variable failed, so the operator can fix it', () => {
    try {
      parseEnv({ PORT: 'not-a-number' });
      assert.fail('expected a ConfigurationError');
    } catch (error) {
      assert.ok(error instanceof ConfigurationError);
      const issues = /** @type {{ path: string }[]} */ (error.details?.issues);
      assert.equal(issues[0].path, 'PORT');
      assert.equal(error.expose, false);
    }
  });
});
