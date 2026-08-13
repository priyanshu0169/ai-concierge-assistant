import { serializeError } from '@shopsage/platform';
import { buildApplication } from './composition/build-application.js';
import { registerGracefulShutdown } from './lifecycle/graceful-shutdown.js';

/**
 * Process entry point. Owns exactly three things: bind the port, tune socket
 * timeouts, install shutdown handlers. All wiring lives in the composition
 * root; all behaviour lives further in.
 *
 * @returns {Promise<void>}
 */
async function main() {
  const { app, config, logger, onShutdown } = await buildApplication();
  const { PORT, REQUEST_TIMEOUT_MS, SHUTDOWN_TIMEOUT_MS } = config.env;

  const server = app.listen(PORT, () => {
    logger.info('backend listening', {
      port: PORT,
      assistantName: config.siteProfile.identity.assistantName,
      siteProfilePath: config.siteProfilePath,
    });
  });

  // Bound how long a client may take to send a request. Without this a slow
  // sender can hold a connection open indefinitely.
  server.requestTimeout = REQUEST_TIMEOUT_MS;
  server.headersTimeout = Math.min(REQUEST_TIMEOUT_MS, 60_000);

  // Hooks run after the HTTP server has stopped accepting connections and in-flight
  // requests have drained, so a store connection is closed only once nothing needs it.
  registerGracefulShutdown({ server, logger, timeoutMs: SHUTDOWN_TIMEOUT_MS, onShutdown });
}

main().catch((error) => {
  // The logger may not exist yet - configuration failure is the most likely
  // reason to be here - so report on stderr in the same JSON shape and exit
  // non-zero so the orchestrator does not route traffic to a broken instance.
  process.stderr.write(
    `${JSON.stringify({
      time: new Date().toISOString(),
      level: 'fatal',
      name: 'shopsage-backend',
      msg: 'bootstrap failed',
      err: serializeError(error),
    })}\n`,
  );
  process.exit(1);
});
