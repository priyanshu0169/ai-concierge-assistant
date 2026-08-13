/**
 * @typedef {object} LivenessReport
 * @property {'ok'} status
 * @property {string} service
 * @property {string} version
 * @property {number} uptimeSeconds
 */

/**
 * @typedef {object} ReadinessReport
 * @property {'ok' | 'degraded'} status
 * @property {string} service
 * @property {import('./dependency-probe.js').ProbeResult[]} checks
 */

/**
 * @typedef {object} HealthServiceOptions
 * @property {string} serviceName
 * @property {string} version
 * @property {import('./dependency-probe.js').DependencyProbe[]} [probes]
 * @property {() => number} [clock] Injectable millisecond clock, for tests.
 */

/**
 * @typedef {object} HealthService
 * @property {() => LivenessReport} liveness
 * @property {() => Promise<ReadinessReport>} readiness
 */

/**
 * Liveness and readiness reporting.
 *
 * The two are deliberately different in kind:
 *
 * - **Liveness** answers "is this process healthy?" and never touches a
 *   dependency. If it did, a Qdrant outage would fail the liveness probe, the
 *   orchestrator would restart a perfectly healthy container, and a dependency
 *   outage would escalate into a crash loop.
 * - **Readiness** answers "should this instance receive traffic?" and does
 *   check dependencies, reporting each one individually.
 *
 * @param {HealthServiceOptions} options
 * @returns {HealthService}
 */
export function createHealthService(options) {
  const { serviceName, version, probes = [], clock = () => Date.now() } = options;
  const startedAt = clock();

  return {
    liveness() {
      return {
        status: 'ok',
        service: serviceName,
        version,
        uptimeSeconds: Math.round((clock() - startedAt) / 1000),
      };
    },

    async readiness() {
      const checks = await Promise.all(probes.map((probe) => probe.check()));
      const allUp = checks.every((check) => check.status === 'up');

      return { status: allUp ? 'ok' : 'degraded', service: serviceName, checks };
    },
  };
}
