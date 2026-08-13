import { createCartProposal, summariseLines } from '../commerce/create-cart-proposal.js';
import { commerceOf, credentialOf } from './commerce-context.js';

/**
 * Four lines and ten of anything. A model that has misunderstood tends to misunderstand at scale, and
 * a proposal for sixty of something is not a proposal a customer reads - it is one they skim.
 */
const MAX_LINES = 4;
const MAX_QUANTITY = 10;

const DESCRIPTION = [
  'Prepare items to add to the basket. This does **not** add anything: it prepares a change the',
  'customer must confirm themselves, and they will see exactly what it does. Tell them what you have',
  'prepared and ask them to confirm. Never claim the item is in their basket, and never say you have',
  'added it.',
].join(' ');

/**
 * Proposing a basket change, which is the only thing the model may do to a basket.
 *
 * The tool cannot execute. It has no access to the write port at all - `ToolContext` carries the read
 * port and a proposal store, and nothing else - so "the model must not commit" is a property of what
 * is reachable from here rather than a rule the code is trusted to follow. Execution happens in the
 * confirmation endpoint, reached by a customer clicking a button.
 *
 * Every sku is **re-read from the connector** before being proposed. A model naming a product from
 * memory, from an earlier turn, or from a customer's typo would otherwise put an unverified line in
 * front of somebody to approve, with a price nobody checked.
 *
 * See docs/adr/0029.
 *
 * @param {import('@shopsage/platform').SiteProfile} _siteProfile
 * @returns {import('../types.js').AssistantTool}
 */
export function createAddToCartTool(_siteProfile) {
  return {
    name: 'addToCart',
    description: DESCRIPTION,
    parameters: {
      type: 'object',
      properties: {
        items: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              sku: { type: 'string', description: 'A product code from a previous search result.' },
              quantity: { type: 'integer', description: `How many. 1 to ${MAX_QUANTITY}.` },
            },
            required: ['sku', 'quantity'],
          },
          description: `Up to ${MAX_LINES} items to prepare.`,
        },
      },
      required: ['items'],
    },

    async execute({ arguments: args, context }) {
      const commerce = commerceOf(context, 'addToCart');
      const requested = itemsOf(args.items);

      if (requested.length === 0) {
        return { content: 'No usable items were given. Provide a sku and a quantity for each.' };
      }

      const lines = await resolveLines({ requested, commerce, context });
      const missing = requested
        .filter((item) => !lines.some((line) => line.sku === item.sku))
        .map((item) => item.sku);

      if (lines.length === 0) {
        return {
          content: `None of those products could be found: ${missing.join(', ')}. Nothing was prepared. Use searchProducts and try again.`,
        };
      }

      const proposal = createCartProposal({
        kind: 'addToCart',
        siteId: context.siteId,
        // Both are supplied by the conversation manager. Their absence means this tool was composed
        // without a session, which cannot produce a confirmable proposal - so it fails loudly rather
        // than storing one nobody can accept.
        conversationId: required(context.conversationId, 'conversationId'),
        subject: required(context.subject, 'subject'),
        summary: summariseLines(lines),
        now: Date.now(),
        lines,
      });

      context.logger?.info('cart change proposed', {
        proposalId: proposal.id,
        kind: proposal.kind,
        lines: lines.length,
      });

      return { content: describe(proposal, missing), proposal };
    },
  };
}

/**
 * Read every requested sku from the connector, concurrently.
 *
 * @param {{
 *   requested: { sku: string, quantity: number }[],
 *   commerce: import('../types.js').CommerceCatalogue,
 *   context: import('../types.js').ToolContext,
 * }} input
 * @returns {Promise<import('../types.js').CartProposalLine[]>}
 */
async function resolveLines(input) {
  const found = await Promise.all(
    input.requested.map((item) =>
      input.commerce.findProduct({ sku: item.sku, ...credentialOf(input.context) }),
    ),
  );

  /** @type {import('../types.js').CartProposalLine[]} */
  const lines = [];

  found.forEach((product, index) => {
    if (product === undefined) return;

    lines.push({
      sku: product.sku,
      // The connector's name, not the model's phrasing. The customer confirms against what the store
      // calls the product.
      name: product.name,
      quantity: input.requested[index].quantity,
      ...(product.price === undefined ? {} : { price: product.price }),
      url: product.url,
    });
  });

  return lines;
}

/**
 * @param {import('../types.js').CartProposal} proposal
 * @param {string[]} missing
 * @returns {string}
 */
function describe(proposal, missing) {
  return [
    'Prepared, and **not** added. The customer must confirm it themselves:',
    '',
    proposal.summary,
    '',
    ...(missing.length === 0
      ? []
      : [`Could not be found and was left out: ${missing.join(', ')}.`, '']),
    'Tell them what you have prepared and ask them to confirm. A confirmation button is shown to them',
    'automatically, so do not ask for a sku or a yes/no reply, and do not offer to do it for them.',
    'Do not say the item is in their basket - it is not, and will not be until they confirm.',
    'Do not state a total; the basket will show it.',
  ].join('\n');
}

/**
 * @param {unknown} value
 * @returns {{ sku: string, quantity: number }[]}
 */
function itemsOf(value) {
  if (!Array.isArray(value)) return [];

  /** @type {Map<string, { sku: string, quantity: number }>} */
  const bySku = new Map();

  for (const entry of value) {
    const sku = typeof entry?.sku === 'string' ? entry.sku.trim() : '';

    if (sku === '' || bySku.has(sku)) continue;

    bySku.set(sku, { sku, quantity: quantityOf(entry.quantity) });
  }

  return [...bySku.values()].slice(0, MAX_LINES);
}

/**
 * @param {unknown} value
 * @returns {number}
 */
function quantityOf(value) {
  // A missing or nonsensical quantity becomes one rather than failing the call. One is what a customer
  // means by "add it", and it is the choice that cannot surprise anybody - the alternative would be
  // guessing upward.
  if (!Number.isInteger(value) || Number(value) < 1) return 1;

  return Math.min(Number(value), MAX_QUANTITY);
}

/**
 * @template T
 * @param {T | undefined} value
 * @param {string} name
 * @returns {T}
 */
function required(value, name) {
  if (value === undefined) {
    throw new Error(`addToCart needs ${name} in its tool context to build a confirmable proposal`);
  }

  return value;
}
