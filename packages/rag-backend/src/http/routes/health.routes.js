import { Router } from 'express';

/**
 * @param {{
 *   healthService: import('../../health/health-service.js').HealthService,
 *   config: import('@shopsage/platform').AppConfig,
 * }} dependencies
 * @returns {import('express').Router}
 */
export function createHealthRouter(dependencies) {
  const { healthService, config } = dependencies;
  const router = Router();

  // Health responses describe a single instant; caching them would make an
  // orchestrator act on stale state.
  router.use((_req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    next();
  });

  /** Liveness. Always 200 while the process can serve requests. */
  router.get('/', (_req, res) => {
    res.json(healthService.liveness());
  });

  /** Readiness. 503 when any dependency is unavailable. */
  router.get('/ready', async (_req, res) => {
    const report = await healthService.readiness();
    res.status(report.status === 'ok' ? 200 : 503).json(report);
  });

  /**
   * Effective configuration summary.
   *
   * Exists to make the configuration-driven design verifiable at runtime: it
   * proves which site profile the instance actually loaded. Only non-secret,
   * customer-visible values are ever included.
   */
  router.get('/info', (_req, res) => {
    res.json(buildInfoReport(config));
  });

  return router;
}

/**
 * @param {import('@shopsage/platform').AppConfig} config
 * @returns {Record<string, unknown>}
 */
function buildInfoReport(config) {
  const { siteProfile, env } = config;

  return {
    service: env.SERVICE_NAME,
    environment: env.NODE_ENV,
    site: {
      siteId: siteProfile.identity.siteId,
      companyName: siteProfile.identity.companyName,
      assistantName: siteProfile.identity.assistantName,
    },
    localization: siteProfile.localization,
    enabledFeatures: Object.entries(siteProfile.features)
      .filter(([, enabled]) => enabled)
      .map(([feature]) => feature),
  };
}
