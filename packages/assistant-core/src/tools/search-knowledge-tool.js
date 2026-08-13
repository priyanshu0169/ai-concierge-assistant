import { buildContext } from '../retrieval/build-context.js';
import { rankChunks } from '../retrieval/rank-chunks.js';

/**
 * Told to the model, so the wording matters as much as the code.
 *
 * This description previously claimed the corpus "does not contain product listings, prices or
 * stock levels". The second half is a rule worth keeping; the first half was **false** for any
 * store whose website is crawled, because category and product pages are exactly what a
 * storefront publishes. On this deployment it made the model refuse to search a corpus of 887
 * product and category pages for "what kinds of caviar do you sell", routing instead to the live
 * catalogue - and answering nothing at all when that was unavailable.
 *
 * The distinction that actually matters is not *products vs not products*, it is **durable
 * description vs current fact**. A page describing what Beluga caviar is stays true for months; a
 * price does not. So the boundary is drawn on freshness, and stated as such.
 */
const DESCRIPTION = [
  "Search everything published on the store's own website: help pages, buying guides, FAQs,",
  'blog posts, shipping and returns policies, and the category and product pages describing',
  'what the store sells and how its products differ.',
  'Use this for how the store works, and for what kinds of products it offers - including',
  '"what types of X do you sell", "what is X", and "which X is best for ...".',
  'The pages here are indexed periodically, so use searchProducts for anything that must be',
  'current: never quote a price or a stock level from this tool.',
].join(' ');

/**
 * Restated with every result, for the same reason `format-product.js` restates its own: an
 * instruction at the top of a long conversation loses against fresh content further down, and this
 * is the one where being ignored produces a wrong number about money in the store's own voice.
 *
 * These excerpts have already had transactional values masked
 * (`sanitize-knowledge-context.js`), so this is a backstop for a format the mask does not
 * recognise - a currency symbol this corpus has never carried, or a price written in words. It also
 * tells the model what to do instead, which a bare prohibition does not.
 */
const RULES = [
  'Rules for using these excerpts:',
  '- They come from the store website and are indexed periodically, so they describe what the',
  '  store sells, not what anything currently costs or whether it is in stock.',
  '- Never state a price, discount, stock level or delivery estimate from them, even if one',
  '  appears above. Use searchProducts for anything that must be current.',
  '- Where a price has been removed you will see [price not shown]. Do not guess what it was;',
  '  say the current price is on the product page or offer to look it up.',
].join('\n');

/**
 * The one tool that exists today.
 *
 * Retrieval is a tool rather than a step hard-wired before generation, which is the
 * architecture committed to in docs/adr/0010. The payoff is visible here: when a search
 * misses, the model can rephrase and search again within the same turn - something a
 * single-shot "retrieve then answer" flow cannot do at all.
 *
 * @param {import('@shopsage/platform').SiteProfile} siteProfile
 * @returns {import('../types.js').AssistantTool}
 */
export function createSearchKnowledgeTool(siteProfile) {
  return {
    name: 'searchKnowledge',
    description: DESCRIPTION,
    parameters: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description:
            'What to look for, phrased as the store would describe it rather than as the customer asked.',
        },
      },
      required: ['query'],
    },

    async execute({ arguments: args, context }) {
      const query = typeof args.query === 'string' ? args.query.trim() : '';

      if (query === '') {
        // A tool result, not an exception: the model asked badly and can ask again.
        return { content: 'No query was provided. Call searchKnowledge with a query string.' };
      }

      const { retrieval } = siteProfile;
      const found = await context.retriever.retrieve({
        text: query,
        siteId: context.siteId,
        topK: retrieval.topK,
        minScore: retrieval.minScore,
      });

      context.logger?.debug('searchKnowledge executed', {
        query,
        retrieved: found.length,
        topScore: found[0]?.score ?? 0,
      });

      if (found.length === 0) {
        // Said plainly, because the model has to distinguish "nothing is there" from
        // "the tool failed". The first should produce an honest no-answer; the second
        // should not be its problem.
        return {
          content:
            'No relevant content found in the store knowledge base for that query. Do not guess an answer; tell the customer you could not find it.',
          chunks: [],
        };
      }

      const ranked = rankChunks(found, { maxPerSource: retrieval.maxPerSource });
      const { context: excerpts, used } = buildContext({
        chunks: ranked,
        maxContextCharacters: retrieval.maxContextCharacters,
      });

      // TEMPORARY: retrieval debug instrumentation (sources: [] investigation).
      // Remove once the empty-sources cause is confirmed. `used` is exactly the
      // `chunks` returned below - what the tool loop accumulates and what
      // `formatAnswer` turns into `sources`.
      context.logger?.debug('searchKnowledge chunks used debug', {
        query,
        rankedCount: ranked.length,
        usedCount: used.length,
        used: used.map((chunk) => ({ id: chunk.id, score: chunk.score, title: chunk.title })),
      });

      return {
        content: `Store knowledge base excerpts:\n\n${excerpts}\n\n${RULES}`,
        chunks: used,
      };
    },
  };
}
