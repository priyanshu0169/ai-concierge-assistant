import { identityValues, renderTemplate } from './render-template.js';

/**
 * Instructions the *platform* adds, on top of whatever a store wrote.
 *
 * Deliberately about mechanics rather than tone or policy: a store owns its voice and
 * its grounding rules through `prompts.systemPrompt`, but no store should have to
 * discover by trial that it must describe its own tool-calling protocol. Duplicating
 * grounding rules here would also mean two places to change them, and the store's copy
 * losing.
 *
 * @param {string[]} toolNames
 * @returns {string}
 */
function toolProtocol(toolNames) {
  if (toolNames.length === 0) return '';

  return [
    '',
    '',
    'You have tools available. Use them before answering any question about this store:',
    `available tools: ${toolNames.join(', ')}.`,
    'Never answer a factual question about products, policies, shipping or returns from',
    'your own knowledge. Call a tool first.',
    // Previously this ended "if a tool returns nothing relevant, say you could not find the
    // answer rather than guessing", which conflated two different situations: nothing exists,
    // and the first tool asked was the wrong one. A model reading it stopped after a single
    // failed lookup. Trying a second, better-suited tool is not guessing, and the loop is
    // bounded anyway (docs/adr/0022), so exhausting the options costs at most a round.
    'If one tool fails or returns nothing relevant, try another tool that could plausibly',
    'hold the answer before concluding. Only once no tool has it, say you could not find it -',
    'plainly, without guessing and without implying the thing asked about does not exist.',
    ...commerceRules(toolNames),
  ].join('\n');
}

/**
 * The rules that apply once money is in play.
 *
 * Added by the **platform**, not left to a store's own prompt, and that is the decision worth
 * defending. A store writes its voice; it should not have to know that a model will cheerfully
 * multiply a unit price and present the result as a total. Every store gets these, and a store
 * cannot accidentally omit them by rewriting its prompt.
 *
 * Repeated in each commerce tool result as well (see `format-product.js`). Duplication is
 * deliberate here where it is avoided elsewhere: instructions at the top of a long conversation
 * lose against fresh content further down, and these are the ones where being ignored produces a
 * wrong number about money in the store's own voice.
 *
 * Only added when a commerce tool is actually present. A knowledge-only store gets no rules about
 * prices, because prompt text that describes capabilities the model does not have invites it to
 * invent them.
 *
 * @param {string[]} toolNames
 * @returns {string[]}
 */
function commerceRules(toolNames) {
  const live = toolNames.filter((name) => COMMERCE_TOOLS.has(name));

  if (live.length === 0) return [];

  return [
    '',
    'When prices, stock or orders are involved:',
    // This said "exactly as a tool returned them", which licensed the very leak the rule exists to
    // prevent: searchKnowledge is a tool, so a model quoting an indexed page's price was following
    // it correctly. The live tools are named explicitly now - and named from `live` rather than
    // hard-coded, because a session without the `orders` scope has no trackOrder and must not read
    // about one. Naming a capability the model does not have invites it to invent one, which is
    // the same rule this function's own guard already applies (docs/adr/0022).
    //
    // Retrieved knowledge is masked before it reaches the model as well
    // (sanitize-knowledge-context.js); this is the backstop for a format the mask does not
    // recognise, not the guarantee.
    `- Quote prices, availability and delivery dates only as ${list(live)} returned them.`,
    '  Never take a price, a stock level or a delivery date from searchKnowledge: those pages are',
    '  indexed periodically and may be out of date.',
    '- Never work out a total, a discount, a saving, a tax amount, or the price of a different',
    '  quantity. Do no arithmetic on money at all. Say the basket or checkout will show the total.',
    // The specific question that defeated the general rule in testing. "Which is cheaper" is a
    // comparison and is allowed; "by how much" is a subtraction, and a model reads the two as one
    // request unless they are separated here in as many words.
    '- If asked which of two products is cheaper, name it. Never say by how much, and never give a',
    '  difference, a percentage or a multiple - state both prices and let the customer read them.',
    '- Never state or imply availability that a tool did not state.',
    '- Never ask for an address, email address, phone number, or any payment detail, and never',
    '  repeat one back if a customer volunteers it.',
  ];
}

/**
 * Join names the way a sentence would, so the rule reads as prose rather than as a config dump.
 *
 * @param {string[]} names
 * @returns {string}
 */
function list(names) {
  if (names.length === 1) return names[0];

  return `${names.slice(0, -1).join(', ')} or ${names[names.length - 1]}`;
}

/**
 * Which tool names mean money is in play. A set rather than a prefix check, so a future tool has to
 * be added here on purpose rather than by being named the right way.
 */
const COMMERCE_TOOLS = new Set([
  'searchProducts',
  'compareProducts',
  'recommendProducts',
  'trackOrder',
]);

/**
 * Assemble the message list for one turn.
 *
 * Order is load-bearing. The system prompt comes first, then bounded history, then the
 * customer's question last - a model attends most reliably to the end of its input, and
 * the question is the thing it must answer.
 *
 * Retrieved content is **not** placed here. It arrives as a tool result inside the loop
 * (docs/adr/0010), which is what lets the model ask a second, better question when the
 * first search misses.
 *
 * @param {{
 *   siteProfile: import('@shopsage/platform').SiteProfile,
 *   history: import('../types.js').ConversationTurn[],
 *   message: string,
 *   toolNames: string[],
 * }} input
 * @returns {import('@shopsage/llm-client').LlmMessage[]}
 */
export function buildMessages(input) {
  const { siteProfile, history, message, toolNames } = input;

  const systemPrompt =
    renderTemplate(siteProfile.prompts.systemPrompt, identityValues(siteProfile)) +
    toolProtocol(toolNames);

  return [
    { role: 'system', content: systemPrompt },
    ...history.map((turn) => ({ role: turn.role, content: turn.content })),
    { role: 'user', content: message },
  ];
}
