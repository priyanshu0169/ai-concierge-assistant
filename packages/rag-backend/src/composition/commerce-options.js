import { ConfigurationError } from '@shopsage/platform';

/**
 * Which site-profile features need a commerce connector to work at all.
 *
 * Listed explicitly rather than derived, so adding a flag cannot silently make the connector
 * mandatory for stores that never asked for it. `cart` and `coupons` are here for Stage 9b: they
 * are already refusable at boot, which is better than discovering the gap when a customer tries.
 */
const COMMERCE_FEATURES = Object.freeze([
  'productSearch',
  'productComparison',
  'recommendations',
  'orderTracking',
  'cart',
  'coupons',
]);

/**
 * Which features need the **write** side of the connector, and therefore a proposal store.
 *
 * A shorter list than the one above, and kept separate because the two answer different questions.
 * "Does this store read from a connector?" decides whether a client is built; "can this store change a
 * basket?" decides whether the confirmation route exists at all.
 */
const CART_FEATURES = Object.freeze(['cart', 'coupons']);

/**
 * @param {import('@shopsage/platform').SiteProfile} siteProfile
 * @returns {string[]}
 */
export function cartFeaturesEnabled(siteProfile) {
  return CART_FEATURES.filter(
    (feature) => siteProfile.features[/** @type {keyof typeof siteProfile.features} */ (feature)],
  );
}

/**
 * Whether this deployment needs a commerce connector.
 *
 * @param {import('@shopsage/platform').SiteProfile} siteProfile
 * @returns {string[]} The enabled features that require one.
 */
export function commerceFeaturesEnabled(siteProfile) {
  return COMMERCE_FEATURES.filter(
    (feature) => siteProfile.features[/** @type {keyof typeof siteProfile.features} */ (feature)],
  );
}

/**
 * Map the environment onto the commerce client's options.
 *
 * The same seam as `llm-options.js` and `retrieval-options.js`: the client takes plain options and
 * knows nothing about ShopSage's environment schema.
 *
 * The interesting part is the failure it raises. A commerce flag on with no `MAGENTO_API_URL` is a
 * deployment that will accept a question about prices and then be unable to answer it - and, because
 * a connector failure is deliberately degraded into "I could not look that up", it would do so
 * *quietly*, one customer at a time, looking like a model that had gone vague. So it is a boot
 * failure with the flag named in the message. This is the trade-off of degrading failures rather
 * than erroring: the misconfiguration has to be caught somewhere it cannot be missed, and boot is
 * the only such place left.
 *
 * @param {Readonly<import('@shopsage/platform').AppConfig>} config
 * @returns {import('@shopsage/magento-client').MagentoClientOptions | undefined}
 */
export function toCommerceClientOptions(config) {
  const required = commerceFeaturesEnabled(config.siteProfile);
  const { MAGENTO_API_TOKEN: serviceToken } = config.env;
  // The site profile wins, the environment is the fallback - the precedence documented in
  // docs/Configuration.md. The reasoning is about *what kind of data* each holds: a connector
  // address is store-identifying and not secret, so it belongs with the store in multi-store
  // hosting, while the environment variable is a convenience for a single-store deployment. The
  // service credential is a secret and lives only in the environment, which is why it is not
  // overridable here.
  const baseUrl = config.siteProfile.integrations.magentoApiUrl ?? config.env.MAGENTO_API_URL;

  if (baseUrl === undefined) {
    if (required.length === 0) return undefined;

    throw new ConfigurationError('MAGENTO_API_URL is required by the enabled commerce features', {
      details: {
        variable: 'MAGENTO_API_URL',
        features: required,
        remediation:
          'set MAGENTO_API_URL, or integrations.magentoApiUrl in the site profile, or turn these features off',
      },
    });
  }

  return {
    baseUrl,
    timeoutMs: config.env.MAGENTO_TIMEOUT_MS,
    maxAttempts: config.env.MAGENTO_MAX_ATTEMPTS,
    ...(serviceToken === undefined ? {} : { serviceToken }),
  };
}
