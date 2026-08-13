import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { REDACTED, isSensitiveKey, redact } from '../src/logger/redact.js';

describe('redact', () => {
  it('replaces values under sensitive keys', () => {
    const result = redact({
      LLM_API_KEY: 'sk-live-secret',
      QDRANT_API_KEY: 'qdrant-secret',
      authorization: 'Bearer abc',
      password: 'hunter2',
      MAGENTO_API_TOKEN: 'magento-secret',
      PORT: 3000,
    });

    assert.deepEqual(result, {
      LLM_API_KEY: REDACTED,
      QDRANT_API_KEY: REDACTED,
      authorization: REDACTED,
      password: REDACTED,
      MAGENTO_API_TOKEN: REDACTED,
      PORT: 3000,
    });
  });

  it('redacts nested and array-held secrets', () => {
    const result = redact({
      services: [{ name: 'llm', apiKey: 'secret' }],
      nested: { deep: { accessToken: 'secret' } },
    });

    assert.deepEqual(result, {
      services: [{ name: 'llm', apiKey: REDACTED }],
      nested: { deep: { accessToken: REDACTED } },
    });
  });

  it('leaves primitives untouched', () => {
    assert.equal(redact('plain'), 'plain');
    assert.equal(redact(42), 42);
    assert.equal(redact(null), null);
    assert.equal(redact(undefined), undefined);
  });

  it('breaks cycles instead of throwing', () => {
    /** @type {Record<string, unknown>} */
    const node = { name: 'root' };
    node.self = node;

    assert.deepEqual(redact(node), { name: 'root', self: '[circular]' });
  });

  it('truncates beyond the depth limit rather than recursing without bound', () => {
    /** @type {Record<string, unknown>} */
    let leaf = { value: 'bottom' };
    for (let index = 0; index < 12; index += 1) {
      leaf = { child: leaf };
    }

    const serialized = JSON.stringify(redact(leaf));

    assert.ok(serialized.includes('[truncated]'));
    assert.ok(!serialized.includes('bottom'));
  });

  it('recognises the credential-bearing key names it is meant to catch', () => {
    for (const key of [
      'apiKey',
      'api_key',
      'ACCESS_KEY',
      'token',
      'secret',
      'cookie',
      'sessionId',
    ]) {
      assert.equal(isSensitiveKey(key), true, `${key} should be treated as sensitive`);
    }

    for (const key of ['port', 'model', 'assistantName', 'topK']) {
      assert.equal(isSensitiveKey(key), false, `${key} should not be treated as sensitive`);
    }
  });

  it('keeps token counts readable, because they are measurements and not credentials', () => {
    // Regression: `token` matched the plural too, so every LLM cost record was
    // logged as `[redacted]`. Redaction that destroys the data it was not meant
    // to protect teaches people to distrust it.
    const result = redact({
      promptTokens: 42,
      completionTokens: 9,
      totalTokens: 51,
      maxTokens: 1024,
      MAGENTO_API_TOKEN: 'magento-secret',
      accessToken: 'secret',
    });

    assert.deepEqual(result, {
      promptTokens: 42,
      completionTokens: 9,
      totalTokens: 51,
      maxTokens: 1024,
      MAGENTO_API_TOKEN: REDACTED,
      accessToken: REDACTED,
    });
  });
});
