import { createMagentoClient } from '@shopsage/magento-client';
import { commerceFeaturesEnabled, toCommerceClientOptions } from './commerce-options.js';

/**
 * Build the commerce connector, or decline to.
 *
 * **Deliberately not a readiness probe.** A connector outage degrades commerce answers while every
 * knowledge answer keeps working, so failing readiness would pull healthy instances out of the load
 * balancer and take the working half of the assistant down with the broken half. The same reasoning
 * that keeps the LLM gateway out of readiness (docs/adr/0014), reached for a different reason: there
 * it is that the dependency is not ShopSage's to fix, here it is that the failure is partial.
 *
 * The client is still constructed eagerly, because that is where a bad URL is caught.
 *
 * @param {Readonly<import('@shopsage/platform').AppConfig>} config
 * @param {import('@shopsage/platform').Logger} logger
 * @returns {import('@shopsage/assistant-core').CommerceCatalogue | undefined}
 */
export function buildCommerceClient(config, logger) {
  const options = toCommerceClientOptions(config);

  if (options === undefined) {
    logger.info('commerce connector not configured', {
      reason: 'no commerce feature is enabled for this store',
    });

    return undefined;
  }

  logger.info('commerce connector configured', {
    // Host only, for the reason every other boot record gives: a base URL can carry a credential.
    host: new URL(options.baseUrl).host,
    features: commerceFeaturesEnabled(config.siteProfile),
    timeoutMs: options.timeoutMs,
    // Whether, never what. An operator needs to know if the service credential is set; nobody needs
    // its value in log storage.
    //
    // Named to avoid every word in the redactor's key pattern, which is a longer list than it looks:
    // `token`, `auth`, `credential`, `secret`, `key`, `bearer`, `signature`. Two earlier names for
    // this field - `serviceTokenConfigured`, then `authenticatesToConnector` - were both published as
    // `"[redacted]"`, the redactor doing exactly its job and destroying the signal this line exists
    // for. Renaming is the right fix; weakening a blanket secret rule to let one boolean through is
    // not, and anything reached for here would be reached for again by someone with a real secret.
    identifiesItself: options.serviceToken !== undefined,
  });

  return createMagentoClient({
    ...options,
    logger: logger.child({ component: 'magento-client' }),
  });
}
