import { toPrice } from './to-product.js';

/**
 * The cart's response, mapped in the one place that knows the wire format.
 *
 * Same defensive posture as `to-product.js`, and one extra rule that matters more here: **`applied`
 * defaults to `false`**. Every other field falls back to absent, but a missing or unrecognised
 * `applied` cannot fall back to "it worked" — telling a customer their item is in the basket when the
 * connector never said so is the failure this whole workflow was built to avoid, and defaulting the
 * other way would reintroduce it at the last possible step.
 *
 * @param {unknown} raw
 * @returns {import('@shopsage/assistant-core').CartOutcome}
 */
export function toCartOutcome(raw) {
  if (typeof raw !== 'object' || raw === null) return { applied: false };

  const wire = /** @type {Record<string, any>} */ (raw);

  return {
    applied: wire.applied === true,
    // The store's own wording, kept verbatim. Only the connector knows how a store says "that code has
    // expired", and ShopSage does not compose commerce copy.
    ...optional('message', text(wire.message)),
    ...optional('itemCount', Number.isInteger(wire.itemCount) ? wire.itemCount : undefined),
    // The total **as the connector computed it**. Nothing on this side adds anything up - see
    // docs/adr/0028.
    ...optional('total', toPrice(wire.total)),
    ...optional('cartUrl', httpUrl(wire.cartUrl)),
  };
}

/**
 * @template T
 * @param {string} key
 * @param {T | undefined} value
 * @returns {Record<string, T>}
 */
function optional(key, value) {
  return value === undefined ? {} : { [key]: value };
}

/**
 * @param {unknown} value
 * @returns {string | undefined}
 */
function text(value) {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}

/**
 * @param {unknown} value
 * @returns {string | undefined}
 */
function httpUrl(value) {
  const candidate = text(value);

  if (candidate === undefined) return undefined;

  try {
    const { protocol } = new URL(candidate);

    return protocol === 'http:' || protocol === 'https:' ? candidate : undefined;
  } catch {
    return undefined;
  }
}
