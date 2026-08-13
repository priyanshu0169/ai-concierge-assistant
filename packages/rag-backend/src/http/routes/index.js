import { Router } from 'express';
import { createRateLimitMiddleware } from '../middleware/rate-limit.js';
import { createCartRouter } from './cart.routes.js';
import { createChatRouter } from './chat.routes.js';
import { createConfigRouter } from './config.routes.js';
import { createHealthRouter } from './health.routes.js';
import { createMetricsRouter } from './metrics.routes.js';
import { createMetricsMiddleware } from '../middleware/record-metrics.js';

/**
 * Compose the API surface.
 *
 * Operational endpoints live under `/health` and are unversioned - orchestrators
 * and monitoring should never have to follow a version bump. Product endpoints
 * live under `/v1` so the widget can pin an API version independently of the
 * storefront's deployment cycle.
 *
 * That split is also why authentication and rate limiting are mounted **here** rather than on
 * the app: they apply to `/v1` and not to `/health`. Throttling or refusing a readiness probe
 * would make an orchestrator pull a healthy instance out of the load balancer, turning a
 * protection into an outage.
 *
 * **Authentication runs before rate limiting**, and the order is the point. Once a request
 * carries a verified session, the limiter keys on the pseudonymous subject instead of an IP
 * address — so a shared corporate NAT stops looking like one abusive client, and an attacker
 * rotating addresses stops looking like many innocent ones. Reversing the two would throw
 * that away, and limiting an unauthenticated request is work done for a caller who was never
 * going to be served.
 *
 * @param {{
 *   healthService: import('../../health/health-service.js').HealthService,
 *   assistant: import('@shopsage/assistant-core').ConversationManager,
 *   config: import('@shopsage/platform').AppConfig,
 *   authentication: import('express').RequestHandler,
 *   cart?: {
 *     proposals: import('@shopsage/assistant-core').CartProposalStore,
 *     cart: import('@shopsage/assistant-core').CommerceCart,
 *   },
 *   metrics?: {
 *     instruments: import('../../observability/create-instruments.js').Instruments,
 *     render: () => string,
 *     token: string,
 *   },
 * }} dependencies
 * @returns {import('express').Router}
 */
export function createRouter(dependencies) {
  const { env } = dependencies.config;
  const router = Router();

  const rateLimit = (
    /** @type {((req: import('express').Request) => string) | undefined} */ keyOf,
  ) =>
    env.RATE_LIMIT_ENABLED
      ? [
          createRateLimitMiddleware({
            windowMs: env.RATE_LIMIT_WINDOW_MS,
            maxRequests: env.RATE_LIMIT_MAX_REQUESTS,
            ...(keyOf === undefined ? {} : { keyOf }),
          }),
        ]
      : [];

  // **First**, before anything that can reject a request, and that ordering is the point: a request
  // refused by the rate limiter or the authenticator is exactly the request worth counting, and
  // middleware mounted after the gate never sees it. It observes `res.on('finish')`, so it costs one
  // listener and no work on the request path.
  if (dependencies.metrics !== undefined) {
    router.use(createMetricsMiddleware({ instruments: dependencies.metrics.instruments }));
    // Outside `/v1` and outside the limiter. A scraper is not a customer: it holds an operator
    // credential, must not compete with customer traffic for a rate-limit bucket, and should not break
    // when `/v1` becomes `/v2`.
    router.use(
      createMetricsRouter({
        render: dependencies.metrics.render,
        token: dependencies.metrics.token,
      }),
    );
  }

  router.use('/health', createHealthRouter(dependencies));

  // Before authentication, and the only `/v1` route that is. The widget needs its bootstrap
  // to render at all, and it has no token until a customer opens the panel - see
  // config.routes.js for why publishing this authenticates nothing. Keyed by address here,
  // because there is no session to key on.
  router.use('/v1/config', ...rateLimit(undefined), createConfigRouter(dependencies));

  router.use('/v1', dependencies.authentication);
  // The session's subject, not the address. Present on every request past this point because
  // authentication ran first - a synthetic guest session when auth is off.
  router.use('/v1', ...rateLimit((req) => req.session.subject), createChatRouter(dependencies));

  // Mounted only when a store has a cart feature on, so the route does not exist at all otherwise -
  // the same reasoning as a withheld tool. A `404` from an unmounted route is honest ("this deployment
  // does not do that") where a `403` from a mounted one would advertise a capability nobody configured.
  //
  // Behind the same authentication and the same subject-keyed limiter as chat. It has to be: a
  // confirmation is the one request that spends money, so an unlimited one is the last thing to leave
  // open.
  if (dependencies.cart !== undefined) {
    router.use(
      '/v1',
      ...rateLimit((req) => req.session.subject),
      createCartRouter({
        proposals: dependencies.cart.proposals,
        cart: dependencies.cart.cart,
        siteId: dependencies.config.siteProfile.identity.siteId,
      }),
    );
  }

  return router;
}
