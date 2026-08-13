import { ConfigurationError, createMetricsRegistry } from '@shopsage/platform';
import { createInstruments } from '../observability/create-instruments.js';

/**
 * Build the metrics registry, or decline to.
 *
 * Two decisions live here and both are about failing loudly.
 *
 * **Metrics on with no token is a boot failure**, not an open endpoint. Serving it open would publish
 * token spend, traffic volume and which dependencies are down to anybody who asked — and it would do so
 * silently, which is the worst combination. The same rule as `CONVERSATION_STORE` and the commerce
 * connector: where a wrong guess is invisible, refuse to guess (docs/adr/0024, docs/adr/0028).
 *
 * **Absent means absent.** When metrics are off there is no registry, no middleware and no route, rather
 * than a registry nobody reads. A disabled feature that still does its work is a feature you find out
 * about from a profiler.
 *
 * @param {Readonly<import('@shopsage/platform').AppConfig>} config
 * @param {import('@shopsage/platform').Logger} logger
 * @returns {{
 *   instruments: import('../observability/create-instruments.js').Instruments,
 *   render: () => string,
 *   token: string,
 * } | undefined}
 */
export function buildMetrics(config, logger) {
  if (!config.env.METRICS_ENABLED) return undefined;

  const token = config.env.METRICS_TOKEN;

  if (token === undefined) {
    throw new ConfigurationError('METRICS_TOKEN is required when METRICS_ENABLED is true', {
      details: {
        variable: 'METRICS_TOKEN',
        remediation:
          'set METRICS_TOKEN to a long random value, or set METRICS_ENABLED=false; the endpoint publishes spend and traffic volume and is never served unguarded',
      },
    });
  }

  const registry = createMetricsRegistry({
    // On every series, so a single Prometheus can scrape several stores' deployments and still tell them
    // apart. `siteId` is one value per process, which is the only reason a label this useful is also
    // safe - and it will need revisiting on the day multi-store hosting arrives.
    constantLabels: { site: config.siteProfile.identity.siteId },
  });

  logger.info('metrics endpoint configured', {
    path: '/metrics',
    // Whether, never what. And named to avoid every word in the logger's redaction pattern, which is a
    // longer list than it looks - see the note in build-application.js.
    guarded: true,
  });

  return {
    instruments: createInstruments(registry),
    render: registry.render,
    token,
  };
}
