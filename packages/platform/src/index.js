/**
 * @shopsage/platform - cross-cutting primitives.
 *
 * This package is the only permitted "shared utilities" location in the
 * monorepo. It must never gain knowledge of commerce, retrieval, HTTP routing
 * or LLM providers; anything domain-aware belongs in the package that owns
 * that domain. See docs/adr/0009.
 */

export { AppError } from './errors/app-error.js';
export { ERROR_CODES } from './errors/error-codes.js';
export {
  ConfigurationError,
  ForbiddenError,
  NotFoundError,
  RateLimitError,
  ServiceUnavailableError,
  TimeoutError,
  TokenExpiredError,
  UnauthorizedError,
  UpstreamError,
  ValidationError,
} from './errors/errors.js';
export { serializeError } from './errors/serialize-error.js';

export {
  createMetricsRegistry,
  LATENCY_BUCKETS_MS,
  TOKEN_BUCKETS,
} from './metrics/create-metrics-registry.js';
export { renderPrometheus } from './metrics/render-prometheus.js';
export { createLogger } from './logger/create-logger.js';
export { LOG_LEVELS, LOG_LEVEL_NAMES, isLogLevel } from './logger/levels.js';
export { REDACTED, isSensitiveKey, redact } from './logger/redact.js';

export { loadConfig } from './config/load-config.js';
export { envSchema, parseEnv } from './config/env-schema.js';
export { parseSiteProfile, siteProfileSchema } from './config/site-profile-schema.js';
export { contentSchema, contentSourceSchema } from './config/content-source-schema.js';
export { readJsonFile } from './config/read-json-file.js';

export { formatIssues } from './validation/format-issues.js';

export { readJsonBody } from './http/read-json-body.js';
export { sanitizeUpstreamText } from './http/sanitize-upstream-text.js';
export { sendRequest } from './http/send-request.js';

export { withRetry } from './async/with-retry.js';
export { withTimeout } from './async/with-timeout.js';

/**
 * Re-exported types. Consumers reference these as
 * `import('@shopsage/platform').Logger`.
 *
 * @typedef {import('./logger/create-logger.js').Logger} Logger
 * @typedef {import('./metrics/create-metrics-registry.js').MetricsRegistry} MetricsRegistry
 * @typedef {import('./metrics/create-metrics-registry.js').Counter} Counter
 * @typedef {import('./metrics/create-metrics-registry.js').Histogram} Histogram
 * @typedef {import('./logger/levels.js').LogLevel} LogLevel
 * @typedef {import('./config/load-config.js').AppConfig} AppConfig
 * @typedef {import('./config/env-schema.js').EnvConfig} EnvConfig
 * @typedef {import('./config/site-profile-schema.js').SiteProfile} SiteProfile
 * @typedef {import('./config/content-source-schema.js').ContentConfig} ContentConfig
 * @typedef {import('./config/content-source-schema.js').ContentSourceConfig} ContentSourceConfig
 * @typedef {import('./errors/error-codes.js').ErrorCode} ErrorCode
 * @typedef {import('./async/with-retry.js').RetryNotice} RetryNotice
 * @typedef {import('./async/with-retry.js').WithRetryOptions} WithRetryOptions
 */
