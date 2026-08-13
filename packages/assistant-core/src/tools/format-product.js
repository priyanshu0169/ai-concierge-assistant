/**
 * How a product is described to the model.
 *
 * The wording here is not presentation, it is a constraint. A tool result is one of the two places
 * a model actually reads its instructions — the other being the system prompt — so the rules about
 * money and stock are repeated *in the data* rather than only stated once, far away, at the top of
 * the conversation.
 */

/** @param {import('../types.js').Product[]} products */
export function formatProducts(products) {
  if (products.length === 0) {
    // "Do not guess at what the store sells" used to end this message, and it ended the turn with
    // it: the model treated an empty catalogue lookup as proof there was nothing to say, when the
    // store's own website often describes the category in detail. Consulting published pages is
    // not guessing - it is the opposite - so the prohibition is now aimed where it belongs, at
    // inventing products and at quoting figures no tool returned.
    return [
      'No matching products found. Say that plainly and offer to help another way.',
      'Do not suggest a product that is not listed above.',
      'If the customer asked what kinds of products the store offers, or how products differ,',
      'call searchKnowledge before concluding: the website describes the range even when a',
      'catalogue lookup matches nothing. Never quote a price or stock level from there.',
    ].join(' ');
  }

  return ['Store products, read live just now:', '', ...products.map(describe), '', RULES].join(
    '\n',
  );
}

/** @param {import('../types.js').Product} product */
export function formatProduct(product) {
  return ['Store product, read live just now:', '', describe(product), '', RULES].join('\n');
}

/**
 * The rules, restated with every result.
 *
 * Each line exists because of a specific way a commerce assistant goes wrong, and the arithmetic
 * one is the reason this file exists at all: a model multiplying a unit price produces a
 * plausible-looking number about money, in writing, in the store's voice. It is usually right, and
 * being usually right is not good enough for a figure a customer may act on.
 *
 * This is a guarantee ShopSage cannot fully enforce - a model asked persuasively enough will still
 * do sums. The mitigations are this text, the same rule in the system prompt, and the deliberate
 * absence of any tool shaped like a calculator. See docs/adr/0028.
 */
const RULES = [
  'Rules for using this data:',
  '- Quote prices exactly as written above. Never calculate a total, a discount, a tax amount,',
  '  a saving, or a price for a different quantity. If asked, say the basket will show the total.',
  '- If a price says the tax treatment is unstated, do not claim it includes or excludes tax.',
  '- Only state availability if it is given above, and use that wording. Never infer it.',
  '- Always include the product link so the customer can check the current price themselves.',
  '- Do not mention a product that is not listed above.',
].join('\n');

/** @param {import('../types.js').Product} product */
function describe(product) {
  const lines = [`- ${product.name} (${product.sku})`];

  if (product.price !== undefined) lines.push(`  Price: ${money(product.price)}`);
  // Absent means absent. Writing "availability: unknown" invites a model to reason about why, and
  // saying nothing is what the accepted contract requires.
  if (product.availability !== undefined)
    lines.push(`  Availability: ${stock(product.availability)}`);
  if (product.summary !== undefined) lines.push(`  ${product.summary}`);

  lines.push(`  Link: ${product.url}`);

  return lines.join('\n');
}

/** @param {import('../types.js').Money} price */
function money(price) {
  // The tax treatment is spelled out in words rather than left as a flag, because "£24.00" alone is
  // what a customer will read and act on. An unstated treatment is said to be unstated: neither
  // ShopSage nor the model may infer which it is.
  if (price.taxIncluded === true) return `${price.formatted} including tax`;
  if (price.taxIncluded === false) return `${price.formatted} excluding tax`;

  return `${price.formatted} (tax treatment unstated - do not claim either)`;
}

/** @param {string} availability */
function stock(availability) {
  const wording = {
    in_stock: 'in stock',
    out_of_stock: 'out of stock',
    backorder: 'on backorder',
    unknown: 'not known - do not state availability',
  };

  return wording[/** @type {keyof typeof wording} */ (availability)] ?? availability;
}
