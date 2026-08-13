import { UpstreamError, readJsonBody, sendRequest } from '@shopsage/platform';
import { toCartOutcome } from './wire/to-cart-outcome.js';

const DEFAULT_TIMEOUT_MS = 5_000;

/**
 * The cart, behind the domain's `CommerceCart` port.
 *
 * **A separate factory from `createMagentoClient`, and `withRetry` is not imported here.** That is the
 * whole point of the file existing. The read client wraps every call in a retry, and if writes lived
 * alongside them the rule "a mutation is never retried" would be one careless refactor from being
 * false — somebody consolidating two nearly-identical request helpers, with a passing test suite,
 * because no test can see the second charge. Here there is no retry to reach.
 *
 * Note what is *not* judged: a 5xx is not "worth another attempt", because the connector may have
 * already added the item and lost the response. The honest thing is to tell the customer it did not
 * confirm and let them look at their basket, which is exactly what a failed confirmation does.
 *
 * The `idempotencyKey` is sent so a connector that supports one can recognise a repeat. ShopSage's own
 * defence is stronger and happens first: a proposal is consumed atomically, so a second confirmation
 * has nothing to confirm. The key covers the case that survives that — the request arrived and the
 * response did not.
 *
 * @param {import('./create-magento-client.js').MagentoClientOptions} options
 * @returns {import('@shopsage/assistant-core').CommerceCart}
 */
export function createMagentoCart(options) {
  const base = `${options.baseUrl.replace(/\/+$/u, '')}/assistant/v1`;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  /**
   * @param {{ path: string, body: unknown, idempotencyKey: string, credential?: string, label: string }} input
   * @returns {Promise<import('@shopsage/assistant-core').CartOutcome>}
   */
  const write = async (input) => {
    const response = await sendRequest({
      url: `${base}${input.path}`,
      method: 'POST',
      headers: {
        accept: 'application/json',
        'content-type': 'application/json',
        // The header the contract names, so a connector can deduplicate on its own side.
        'idempotency-key': input.idempotencyKey,
        ...(input.credential === undefined ? {} : { authorization: `Bearer ${input.credential}` }),
        ...(options.serviceToken === undefined
          ? {}
          : { 'x-shopsage-service-token': options.serviceToken }),
      },
      body: JSON.stringify(input.body),
      timeoutMs,
      label: `cart ${input.label}`,
      fetchImpl: options.fetchImpl,
    });

    if (!response.ok) {
      throw new UpstreamError(`Commerce connector returned ${response.status}`, {
        details: { operation: input.label, upstreamStatus: response.status },
        // **Never retryable, whatever the status.** A write that may have partially happened must not
        // be repeated by anything upstream of here either, and `retryable` is what tells a caller it
        // is safe to try again. It is not.
        retryable: false,
      });
    }

    return toCartOutcome(await readJsonBody(response, `cart ${input.label}`));
  };

  return {
    addToCart({ lines, idempotencyKey, credential }) {
      return write({
        path: '/cart/items',
        // Only sku and quantity. The name, price and URL in a proposal exist so a **customer** could
        // see what they agreed to; sending them would invite a connector to trust ShopSage's idea of a
        // price, and the connector is the authority on what things cost.
        body: { items: lines.map((line) => ({ sku: line.sku, quantity: line.quantity })) },
        idempotencyKey,
        credential,
        label: 'addToCart',
      });
    },

    applyCoupon({ code, idempotencyKey, credential }) {
      return write({
        path: '/cart/coupon',
        body: { code },
        idempotencyKey,
        credential,
        label: 'applyCoupon',
      });
    },
  };
}
