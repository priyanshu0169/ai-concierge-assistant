import { commerceOf, credentialOf } from './commerce-context.js';

/**
 * Recent orders, not all of them. A customer asking about an order means one they are waiting for.
 */
const MAX_ORDERS = 5;

const DESCRIPTION = [
  "Look up the signed-in customer's recent orders: status, order number, estimated delivery and",
  'tracking. Use this when they ask where their order is. Pass an order number to narrow it down.',
  'It returns no address, contact or payment details, and you must not ask the customer for any.',
].join(' ');

/**
 * Order status.
 *
 * Two things about this tool are unlike the others, and both are deliberate.
 *
 * **It takes no customer identifier.** The connector resolves identity from the forwarded session
 * token, because the connector minted it and its subject is a pseudonym by agreement
 * (docs/proposals/0001, decision 2). A tool parameter for "which customer" would be an
 * authorisation hole reachable by asking the model nicely - the model chooses arguments, so any
 * identifier in the schema is an identifier the model can be talked into changing.
 *
 * **It is scoped to `orders`, not `chat`.** A guest session never sees it, so the model cannot offer
 * order tracking to somebody who is not signed in and then fail (docs/adr/0022).
 *
 * The final line of the description is a privacy control, not manners. Asked to "verify" a customer,
 * a model will reach for an email address or a postcode - which would put exactly the data the
 * accepted contract keeps out of conversation history into it, in the customer's own words.
 *
 * @param {import('@shopsage/platform').SiteProfile} _siteProfile
 * @returns {import('../types.js').AssistantTool}
 */
export function createTrackOrderTool(_siteProfile) {
  return {
    name: 'trackOrder',
    description: DESCRIPTION,
    parameters: {
      type: 'object',
      properties: {
        reference: {
          type: 'string',
          description: 'An order number, when the customer gave one. Omit to list recent orders.',
        },
      },
    },

    async execute({ arguments: args, context }) {
      const commerce = commerceOf(context, 'trackOrder');
      const wanted = typeof args.reference === 'string' ? args.reference.trim() : '';

      const orders = await commerce.listOrders({ ...credentialOf(context) });
      // Filtered here rather than passed to the connector, because the connector only ever returns
      // this session's own orders. A reference parameter sent upstream would look like a lookup key,
      // and one day somebody would implement it as one.
      const matched = wanted === '' ? orders : orders.filter((order) => matches(order, wanted));

      context.logger?.debug('trackOrder executed', {
        // The reference itself is not logged. It is a customer's identifier for their own purchase,
        // and a count answers every operational question a reference would.
        narrowed: wanted !== '',
        available: orders.length,
        matched: matched.length,
      });

      if (orders.length === 0) {
        return {
          content:
            'This customer has no recent orders on their account. Say so, and do not ask them for personal details to look one up.',
        };
      }

      if (matched.length === 0) {
        return {
          content: `No recent order matches ${wanted}. Their recent orders are: ${orders
            .slice(0, MAX_ORDERS)
            .map((order) => order.reference)
            .join(', ')}. Ask which one they mean.`,
        };
      }

      return { content: format(matched.slice(0, MAX_ORDERS)) };
    },
  };
}

/**
 * @param {import('../types.js').Order[]} orders
 * @returns {string}
 */
function format(orders) {
  return [
    "The signed-in customer's recent orders, read live just now:",
    '',
    ...orders.map(describe),
    '',
    'Rules for using this data:',
    '- Use the status wording given. Do not estimate a delivery date that is not stated.',
    '- Give the tracking link if there is one; do not describe where the parcel is.',
    '- Never ask for or repeat an address, email address, phone number or payment detail.',
  ].join('\n');
}

/**
 * @param {import('../types.js').Order} order
 * @returns {string}
 */
function describe(order) {
  const lines = [`- Order ${order.reference}`];

  // The store's own wording first, falling back to the enum. `statusLabel` is written for a customer
  // to read; `status` is written for code, and "partially_shipped" is not a sentence.
  const status = order.statusLabel ?? order.status;

  if (status !== undefined) lines.push(`  Status: ${status}`);
  if (order.placedAt !== undefined) lines.push(`  Placed: ${order.placedAt}`);
  if (order.estimatedDelivery !== undefined) {
    lines.push(`  Estimated delivery: ${order.estimatedDelivery}`);
  }
  if (order.trackingUrl !== undefined) lines.push(`  Tracking: ${order.trackingUrl}`);
  if (order.total !== undefined) lines.push(`  Total: ${order.total.formatted}`);
  if (order.items.length > 0) {
    lines.push(
      `  Items: ${order.items.map((item) => `${item.quantity} × ${item.name}`).join(', ')}`,
    );
  }

  return lines.join('\n');
}

/**
 * Reference matching, forgiving about how a customer types it.
 *
 * Case and the separators people add or drop when reading a number off an email are not the
 * customer's mistake to pay for. Everything else must match exactly - a partial match would let one
 * order number surface another.
 *
 * @param {import('../types.js').Order} order
 * @param {string} wanted
 * @returns {boolean}
 */
function matches(order, wanted) {
  return normalise(order.reference) === normalise(wanted);
}

/**
 * @param {string} reference
 * @returns {string}
 */
function normalise(reference) {
  return reference.toLowerCase().replace(/[\s_-]/gu, '');
}
