import { byPrice, comparableByPrice } from '../tools/commerce-context.js';

/**
 * Comparison, and it lives here rather than in Magento by decision.
 *
 * Magento exposes product data; deciding what is worth saying about two products is assistant
 * behaviour, and it changes for reasons that have nothing to do with a catalogue - a better ordering,
 * a new axis, a different house style. Pushing it into the store's module would make every such
 * change a Magento release, and would tie ShopSage to one platform's idea of a comparison.
 *
 * The output is deliberately a **structured brief**, not prose. The model writes the sentence; this
 * decides what is true. That division is why the comparison contains no invented figures: no price
 * differences, no "better value", no percentages. Ordering is the only price operation, and it
 * produces no new number (see `byPrice`).
 */

/**
 * @typedef {object} Comparison
 * @property {import('../types.js').Product[]} products In a defensible order.
 * @property {boolean} ordered Whether the order means anything.
 * @property {string[]} shared Facts true of every product, so not worth repeating per item.
 * @property {string[]} differing Axes that actually distinguish them.
 * @property {string[]} unknown Axes no product could be compared on.
 */

/**
 * @param {import('../types.js').Product[]} products
 * @returns {Comparison}
 */
export function compareProducts(products) {
  // Ordering by price when every product shares a currency, and leaving the connector's order alone
  // otherwise. A "cheapest first" list that silently was not sorted is worse than an unsorted one.
  const ordered = comparableByPrice(products);
  const sorted = ordered ? [...products].sort(byPrice) : [...products];

  /** @type {string[]} */
  const shared = [];
  /** @type {string[]} */
  const differing = [];
  /** @type {string[]} */
  const unknown = [];

  for (const axis of AXES) {
    const values = sorted.map(axis.read);

    if (values.every((value) => value === undefined)) {
      unknown.push(axis.label);
      continue;
    }

    const distinct = new Set(values);

    if (distinct.size === 1) shared.push(`${axis.label}: ${values[0]}`);
    else differing.push(axis.label);
  }

  return { products: sorted, ordered, shared, differing, unknown };
}

/**
 * The axes worth comparing, given what the connector contract carries.
 *
 * Short on purpose. A comparison of made-up dimensions reads authoritative and is worthless, so this
 * only names things the connector actually stated. When the contract grows structured attributes -
 * size, material, capacity - they arrive as entries here and the tool text does not change.
 *
 * @type {readonly { label: string, read: (product: import('../types.js').Product) => string | undefined }[]}
 */
const AXES = Object.freeze([
  { label: 'Price', read: (product) => product.price?.formatted },
  { label: 'Availability', read: (product) => product.availability },
  {
    label: 'Tax treatment',
    // Stated as text rather than a boolean so "unstated" is a value of its own. Two products, one
    // marked tax-inclusive and one silent, do not agree - and must not look like they do.
    read: (product) => taxWording(product.price?.taxIncluded),
  },
]);

/**
 * @param {boolean | undefined} taxIncluded
 * @returns {string | undefined}
 */
function taxWording(taxIncluded) {
  if (taxIncluded === true) return 'included';
  if (taxIncluded === false) return 'excluded';

  return undefined;
}
