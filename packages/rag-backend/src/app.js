import cors from 'cors';
import express from 'express';
import { buildCorsOptions } from './http/cors-options.js';
import { createErrorHandlerMiddleware } from './http/middleware/error-handler.js';
import { handleNotFound } from './http/middleware/not-found.js';
import { createRequestIdMiddleware } from './http/middleware/request-id.js';
import { createRequestLoggerMiddleware } from './http/middleware/request-logger.js';
import { createRouter } from './http/routes/index.js';

/**
 * Chat payloads are text. A small ceiling is the cheapest defence against
 * memory-exhaustion attempts on a public endpoint.
 */
const JSON_BODY_LIMIT = '64kb';

/**
 * @typedef {object} AppDependencies
 * @property {import('@shopsage/platform').AppConfig} config
 * @property {import('@shopsage/platform').Logger} logger
 * @property {import('./health/health-service.js').HealthService} healthService
 * @property {import('@shopsage/assistant-core').ConversationManager} assistant
 * @property {{
 *   instruments: import('./observability/create-instruments.js').Instruments,
 *   render: () => string,
 *   token: string,
 * }} [metrics] Absent unless METRICS_ENABLED; the endpoint and middleware are then absent too.
 * @property {{
 *   proposals: import('@shopsage/assistant-core').CartProposalStore,
 *   cart: import('@shopsage/assistant-core').CommerceCart,
 * }} [cart] Absent unless a cart feature is enabled; the routes are then not mounted.
 * @property {import('express').RequestHandler} authentication Applied to `/v1` only.
 */

/**
 * Build the Express application.
 *
 * Returns an app and never calls `listen`, so tests can drive it without
 * binding a well-known port and the process lifecycle stays in `server.js`.
 * Every dependency arrives as an argument: this module constructs nothing, so
 * there is no hidden global to reset between tests.
 *
 * @param {AppDependencies} dependencies
 * @returns {import('express').Express}
 */
export function createApp(dependencies) {
  const { config, logger, healthService, assistant, authentication, cart, metrics } = dependencies;

  const app = express();

  app.disable('x-powered-by');
  app.set('trust proxy', config.env.TRUST_PROXY);

  // Correlation first: everything after this point, including rejections, is
  // attributable to a request id.
  app.use(createRequestIdMiddleware({ logger }));
  app.use(createRequestLoggerMiddleware());
  app.use(cors(buildCorsOptions(config.env.CORS_ALLOWED_ORIGINS)));
  app.use(express.json({ limit: JSON_BODY_LIMIT }));

  app.use(
    createRouter({
      healthService,
      assistant,
      config,
      authentication,
      ...(cart === undefined ? {} : { cart }),
      ...(metrics === undefined ? {} : { metrics }),
    }),
  );

  app.use(handleNotFound);
  app.use(createErrorHandlerMiddleware({ includeStack: config.env.NODE_ENV !== 'production' }));

  return app;
}
