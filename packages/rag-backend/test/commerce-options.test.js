import assert from 'node:assert/strict';
import { ConfigurationError } from '@shopsage/platform';
import { describe, it } from 'node:test';
import {
  commerceFeaturesEnabled,
  toCommerceClientOptions,
} from '../src/composition/commerce-options.js';
import { buildTestConfig } from './helpers/test-doubles.js';

/**
 * @param {Record<string, string | undefined>} env
 * @param {Record<string, boolean>} features
 */
function configFor(env, features) {
  return buildTestConfig({ env, features });
}

describe('deciding whether a commerce connector is needed', () => {
  it('names the enabled features that require one', () => {
    const config = configFor({}, { productSearch: true, orderTracking: true });

    assert.deepEqual(commerceFeaturesEnabled(config.siteProfile).sort(), [
      'orderTracking',
      'productSearch',
    ]);
  });

  it('needs none for a knowledge-only store', () => {
    const config = configFor({}, { productSearch: false });

    assert.deepEqual(commerceFeaturesEnabled(config.siteProfile), []);
    assert.equal(toCommerceClientOptions(config), undefined);
  });

  it('counts the Stage 9b cart features too, so the gap is caught at boot', () => {
    // `cart` and `coupons` have no tools yet. Requiring the connector for them now means a store
    // enabling them cannot boot into a state where the flag is on and nothing can serve it.
    const config = configFor({}, { productSearch: false, cart: true });

    assert.deepEqual(commerceFeaturesEnabled(config.siteProfile), ['cart']);
  });
});

describe('refusing to boot a commerce store with no connector', () => {
  it('fails at boot rather than one customer at a time', () => {
    // This is the price of degrading connector failures into conversational answers: a missing URL
    // would otherwise look like a model that had gone vague, quietly, for every commerce question.
    // Boot is the only place left where the mistake cannot be missed.
    const config = configFor({ MAGENTO_API_URL: undefined }, { productSearch: true });

    assert.throws(
      () => toCommerceClientOptions(config),
      (error) => {
        assert.ok(error instanceof ConfigurationError);
        assert.match(error.message, /MAGENTO_API_URL is required/u);

        return true;
      },
    );
  });

  it('names the offending features and both ways out', () => {
    const config = configFor({}, { productSearch: true, recommendations: true });

    assert.throws(
      () => toCommerceClientOptions(config),
      (/** @type {any} */ error) => {
        assert.deepEqual(error.details.features.sort(), ['productSearch', 'recommendations']);
        // Turning the feature off is a legitimate resolution, so the message says so.
        assert.match(error.details.remediation, /or turn these features off/u);

        return true;
      },
    );
  });
});

describe('where the connector address comes from', () => {
  it('lets the site profile win over the environment', () => {
    // A connector address is store-identifying, non-secret data, so it belongs with the store in
    // multi-store hosting. The environment variable is the single-store convenience.
    const config = buildTestConfig({
      env: { MAGENTO_API_URL: 'https://from-env.example.com' },
      integrations: { magentoApiUrl: 'https://from-profile.example.com' },
    });

    assert.equal(toCommerceClientOptions(config)?.baseUrl, 'https://from-profile.example.com');
  });

  it('falls back to the environment when the profile is silent', () => {
    const config = configFor({ MAGENTO_API_URL: 'https://from-env.example.com' }, {});

    assert.equal(toCommerceClientOptions(config)?.baseUrl, 'https://from-env.example.com');
  });

  it('names both places when neither is set', () => {
    const config = configFor({ MAGENTO_API_URL: undefined }, { productSearch: true });

    assert.throws(
      () => toCommerceClientOptions(config),
      (/** @type {any} */ error) => {
        assert.match(error.details.remediation, /integrations\.magentoApiUrl/u);

        return true;
      },
    );
  });
});

describe('mapping the environment onto the client', () => {
  it('carries the timeouts and attempt count through', () => {
    const config = configFor(
      {
        MAGENTO_API_URL: 'https://store.example.com',
        MAGENTO_TIMEOUT_MS: '2500',
        MAGENTO_MAX_ATTEMPTS: '3',
      },
      { productSearch: true },
    );

    assert.deepEqual(toCommerceClientOptions(config), {
      baseUrl: 'https://store.example.com',
      timeoutMs: 2500,
      maxAttempts: 3,
    });
  });

  it('omits the service token when there is none, rather than sending an empty one', () => {
    const config = configFor({ MAGENTO_API_URL: 'https://store.example.com' }, {});

    assert.equal('serviceToken' in /** @type {object} */ (toCommerceClientOptions(config)), false);
  });

  it('passes the service token when configured', () => {
    const config = configFor(
      { MAGENTO_API_URL: 'https://store.example.com', MAGENTO_API_TOKEN: 'svc-token' },
      {},
    );

    assert.equal(toCommerceClientOptions(config)?.serviceToken, 'svc-token');
  });

  it('builds a client for a connector even with no commerce feature on', () => {
    // A URL set with every feature off is not an error - an operator may be preparing a rollout.
    // The tools stay absent regardless, so nothing can reach it.
    const config = configFor(
      { MAGENTO_API_URL: 'https://store.example.com' },
      { productSearch: false },
    );

    assert.deepEqual(commerceFeaturesEnabled(config.siteProfile), []);
    assert.ok(toCommerceClientOptions(config));
  });
});
