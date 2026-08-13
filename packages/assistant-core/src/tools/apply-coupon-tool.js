import { createCartProposal } from '../commerce/create-cart-proposal.js';

/**
 * Coupon codes are short and shaped like codes. A 200-character "code" is somebody probing.
 */
const MAX_CODE_LENGTH = 40;
const CODE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]*$/u;

const DESCRIPTION = [
  'Prepare a discount code to apply to the basket. This does **not** apply it: it prepares a change',
  'the customer must confirm themselves. Never say whether a code is valid, what it is worth, or what',
  'the new total would be - only the store can say, and it will say when the code is applied.',
].join(' ');

/**
 * Proposing a coupon, which is the only thing the model may do with one.
 *
 * The description spends most of its words on what **not** to say, and each of those sentences is
 * about a specific way this goes wrong. Asked "will BLACKFRIDAY work?", a model will happily say yes -
 * it has seen a thousand plausible coupon codes - and a customer told a code is valid by the store's
 * own assistant has been misled by the store. ShopSage cannot know: validity, value and eligibility
 * live in Magento's promotion rules and are only knowable by applying the code.
 *
 * So the tool **does not validate the code** beyond its shape. Rejecting a code that looks wrong would
 * be ShopSage inventing a rule about somebody else's promotions; the connector is the authority, and
 * the customer hears its wording rather than a guess.
 *
 * See docs/adr/0029.
 *
 * @param {import('@shopsage/platform').SiteProfile} _siteProfile
 * @returns {import('../types.js').AssistantTool}
 */
export function createApplyCouponTool(_siteProfile) {
  return {
    name: 'applyCoupon',
    description: DESCRIPTION,
    parameters: {
      type: 'object',
      properties: {
        code: {
          type: 'string',
          description: 'The code exactly as the customer gave it. Do not invent or correct one.',
        },
      },
      required: ['code'],
    },

    /**
     * Not `async`, and that is worth noticing rather than tidying away: this tool touches **no**
     * connector. It cannot, because whether a code is valid is only knowable by applying it, and
     * applying it is what the customer has not agreed to yet. `addToCart` reads every sku before
     * proposing; there is no equivalent read for a coupon.
     */
    execute({ arguments: args, context }) {
      const code = codeOf(args.code);

      if (code === undefined) {
        return Promise.resolve({
          content:
            'That is not a usable discount code. Ask the customer to type it exactly as they have it, and do not guess one.',
        });
      }

      const proposal = createCartProposal({
        kind: 'applyCoupon',
        siteId: context.siteId,
        conversationId: required(context.conversationId, 'conversationId'),
        subject: required(context.subject, 'subject'),
        // The code and nothing else. No claim about what it does, because nothing here knows.
        summary: `Apply discount code ${code}`,
        now: Date.now(),
        code,
      });

      // The code itself is not logged. A working promotional code is worth something, and a log is
      // read by more people and kept longer than anybody thinks when they add the field.
      context.logger?.info('cart change proposed', {
        proposalId: proposal.id,
        kind: proposal.kind,
      });

      return Promise.resolve({ content: describe(code), proposal });
    },
  };
}

/**
 * @param {string} code
 * @returns {string}
 */
function describe(code) {
  return [
    `Prepared, and **not** applied: discount code ${code}.`,
    '',
    'Tell them you have prepared it and ask them to confirm. A confirmation button is shown to them',
    'automatically. You do not know whether this code is valid, what it is worth, whether it applies to',
    'their basket, or what the new total would be - do not say or imply any of it. The store will say',
    'when the code is applied.',
  ].join('\n');
}

/**
 * @param {unknown} value
 * @returns {string | undefined}
 */
function codeOf(value) {
  if (typeof value !== 'string') return undefined;

  const trimmed = value.trim();

  // Shape only, never plausibility. The pattern exists so a code cannot carry whitespace or punctuation
  // into a URL path; whether the code means anything is Magento's to answer.
  if (trimmed.length === 0 || trimmed.length > MAX_CODE_LENGTH) return undefined;

  return CODE_PATTERN.test(trimmed) ? trimmed : undefined;
}

/**
 * @template T
 * @param {T | undefined} value
 * @param {string} name
 * @returns {T}
 */
function required(value, name) {
  if (value === undefined) {
    throw new Error(
      `applyCoupon needs ${name} in its tool context to build a confirmable proposal`,
    );
  }

  return value;
}
