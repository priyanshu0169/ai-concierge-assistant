import { ConfigurationError } from '@shopsage/platform';

/**
 * @typedef {object} SourceRegistry
 * @property {(input: {
 *   configs: Record<string, any>[],
 *   siteId: string,
 *   logger?: import('@shopsage/platform').Logger,
 *   fetchImpl?: typeof fetch,
 * }) => import('./types.js').ContentSource[]} build
 * @property {() => string[]} knownTypes
 */

/**
 * Map source `type` values onto factories.
 *
 * Deliberately knows no type itself. The registry is handed its factories by
 * whichever entry point is composing a run, which is what keeps this package free
 * of any source implementation - and therefore free of the dependencies those
 * implementations bring. Adding a PDF source means registering a factory, not
 * editing a switch statement in the middle of the contract.
 *
 * @param {Record<string, import('./types.js').ContentSourceFactory>} factories
 * @returns {SourceRegistry}
 */
export function createSourceRegistry(factories) {
  return {
    knownTypes: () => Object.keys(factories).sort(),

    build(input) {
      const { configs, siteId, logger, fetchImpl } = input;

      return configs
        .filter((config) => config.enabled !== false)
        .map((config) => {
          const factory = factories[String(config.type)];

          if (factory === undefined) {
            // A configuration error, not a runtime one: the profile names a source
            // kind this build cannot produce, and no amount of retrying helps.
            throw new ConfigurationError(`Unknown content source type: ${config.type}`, {
              details: { sourceId: config.id, knownTypes: Object.keys(factories).sort() },
            });
          }

          return factory({ config, siteId, logger, fetchImpl });
        });
    },
  };
}
