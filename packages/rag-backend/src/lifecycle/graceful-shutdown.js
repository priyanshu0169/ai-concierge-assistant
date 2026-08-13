/**
 * @typedef {object} GracefulShutdownOptions
 * @property {import('node:http').Server} server
 * @property {import('@shopsage/platform').Logger} logger
 * @property {number} [timeoutMs] Budget for in-flight requests. Default 10000ms.
 * @property {(() => Promise<void> | void)[]} [onShutdown] Resource teardown hooks.
 * @property {NodeJS.Process} [processRef] Injection seam for tests.
 */

/**
 * Install signal and fatal-error handlers.
 *
 * Two guarantees matter here. First, in-flight requests get a bounded window to
 * finish, so a deploy does not hang up on customers mid-answer. Second, the
 * process really does exit when the window closes - a container that ignores
 * SIGTERM gets SIGKILLed by the orchestrator and looks like a crash in every
 * dashboard.
 *
 * Unhandled rejections and uncaught exceptions are treated as fatal rather
 * than logged and ignored: after either one the process is in unknown state,
 * and serving customers from unknown state is worse than restarting.
 *
 * @param {GracefulShutdownOptions} options
 * @returns {(reason: string, exitCode?: number) => Promise<void>} The shutdown routine.
 */
export function registerGracefulShutdown(options) {
  const { server, logger, timeoutMs = 10_000, onShutdown = [], processRef = process } = options;

  let shuttingDown = false;

  /**
   * @param {string} reason
   * @param {number} [exitCode]
   * @returns {Promise<void>}
   */
  async function shutdown(reason, exitCode = 0) {
    if (shuttingDown) return;
    shuttingDown = true;

    logger.info('shutdown started', { reason, timeoutMs });

    const forceExit = setTimeout(() => {
      logger.error('shutdown timed out, forcing exit', { reason, timeoutMs });
      processRef.exit(1);
    }, timeoutMs);
    forceExit.unref?.();

    try {
      await closeServer(server);
      await runHooks(onShutdown, logger);
      logger.info('shutdown complete', { reason });
    } catch (error) {
      logger.error('shutdown failed', { reason, err: error });
      clearTimeout(forceExit);
      processRef.exit(1);
      return;
    }

    clearTimeout(forceExit);
    processRef.exit(exitCode);
  }

  processRef.on('SIGTERM', () => void shutdown('SIGTERM'));
  processRef.on('SIGINT', () => void shutdown('SIGINT'));

  processRef.on('uncaughtException', (error) => {
    logger.fatal('uncaught exception', { err: error });
    void shutdown('uncaughtException', 1);
  });

  processRef.on('unhandledRejection', (reason) => {
    logger.fatal('unhandled rejection', { err: reason });
    void shutdown('unhandledRejection', 1);
  });

  return shutdown;
}

/**
 * @param {import('node:http').Server} server
 * @returns {Promise<void>}
 */
function closeServer(server) {
  return new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

/**
 * @param {(() => Promise<void> | void)[]} hooks
 * @param {import('@shopsage/platform').Logger} logger
 * @returns {Promise<void>}
 */
async function runHooks(hooks, logger) {
  for (const hook of hooks) {
    try {
      await hook();
    } catch (error) {
      // One failing teardown hook must not prevent the others from running.
      logger.error('shutdown hook failed', { err: error });
    }
  }
}
