import { commerceOf, credentialOf } from './commerce-context.js';
import { formatProduct, formatProducts } from './format-product.js';

/**
 * How many products one answer can usefully carry.
 *
 * A customer asking "do you sell walking boots" wants a few options, not a catalogue page. The
 * connector caps this too - the cap exists in both places because each protects something different:
 * the connector protects itself, this protects the prompt and the customer's patience.
 */
const MAX_RESULTS = 5;

const DESCRIPTION = [
  'Look up individual products in the live catalogue, with current prices and availability.',
  'Use this when the customer needs something that must be current: what an item costs, whether',
  'it is in stock, or the details of one specific product. Search by description, or pass a sku.',
  'Never state a price or stock level that did not come from this tool.',
  'For broader questions about what kinds of products the store offers, or how products differ,',
  'use searchKnowledge instead - the website describes those, and it covers far more of the',
  'range than a single catalogue lookup returns.',
].join(' ');

/**
 * Products, read live from the store.
 *
 * The knowledge base and the catalogue are deliberately separate tools rather than one blended
 * search, and the reason is freshness. A price in an indexed blog post is whatever it was on the day
 * the page was written; a price from here is whatever the store says right now. Blending them would
 * let stale money answer a current question, and no amount of ranking makes that safe.
 *
 * @param {import('@shopsage/platform').SiteProfile} _siteProfile
 * @returns {import('../types.js').AssistantTool}
 */
export function createSearchProductsTool(_siteProfile) {
  return {
    name: 'searchProducts',
    description: DESCRIPTION,
    parameters: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description:
            'What the customer is looking for, in the words a product listing would use.',
        },
        sku: {
          type: 'string',
          description: 'A specific product code, when the customer or an earlier result gave one.',
        },
      },
    },

    async execute({ arguments: args, context }) {
      const commerce = commerceOf(context, 'searchProducts');
      const sku = text(args.sku);
      const query = text(args.query);

      if (sku !== undefined) {
        const product = await commerce.findProduct({ sku, ...credentialOf(context) });

        context.logger?.debug('searchProducts executed', {
          by: 'sku',
          found: product !== undefined,
        });

        // Not an error. A sku the model half-remembered from earlier in the conversation, or one a
        // customer mistyped, is an ordinary miss - and the model needs to be able to tell that
        // apart from a failure so it searches again instead of apologising for an outage.
        return product === undefined
          ? { content: `No product found with sku ${sku}. Try searchProducts with a description.` }
          : { content: formatProduct(product) };
      }

      if (query === undefined) {
        return { content: 'Provide either a query or a sku when calling searchProducts.' };
      }

      const products = await commerce.searchProducts({
        query,
        limit: MAX_RESULTS,
        ...credentialOf(context),
      });

      context.logger?.debug('searchProducts executed', { by: 'query', found: products.length });

      return { content: formatProducts(products) };
    },
  };
}

/**
 * @param {unknown} value
 * @returns {string | undefined}
 */
function text(value) {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}
