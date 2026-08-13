import assert from 'node:assert/strict';
import { ConfigurationError } from '@shopsage/platform';
import { describe, it } from 'node:test';
import {
  resolveConversationStore,
  toRedisStoreOptions,
} from '../src/composition/conversation-store-options.js';
import { buildTestConfig } from './helpers/test-doubles.js';

/** @param {Record<string, string | undefined>} env */
const envFor = (env) => buildTestConfig({ env }).env;

describe('resolveConversationStore', () => {
  it('honours an explicit choice', () => {
    assert.equal(resolveConversationStore(envFor({ CONVERSATION_STORE: 'redis' })), 'redis');
    assert.equal(resolveConversationStore(envFor({ CONVERSATION_STORE: 'memory' })), 'memory');
  });

  it('defaults to memory outside production, so a developer needs no Redis', () => {
    assert.equal(resolveConversationStore(envFor({ NODE_ENV: 'development' })), 'memory');
  });

  it('refuses to guess in production', () => {
    // `memory` is correct at one replica and silently wrong at two — some requests
    // remember the conversation and some do not, which reads as a flaky assistant rather
    // than a misconfiguration. Only an operator knows the replica count.
    assert.throws(
      () => resolveConversationStore(envFor({ NODE_ENV: 'production' })),
      (error) => {
        assert.ok(error instanceof ConfigurationError);
        assert.deepEqual(error.details?.missing, ['CONVERSATION_STORE']);
        return true;
      },
    );
  });

  it('still allows memory in production, because one replica is a real deployment', () => {
    assert.equal(
      resolveConversationStore(envFor({ NODE_ENV: 'production', CONVERSATION_STORE: 'memory' })),
      'memory',
    );
  });

  it('rejects a store nobody implements, at boot', () => {
    assert.throws(() => envFor({ CONVERSATION_STORE: 'postgres' }), ConfigurationError);
  });
});

describe('toRedisStoreOptions', () => {
  /** @param {Record<string, string | undefined>} env */
  const configFor = (env) => buildTestConfig({ env });

  it('takes the address from the environment', () => {
    const options = toRedisStoreOptions(configFor({ REDIS_URL: 'redis://cache:6379' }));

    assert.equal(options.url, 'redis://cache:6379');
  });

  it('takes the conversation lifetime from the site profile', () => {
    // A store's idle timeout is a product decision that differs per store, and
    // `sessionIdleTimeoutMinutes` has been in the profile since Stage 1 doing nothing.
    // A sliding TTL is precisely what an idle timeout means.
    const options = toRedisStoreOptions(configFor({ REDIS_URL: 'redis://cache:6379' }));

    assert.equal(options.ttlSeconds, 60 * 60);
  });

  it('takes the retention limit, not the prompt limit', () => {
    // These were one number until a live conversation forgot a name it had recalled ten turns
    // earlier: the prompt budget was driving Redis's `lTrim`, so anything the model did not need
    // replayed was permanently deleted. Storage is the cheap side (~310 bytes a message) and its
    // discard is irreversible, so it must be able to exceed the prompt limit.
    const options = toRedisStoreOptions(
      buildTestConfig({
        env: { REDIS_URL: 'redis://cache:6379' },
        conversation: { maxStoredMessages: 100, maxPromptMessages: 50 },
      }),
    );

    assert.equal(options.maxStoredMessages, 100);
  });

  it('falls back to the legacy single setting, so an older profile is unaffected', () => {
    const options = toRedisStoreOptions(configFor({ REDIS_URL: 'redis://cache:6379' }));

    assert.equal(options.maxStoredMessages, 12);
  });

  it('fails at boot when the address is missing, naming it', () => {
    assert.throws(
      () => toRedisStoreOptions(configFor({ CONVERSATION_STORE: 'redis' })),
      (error) => {
        assert.ok(error instanceof ConfigurationError);
        assert.deepEqual(error.details?.missing, ['REDIS_URL']);
        assert.match(String(error.details?.remediation), /redis:\/\//u);
        return true;
      },
    );
  });

  it('rejects an address that is not a redis URL', () => {
    // A `http://` value here is a copy-paste from another variable, and it would surface
    // as a confusing connection error much later.
    assert.throws(() => envFor({ REDIS_URL: 'http://cache:6379' }), ConfigurationError);
  });

  it('accepts a TLS redis URL', () => {
    assert.equal(envFor({ REDIS_URL: 'rediss://cache:6380' }).REDIS_URL, 'rediss://cache:6380');
  });
});
