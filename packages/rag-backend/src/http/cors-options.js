const WILDCARD = '*';

/**
 * Build CORS options from the configured origin allow-list.
 *
 * The widget runs on the Magento storefront origin and calls this API
 * cross-origin, so CORS is a functional requirement, not a formality.
 *
 * `credentials` stays false by design: the assistant session is carried in a
 * header, never a cookie, which keeps the API immune to CSRF and avoids the
 * wildcard-plus-credentials combination browsers reject outright.
 *
 * @param {string[]} allowedOrigins Exact origins, or `['*']` for any.
 * @returns {import('cors').CorsOptions}
 */
export function buildCorsOptions(allowedOrigins) {
  const allowAny = allowedOrigins.includes(WILDCARD);

  return {
    origin: allowAny ? true : allowedOrigins,
    credentials: false,
    methods: ['GET', 'POST', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'X-Request-Id', 'X-Site-Id'],
    exposedHeaders: ['X-Request-Id'],
    maxAge: 86_400,
  };
}
