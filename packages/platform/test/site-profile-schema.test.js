import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ConfigurationError } from '../src/errors/errors.js';
import { parseSiteProfile } from '../src/config/site-profile-schema.js';

/**
 * The smallest profile a store must author. Everything omitted here has a
 * defensible default, which is what keeps onboarding a new store cheap.
 */
function minimalProfile() {
  return {
    identity: {
      siteId: 'test-store',
      companyName: 'Test Store',
      assistantName: 'Helper',
    },
    prompts: {
      systemPrompt: 'You are a helpful shopping assistant for this store.',
      welcomeMessage: 'Hello there.',
      fallbackMessage: 'Something went wrong.',
      noAnswerMessage: 'I could not find that.',
    },
    integrations: {
      backendUrl: 'https://assistant.example.com',
    },
  };
}

describe('parseSiteProfile', () => {
  it('fills in every optional section with defaults', () => {
    const profile = parseSiteProfile(minimalProfile());

    assert.equal(profile.localization.locale, 'en-US');
    assert.equal(profile.localization.currency, 'USD');
    assert.equal(profile.branding.position, 'bottom-right');
    assert.equal(profile.retrieval.topK, 6);
    assert.equal(profile.conversation.maxHistoryMessages, 12);
    assert.deepEqual(profile.prompts.quickReplies, []);
  });

  describe('conversation memory', () => {
    /** @param {Record<string, unknown>} conversation */
    const memoryOf = (conversation) =>
      parseSiteProfile({ ...minimalProfile(), conversation }).conversation;

    it('falls back to maxHistoryMessages for both, so an older profile is unchanged', () => {
      // Backwards compatibility is the point: a profile written before retention and prompt size
      // were separated must keep meaning exactly what it meant.
      const memory = memoryOf({ maxHistoryMessages: 12 });

      assert.equal(memory.maxStoredMessages, 12);
      assert.equal(memory.maxPromptMessages, 12);
    });

    it('defaults both to 12 when the section is absent entirely', () => {
      const memory = memoryOf({});

      assert.equal(memory.maxStoredMessages, 12);
      assert.equal(memory.maxPromptMessages, 12);
    });

    it('keeps retention and prompt size independent when both are given', () => {
      // The reason for the split: storage is ~310 bytes a message and its trim is permanent,
      // while prompt size costs tokens on every call. They tune against different things.
      const memory = memoryOf({ maxStoredMessages: 100, maxPromptMessages: 50 });

      assert.equal(memory.maxStoredMessages, 100);
      assert.equal(memory.maxPromptMessages, 50);
    });

    it('lets retention exceed the old 50 ceiling, which the prompt limit kept', () => {
      assert.equal(memoryOf({ maxStoredMessages: 400 }).maxStoredMessages, 400);
    });

    it('clamps the prompt limit to what is actually stored', () => {
      // Replaying more than Redis holds is not a boot failure, it just silently caps - so the
      // effective number is reported honestly rather than the aspirational one.
      const memory = memoryOf({ maxStoredMessages: 20, maxPromptMessages: 50 });

      assert.equal(memory.maxPromptMessages, 20);
    });

    it('rejects a value outside its own bounds', () => {
      assert.throws(() => memoryOf({ maxStoredMessages: 5000 }), ConfigurationError);
      assert.throws(() => memoryOf({ maxPromptMessages: 1 }), ConfigurationError);
    });
  });

  it('defaults every commerce capability to off', () => {
    const { features } = parseSiteProfile(minimalProfile());

    assert.equal(features.knowledgeSearch, true);
    assert.equal(features.streaming, true);
    assert.equal(features.productSearch, false);
    assert.equal(features.cart, false);
    assert.equal(features.orderTracking, false);
    assert.equal(features.winePairings, false);
  });

  it('normalises the currency code', () => {
    const profile = parseSiteProfile({
      ...minimalProfile(),
      localization: { currency: 'gbp' },
    });

    assert.equal(profile.localization.currency, 'GBP');
  });

  it('rejects a profile missing a required section', () => {
    const { prompts: _prompts, ...withoutPrompts } = minimalProfile();

    assert.throws(() => parseSiteProfile(withoutPrompts), ConfigurationError);
  });

  it('rejects unknown keys so a typo fails loudly instead of silently defaulting', () => {
    const profile = { ...minimalProfile(), retrieval: { topk: 10 } };

    assert.throws(() => parseSiteProfile(profile), ConfigurationError);
  });

  it('rejects an invalid site id', () => {
    const profile = minimalProfile();
    profile.identity = { ...minimalProfile().identity, siteId: 'Not A Slug' };

    assert.throws(() => parseSiteProfile(profile), ConfigurationError);
  });

  it('rejects a non-hex brand colour', () => {
    const profile = { ...minimalProfile(), branding: { primaryColor: 'rebeccapurple' } };

    assert.throws(() => parseSiteProfile(profile), ConfigurationError);
  });

  it('rejects a retrieval score outside the similarity range', () => {
    const profile = { ...minimalProfile(), retrieval: { minScore: 1.5 } };

    assert.throws(() => parseSiteProfile(profile), ConfigurationError);
  });

  it('names the offending path and source file in the error', () => {
    try {
      parseSiteProfile({ ...minimalProfile(), retrieval: { topK: 0 } }, '/etc/shopsage/site.json');
      assert.fail('expected a ConfigurationError');
    } catch (error) {
      assert.ok(error instanceof ConfigurationError);
      assert.equal(error.details?.sourcePath, '/etc/shopsage/site.json');
      const issues = /** @type {{ path: string }[]} */ (error.details?.issues);
      assert.equal(issues[0].path, 'retrieval.topK');
    }
  });
});
