/**
 * @typedef {object} ProbeResult
 * @property {string} name
 * @property {'up' | 'down'} status
 * @property {number} latencyMs
 * @property {string} [error] Present only when `status` is `down`.
 */

/**
 * @typedef {object} DependencyProbe
 * @property {string} name
 * @property {() => Promise<ProbeResult>} check
 */

/**
 * Turn a client's own health method into a readiness probe.
 *
 * Stage 1 probed dependencies with generic HTTP GETs, which meant the backend had
 * to know each dependency's address and which path happened to be its health
 * endpoint. That is knowledge the client already has, and duplicating it meant
 * the probe could pass while the client was misconfigured - a readiness check
 * that proves a URL is reachable rather than that the dependency is *usable*.
 *
 * Now each client answers for itself: the vector store checks shard readiness,
 * and the embeddings service additionally verifies that it is serving the model
 * this deployment was configured for. Neither of those is expressible as a URL.
 *
 * A probe never throws. An unreachable dependency is a *result*, because
 * readiness has to report on all of them even when several are down.
 *
 * @param {{ name: string, check: () => Promise<unknown> }} dependency
 * @returns {DependencyProbe}
 */
export function createClientProbe(dependency) {
  const { name, check } = dependency;

  return {
    name,
    async check() {
      const startedAt = performance.now();

      try {
        await check();

        return { name, status: 'up', latencyMs: elapsedMs(startedAt) };
      } catch (error) {
        return {
          name,
          status: 'down',
          latencyMs: elapsedMs(startedAt),
          error: describe(error),
        };
      }
    },
  };
}

/**
 * Surface the reason, and the remediation when the client offered one - an
 * operator reading `/health/ready` should not have to go digging in the logs to
 * find out that `EMBEDDING_MODEL` disagrees with the running service.
 *
 * @param {unknown} error
 * @returns {string}
 */
function describe(error) {
  if (!(error instanceof Error)) return 'unknown failure';

  const remediation = /** @type {{ details?: { remediation?: unknown } }} */ (error).details
    ?.remediation;

  return typeof remediation === 'string' ? `${error.message} (${remediation})` : error.message;
}

/**
 * @param {number} startedAt
 * @returns {number}
 */
function elapsedMs(startedAt) {
  return Math.round(performance.now() - startedAt);
}
