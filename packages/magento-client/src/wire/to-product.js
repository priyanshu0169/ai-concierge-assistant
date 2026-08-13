/**
 * The wire format, confined to this directory.
 *
 * Every field name from `docs/proposals/0002-commerce-connector-contract.md` appears here and
 * nowhere else in the repository. That is the whole point of the adapter: replacing the reference
 * connector with the real Magento module should touch these two files and nothing above them.
 *
 * Mapping is **defensive**, not trusting. Anything unrecognised or malformed becomes `undefined`
 * rather than throwing, because a connector that adds a field, renames one, or returns null for
 * something optional must not take the assistant down. The contract says ShopSage treats an
 * unknown field as absent; this is where that promise is kept.
 */

const AVAILABILITY = new Set(['in_stock', 'out_of_stock', 'backorder', 'unknown']);

/**
 * @param {unknown} raw
 * @returns {import('@shopsage/assistant-core').Product | undefined}
 */
export function toProduct(raw) {
  if (typeof raw !== 'object' || raw === null) return undefined;

  const wire = /** @type {Record<string, any>} */ (raw);
  const sku = text(wire.sku);
  const name = text(wire.name);
  const url = httpUrl(wire.url);

  // All three are required by the contract, and each earns it. Without a `sku` a follow-up
  // question cannot refer to the product; without a `url` the assistant would make a claim a
  // customer cannot check, which is the one thing this project consistently refuses to ship.
  if (sku === undefined || name === undefined || url === undefined) return undefined;

  return {
    sku,
    name,
    url,
    ...optional('imageUrl', httpUrl(wire.imageUrl)),
    ...optional('summary', text(wire.summary)),
    ...optional('price', toPrice(wire.price)),
    // Never inferred, per the accepted contract. Absent means absent: the assistant says nothing
    // about availability rather than guessing from anything else in the payload.
    ...optional(
      'availability',
      AVAILABILITY.has(wire.availability) ? wire.availability : undefined,
    ),
  };
}

/**
 * @param {unknown} raw
 * @returns {import('@shopsage/assistant-core').Money | undefined}
 */
export function toPrice(raw) {
  if (typeof raw !== 'object' || raw === null) return undefined;

  const wire = /** @type {Record<string, any>} */ (raw);
  const formatted = text(wire.formatted);

  // `formatted` is the only field the assistant ever shows, so a price without one is not a price
  // ShopSage can use. It will not render money itself: it does not know the store's conventions
  // and must not learn them.
  if (formatted === undefined) return undefined;

  // `taxIncluded` must be **explicit**. A store quoting ex-VAT figures to a consumer without
  // saying so has a legal problem, and neither ShopSage nor a model can infer which it is - so an
  // absent flag is carried as absent and the tool says the tax treatment is unstated.
  const taxIncluded = typeof wire.taxIncluded === 'boolean' ? wire.taxIncluded : undefined;

  return {
    formatted,
    // A decimal **string**, never parsed. Floats and money do not mix, and nothing on this side
    // does arithmetic on it anyway - it is carried through for a caller that needs to sort.
    ...optional('amount', text(wire.amount)),
    ...optional('currency', text(wire.currency)),
    ...optional('taxIncluded', taxIncluded),
  };
}

/**
 * @param {unknown} raw
 * @returns {import('@shopsage/assistant-core').Order | undefined}
 */
export function toOrder(raw) {
  if (typeof raw !== 'object' || raw === null) return undefined;

  const wire = /** @type {Record<string, any>} */ (raw);
  const reference = text(wire.reference);

  if (reference === undefined) return undefined;

  // Deliberately **not** mapped: address, email, phone, payment detail. The accepted contract
  // limits order responses to status, reference, estimated delivery and tracking - and even if a
  // connector sent more, it would stop here. An answer about an order is written into persisted
  // conversation history, so what is not mapped is what is not retained.
  return {
    reference,
    ...optional('status', text(wire.status)),
    ...optional('statusLabel', text(wire.statusLabel)),
    ...optional('placedAt', text(wire.placedAt)),
    ...optional('estimatedDelivery', text(wire.estimatedDelivery)),
    ...optional('trackingUrl', httpUrl(wire.trackingUrl)),
    ...optional('total', toPrice(wire.total)),
    items: Array.isArray(wire.items) ? wire.items.map(toOrderItem).filter(defined) : [],
  };
}

/**
 * @param {unknown} raw
 * @returns {{ name: string, quantity: number, sku?: string } | undefined}
 */
function toOrderItem(raw) {
  if (typeof raw !== 'object' || raw === null) return undefined;

  const wire = /** @type {Record<string, any>} */ (raw);
  const name = text(wire.name);

  if (name === undefined) return undefined;

  return {
    name,
    quantity: Number.isInteger(wire.quantity) && wire.quantity > 0 ? wire.quantity : 1,
    ...optional('sku', text(wire.sku)),
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
 * A URL the widget will be willing to render.
 *
 * Checked here as well as in the widget. The widget's check is the one that matters for safety;
 * this one stops a product with an unusable link from being offered to the model at all, so the
 * assistant does not cite something a customer cannot open.
 *
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

/**
 * @template T
 * @param {T | undefined} value
 * @returns {value is T}
 */
function defined(value) {
  return value !== undefined;
}
