import { UpstreamError, readJsonBody, sendRequest, withRetry } from '@shopsage/platform';
import { toOrder, toProduct } from './wire/to-product.js';

const DEFAULT_TIMEOUT_MS = 5_000;
/**
 * A model cannot use fifty products and the prompt cannot hold them. Ten is already more than a
 * customer wants read out, and the tools narrow further.
 */
const MAX_LIMIT = 10;

/**
 * @typedef {object} MagentoClientOptions
 * @property {string} baseUrl Where the connector is. Ends before `/assistant/v1`.
 * @property {number} [timeoutMs] Per-call budget. Default 5000.
 * @property {number} [maxAttempts] For idempotent reads only. Default 2.
 * @property {string} [serviceToken] Optional, identifies ShopSage itself to the connector.
 * @property {import('@shopsage/platform').Logger} [logger]
 * @property {typeof fetch} [fetchImpl] Injection seam for tests.
 */

/**
 * The commerce connector, behind the domain's `CommerceCatalogue` port.
 *
 * This package and `wire/` are the only places that know the contract in
 * `docs/proposals/0002-commerce-connector-contract.md`. Replacing the reference connector with the
 * real Magento module is a configuration change and, at most, a change to `wire/`; the port, the
 * tools and the conversation loop do not move. That separation is the point of the whole
 * arrangement, and it is worth checking on any future change that it still holds.
 *
 * **The customer's session token is forwarded, never interpreted.** ShopSage does not know who the
 * customer is - the token's subject is a pseudonym by agreement
 * (docs/proposals/0001-assistant-session-token.md, decision 2) - so the connector resolves
 * identity because it minted the token. Nothing here parses it, and nothing here logs it.
 *
 * **Reads retry; writes never will.** A GET is idempotent so a transient failure is worth one more
 * attempt. A cart mutation is not, and no amount of status-code inspection makes it safe - a
 * duplicate "add to basket" is a customer's problem, not a metric.
 *
 * @param {MagentoClientOptions} options
 * @returns {import('@shopsage/assistant-core').CommerceCatalogue & { health: () => Promise<void> }}
 */
export function createMagentoClient(options) {
  const base = `${options.baseUrl.replace(/\/+$/u, '')}/assistant/v1`;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const read = createReader({ base, timeoutMs, options });

  return {
    async searchProducts({ query, limit, credential }) {
      const capped = Math.min(limit ?? 5, MAX_LIMIT);
      const body = await read({
        path: `/products?q=${encodeURIComponent(query)}&limit=${capped}`,
        credential,
        label: 'searchProducts',
      });

      return itemsOf(body).map(toProduct).filter(defined).slice(0, capped);
    },

    async findProduct({ sku, credential }) {
      // The sku goes in a path segment, so it is encoded rather than interpolated. A sku with a
      // slash in it would otherwise address a different endpoint entirely.
      const body = await read({
        path: `/products/${encodeURIComponent(sku)}`,
        credential,
        label: 'findProduct',
      });

      return body === undefined ? undefined : toProduct(body);
    },

    async listOrders({ credential }) {
      const body = await read({ path: '/orders', credential, label: 'listOrders' });

      return itemsOf(body).map(toOrder).filter(defined);
    },

    /**
     * Reachability, for an operational check rather than for readiness.
     *
     * Deliberately **not** wired into `/health/ready`: a connector outage degrades commerce
     * answers while knowledge answers keep working, and failing readiness would pull every
     * instance out of the load balancer over a partial failure. The same reasoning that keeps the
     * LLM gateway out of readiness (docs/adr/0014), reached for a different reason.
     */
    async health() {
      const response = await sendRequest({
        url: `${base}/categories`,
        method: 'GET',
        headers: headersFor(undefined, options.serviceToken),
        timeoutMs,
        label: 'commerce health',
        fetchImpl: options.fetchImpl,
      });

      if (!response.ok) {
        throw new UpstreamError(`Commerce connector returned ${response.status}`, {
          details: { upstreamStatus: response.status },
        });
      }
    },
  };
}

/**
 * One read, with the whole evaluation **inside** the retry.
 *
 * That placement is the point. `sendRequest` resolves for a 503 rather than throwing, so a retry
 * wrapped around the request alone would retry a dropped connection and *not* a connector that
 * answered "try again shortly" - which is the failure most worth a second attempt. Judging the
 * status in here is what makes the retry mean what the contract says it means.
 *
 * @param {{ base: string, timeoutMs: number, options: MagentoClientOptions }} setup
 * @returns {(input: { path: string, credential?: string, label: string }) => Promise<unknown>}
 */
function createReader(setup) {
  const { base, timeoutMs, options } = setup;

  return (input) =>
    withRetry(
      async () => {
        const response = await sendRequest({
          url: `${base}${input.path}`,
          method: 'GET',
          headers: headersFor(input.credential, options.serviceToken),
          timeoutMs,
          label: `commerce ${input.label}`,
          fetchImpl: options.fetchImpl,
        });

        // "We do not sell that" is an answer, so an empty result is not a failure. The contract
        // makes 404 mean absent, which is why it is returned rather than raised.
        if (response.status === 404) return undefined;

        if (!response.ok) {
          // The body is deliberately not read into the message. A connector's error text is written
          // for an operator, and everything above this turns a failure into "I could not look that
          // up" regardless of what it said.
          throw new UpstreamError(`Commerce connector returned ${response.status}`, {
            details: { operation: input.label, upstreamStatus: response.status },
            // A 5xx is worth another attempt; a 400 or a 403 will say the same thing twice.
            retryable: response.status >= 500,
          });
        }

        return readJsonBody(response, `commerce ${input.label}`);
      },
      {
        // Only ever wrapping a GET. Every method on this client is a read, and that is enforced by
        // there being no other method - Stage 9b's cart mutations will not come through here.
        maxAttempts: options.maxAttempts ?? 2,
        // The default is exactly right: retry an `AppError` marked retryable. Stated rather than
        // omitted because "which failures are retried" is the whole safety argument for this client,
        // and it should not be something a reader has to go and look up.
        isRetryable: (error) => error instanceof UpstreamError && error.retryable,
        onRetry: (notice) =>
          options.logger?.warn('retrying commerce read', {
            operation: input.label,
            attempt: notice.attempt,
          }),
      },
    );
}

/**
 * @param {string | undefined} credential
 * @param {string | undefined} serviceToken
 * @returns {Record<string, string>}
 */
function headersFor(credential, serviceToken) {
  return {
    accept: 'application/json',
    // The customer's own session token, forwarded verbatim.
    ...(credential === undefined ? {} : { authorization: `Bearer ${credential}` }),
    // Separate header, separate purpose: this says "the caller is ShopSage", where the bearer says
    // "on behalf of this session". Collapsing them would make a stolen customer token sufficient
    // to impersonate the service.
    ...(serviceToken === undefined ? {} : { 'x-shopsage-service-token': serviceToken }),
  };
}

/**
 * @param {unknown} body
 * @returns {unknown[]}
 */
function itemsOf(body) {
  const items = /** @type {{ items?: unknown }} */ (body)?.items;

  return Array.isArray(items) ? items : [];
}

/**
 * @template T
 * @param {T | undefined} value
 * @returns {value is T}
 */
function defined(value) {
  return value !== undefined;
}
