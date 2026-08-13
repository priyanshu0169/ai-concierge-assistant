/**
 * Reaching the commerce port from a tool, and ordering prices without doing arithmetic on them.
 */

/**
 * The commerce port, or a clear failure.
 *
 * Absence here is a **composition bug**, not a runtime condition: a commerce tool is only registered
 * when its site-profile flag is on, and the backend refuses to boot with a commerce flag on and no
 * connector configured. So if this throws, a deployment is wrong and an operator needs to see it in
 * the log - which is exactly what the tool loop does with a thrown tool, while still telling the
 * customer only that it could not look something up.
 *
 * @param {import('../types.js').ToolContext} context
 * @param {string} toolName
 * @returns {import('../types.js').CommerceCatalogue}
 */
export function commerceOf(context, toolName) {
  if (context.commerce === undefined) {
    throw new Error(
      `${toolName} was registered without a commerce connector; check MAGENTO_API_URL and the site profile features`,
    );
  }

  return context.commerce;
}

/**
 * What every commerce tool passes down: the customer's token, forwarded untouched.
 *
 * A separate function so the pattern is visible and identical in all four tools. The token is not
 * parsed, not branched on, and not logged anywhere in this package - the connector minted it and is
 * the only thing entitled to read it.
 *
 * @param {import('../types.js').ToolContext} context
 * @returns {{ credential?: string }}
 */
export function credentialOf(context) {
  return context.credential === undefined ? {} : { credential: context.credential };
}

/**
 * Order two products by price, cheapest first.
 *
 * Ordering is the **only** operation this codebase performs on a price, and it is allowed precisely
 * because it produces no new monetary figure: it rearranges strings the connector wrote. Computing
 * "£45 cheaper" would invent a number about money, which is the thing forbidden throughout
 * (docs/adr/0028).
 *
 * The comparison is exact and never touches a float. `amount` is a decimal string, so a longer
 * integer part is always the larger value and equal-length integer parts compare lexicographically -
 * true for the non-negative decimals a catalogue contains. `Number()` would be shorter and would
 * quietly reintroduce binary rounding into the one place this project refuses to have it.
 *
 * @param {import('../types.js').Product} left
 * @param {import('../types.js').Product} right
 * @returns {number}
 */
export function byPrice(left, right) {
  return compareAmounts(left.price?.amount, right.price?.amount);
}

/**
 * Whether these products' prices can be ordered at all.
 *
 * Mixed currencies cannot: a store selling in two currencies has no exchange rate ShopSage is
 * entitled to guess at, and "cheapest" across currencies would be a fabricated comparison.
 *
 * @param {import('../types.js').Product[]} products
 * @returns {boolean}
 */
export function comparableByPrice(products) {
  const currencies = new Set(products.map((product) => product.price?.currency));

  return (
    currencies.size === 1 &&
    !currencies.has(undefined) &&
    products.every((product) => isDecimal(product.price?.amount))
  );
}

/**
 * @param {string | undefined} left
 * @param {string | undefined} right
 * @returns {number}
 */
function compareAmounts(left, right) {
  // A product without a usable amount sorts last rather than first, so a missing price never
  // presents itself as the cheapest option.
  if (!isDecimal(left)) return isDecimal(right) ? 1 : 0;
  if (!isDecimal(right)) return -1;

  const [leftWhole, leftFraction = ''] = String(left).split('.');
  const [rightWhole, rightFraction = ''] = String(right).split('.');

  // A longer integer part is a larger number, given both are non-negative decimals. Checked before
  // any string comparison, because "9" > "10" lexicographically and is not numerically.
  if (leftWhole.length !== rightWhole.length) return leftWhole.length - rightWhole.length;

  return compareDigits(leftWhole, rightWhole) || compareFractions(leftFraction, rightFraction);
}

/**
 * @param {string} left
 * @param {string} right
 * @returns {number}
 */
function compareFractions(left, right) {
  // Padded to equal width first, so "5" and "50" compare as the same value rather than "5" < "50".
  const width = Math.max(left.length, right.length);

  return compareDigits(left.padEnd(width, '0'), right.padEnd(width, '0'));
}

/**
 * @param {string} left Same length as `right`.
 * @param {string} right
 * @returns {number}
 */
function compareDigits(left, right) {
  if (left === right) return 0;

  return left < right ? -1 : 1;
}

/**
 * @param {unknown} value
 * @returns {boolean}
 */
function isDecimal(value) {
  return typeof value === 'string' && /^\d+(?:\.\d+)?$/u.test(value);
}
