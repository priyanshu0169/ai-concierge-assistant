import { getRequestPath } from '../request-path.js';

const NANOSECONDS_PER_MILLISECOND = 1_000_000n;

/**
 * The routes this service has, as an **allow-list**.
 *
 * This is the single most important line in the file, and it is a list rather than `req.path` because
 * `req.path` is attacker-controlled. A metric labelled with a raw path gives anybody who can send a
 * request the ability to create unbounded series — a thousand requests to `/aaa1`…`/aaa1000` is a
 * thousand series that never expire, and the monitoring system falls over before the service does.
 *
 * `req.route` would be the tidier source, but it is only populated when a route matched, which is not
 * true for the 404s and rate-limit rejections that matter most here. So: a fixed list, and everything
 * else is `other`. An unrecognised path is a 404 by definition and does not need its own series.
 */
const ROUTES = Object.freeze([
  '/health',
  '/health/live',
  '/health/ready',
  '/health/info',
  '/metrics',
  '/v1/config',
  '/v1/chat',
  '/v1/chat/stream',
  '/v1/cart/confirm',
]);

const ROUTE_SET = new Set(ROUTES);

/**
 * Record one series per completed request.
 *
 * Deliberately a sibling of the request logger rather than folded into it. They answer different
 * questions — a log line is read when investigating one request, a metric when watching all of them —
 * and they have different retention and different failure modes. Merging them would make a change to
 * either a change to both.
 *
 * @param {{ instruments: import('../../observability/create-instruments.js').Instruments }} dependencies
 * @returns {import('express').RequestHandler}
 */
export function createMetricsMiddleware(dependencies) {
  const { instruments } = dependencies;

  return function recordMetrics(req, res, next) {
    const startedAt = process.hrtime.bigint();

    // `finish`, not `close`: `finish` fires when the response has been written, which is what a latency
    // number should measure. `close` also fires for a client that disconnected mid-stream, and counting
    // that as a served request would make an abandoned SSE stream look like a slow success. Abandonment
    // is counted where it can be told apart — see instrument-assistant.js.
    res.on('finish', () => {
      const durationMs = Number(
        (process.hrtime.bigint() - startedAt) / NANOSECONDS_PER_MILLISECOND,
      );
      const labels = { route: routeOf(req), method: req.method, status: String(res.statusCode) };

      instruments.httpRequests.add(labels);
      // Without `status`, so a slow 200 and a fast 404 do not end up in the same distribution while
      // still keeping the bucket count sane. Latency by route and method is the useful cut; latency by
      // status code multiplies the series for a question nobody asks.
      instruments.httpDuration.observe(durationMs, { route: labels.route, method: labels.method });

      if (res.statusCode === 429) instruments.rejected.add({ reason: 'rate_limited' });
      if (res.statusCode === 503) instruments.rejected.add({ reason: 'at_capacity' });
      if (res.statusCode === 401) instruments.rejected.add({ reason: 'unauthenticated' });
      if (res.statusCode === 403) instruments.rejected.add({ reason: 'forbidden' });
    });

    next();
  };
}

/**
 * @param {import('express').Request} req
 * @returns {string}
 */
function routeOf(req) {
  const path = getRequestPath(req);

  return ROUTE_SET.has(path) ? path : 'other';
}

export { ROUTES };
