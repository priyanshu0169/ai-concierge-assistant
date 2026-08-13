import { compareProducts } from '../commerce/compare-products.js';
import { commerceOf, credentialOf } from './commerce-context.js';
import { formatProducts } from './format-product.js';

/**
 * Two is the minimum for a comparison and four is where a customer stops following one.
 */
const MIN_SKUS = 2;
const MAX_SKUS = 4;

const DESCRIPTION = [
  'Compare two to four specific products side by side by their skus, which you can get from',
  'searchProducts. Returns each product with live prices, plus which characteristics they share and',
  'which actually differ. Report the differences it names; do not calculate price differences,',
  'savings or percentages.',
].join(' ');

/**
 * Side-by-side comparison.
 *
 * Takes skus rather than a description because a comparison has to be of the products the customer
 * meant. Given a phrase this tool would have to guess which two of five search results to compare,
 * and a comparison of the wrong pair is worse than asking - so the model searches first, and the
 * skus come from a result it has already shown.
 *
 * @param {import('@shopsage/platform').SiteProfile} _siteProfile
 * @returns {import('../types.js').AssistantTool}
 */
export function createCompareProductsTool(_siteProfile) {
  return {
    name: 'compareProducts',
    description: DESCRIPTION,
    parameters: {
      type: 'object',
      properties: {
        skus: {
          type: 'array',
          items: { type: 'string' },
          description: `Between ${MIN_SKUS} and ${MAX_SKUS} product codes, from earlier search results.`,
        },
      },
      required: ['skus'],
    },

    async execute({ arguments: args, context }) {
      const commerce = commerceOf(context, 'compareProducts');
      const skus = skusOf(args.skus);

      if (skus.length < MIN_SKUS) {
        return {
          content: `Provide at least ${MIN_SKUS} distinct skus to compare. Use searchProducts first if you do not have them.`,
        };
      }

      // Concurrent, because the comparison is useless until every product has arrived, and issuing
      // four sequential reads would multiply the customer's wait by four for nothing. The connector
      // caps its own concurrency; ShopSage bounds this by MAX_SKUS.
      const found = await Promise.all(
        skus.map((sku) => commerce.findProduct({ sku, ...credentialOf(context) })),
      );

      const products = /** @type {import('../types.js').Product[]} */ (
        found.filter((product) => product !== undefined)
      );
      const missing = skus.filter((_sku, index) => found[index] === undefined);

      context.logger?.debug('compareProducts executed', {
        requested: skus.length,
        found: products.length,
      });

      if (products.length < MIN_SKUS) {
        // Named rather than glossed over. A comparison quietly reduced to one product is how an
        // assistant ends up describing a single item as though the customer had asked about it.
        return {
          content: `Not enough of those products could be found to compare${describeMissing(missing)}. Tell the customer which ones you could not find.`,
        };
      }

      return { content: brief(compareProducts(products), missing) };
    },
  };
}

/**
 * @param {import('../commerce/compare-products.js').Comparison} comparison
 * @param {string[]} missing
 * @returns {string}
 */
function brief(comparison, missing) {
  const lines = [formatProducts(comparison.products), ''];

  if (comparison.ordered) {
    // Both halves matter. Naming the cheaper one is what the customer asked; refusing the difference
    // is the rule that a bare "cheapest first" does not convey, and this is the tool where the
    // question arrives.
    lines.push(
      'Listed cheapest first - you may say which is cheaper, but never by how much, and never',
      'give a difference or a percentage. Quote both prices instead.',
    );
  }
  if (comparison.shared.length > 0) {
    lines.push(`Identical across all of them - say it once: ${comparison.shared.join('; ')}.`);
  }
  if (comparison.differing.length > 0) {
    lines.push(`These genuinely differ: ${comparison.differing.join(', ')}.`);
  }
  if (comparison.unknown.length > 0) {
    // Absence stated, so the model does not fill it in. "The store did not say" is a legitimate
    // sentence and a far better one than a plausible invention.
    lines.push(
      `Not stated for any of them - do not compare on these: ${comparison.unknown.join(', ')}.`,
    );
  }
  if (missing.length > 0) lines.push(`Could not be found${describeMissing(missing)}.`);

  return lines.join('\n');
}

/**
 * @param {string[]} missing
 * @returns {string}
 */
function describeMissing(missing) {
  return missing.length === 0 ? '' : `: ${missing.join(', ')}`;
}

/**
 * @param {unknown} value
 * @returns {string[]}
 */
function skusOf(value) {
  if (!Array.isArray(value)) return [];

  const cleaned = value
    .filter((entry) => typeof entry === 'string')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);

  // Deduplicated before the cap, so a model repeating one sku does not spend the whole budget on it
  // and produce a "comparison" of a product with itself.
  return [...new Set(cleaned)].slice(0, MAX_SKUS);
}
