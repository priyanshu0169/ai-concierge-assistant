import { rankRecommendations } from '../commerce/rank-recommendations.js';
import { commerceOf, credentialOf } from './commerce-context.js';
import { formatProducts } from './format-product.js';

/**
 * Three is a shortlist a customer will read. Ten candidates is enough for the ranking to have
 * something to choose between - fewer, and the spread across the price range is meaningless.
 */
const MAX_RECOMMENDATIONS = 3;
const CANDIDATE_POOL = 10;

const DESCRIPTION = [
  'Suggest a small shortlist of products for a described need, such as "something warm for walking"',
  'or "a gift under twenty pounds". Each suggestion comes with the reason it was chosen. Give the',
  'reason as stated; do not add claims about quality, popularity or suitability that are not there.',
].join(' ');

/**
 * Recommendation, as a search plus ShopSage's own choosing.
 *
 * The connector is asked for candidates and ShopSage decides the shortlist, which is the accepted
 * split: Magento exposes product data, recommendation logic lives here (docs/adr/0028). The reason
 * is not architectural neatness - it is that "do not recommend what they cannot buy" is a rule that
 * needs a test, and it has one here.
 *
 * The reasons matter as much as the products. A shortlist without them invites the model to supply
 * its own, and a confident invented reason is indistinguishable from a real one to the person
 * reading it.
 *
 * @param {import('@shopsage/platform').SiteProfile} _siteProfile
 * @returns {import('../types.js').AssistantTool}
 */
export function createRecommendProductsTool(_siteProfile) {
  return {
    name: 'recommendProducts',
    description: DESCRIPTION,
    parameters: {
      type: 'object',
      properties: {
        need: {
          type: 'string',
          description: 'What the customer is trying to solve, in their terms - not a product name.',
        },
      },
      required: ['need'],
    },

    async execute({ arguments: args, context }) {
      const commerce = commerceOf(context, 'recommendProducts');
      const need = typeof args.need === 'string' ? args.need.trim() : '';

      if (need === '') {
        return { content: 'Describe what the customer needs when calling recommendProducts.' };
      }

      const candidates = await commerce.searchProducts({
        query: need,
        limit: CANDIDATE_POOL,
        ...credentialOf(context),
      });

      const shortlist = rankRecommendations({
        query: need,
        candidates,
        limit: MAX_RECOMMENDATIONS,
      });

      context.logger?.debug('recommendProducts executed', {
        candidates: candidates.length,
        recommended: shortlist.length,
      });

      if (shortlist.length === 0) {
        return {
          content:
            'Nothing in the catalogue matches that need. Say so honestly and ask what else would help; do not suggest a product that was not returned.',
        };
      }

      return { content: brief(shortlist) };
    },
  };
}

/**
 * The shortlist, with the products once and the rules once.
 *
 * `formatProducts` rather than `formatProduct` per entry: the per-product form appends the whole
 * rules block, so calling it three times would repeat those rules three times in one tool result -
 * a third of the message spent restating itself, and prompt space that a real catalogue's summaries
 * need. The reasons follow as their own short list, keyed by sku.
 *
 * @param {import('../commerce/rank-recommendations.js').Recommendation[]} shortlist
 * @returns {string}
 */
function brief(shortlist) {
  const anyBuyable = shortlist.some((entry) => entry.product.availability !== 'out_of_stock');

  return [
    formatProducts(shortlist.map((entry) => entry.product)),
    '',
    'Why each was chosen:',
    ...shortlist.map((entry) => `- ${entry.product.sku}: it ${entry.reason}.`),
    '',
    anyBuyable
      ? 'Present these as options, giving the reason for each.'
      : // Stated explicitly, because a shortlist of unbuyable products presented as suggestions
        // wastes a customer's time. The fallback exists so they hear "we stock it but not today"
        // rather than "we do not sell that".
        'Everything matching is currently unavailable. Say that clearly before describing them.',
  ].join('\n');
}
