const ROLES = new Set(['user', 'assistant']);

/**
 * @param {import('@shopsage/assistant-core').ConversationTurn} turn
 * @returns {string}
 */
export function encodeTurn(turn) {
  return JSON.stringify({ role: turn.role, content: turn.content, at: turn.at });
}

/**
 * Decode what a list entry claims to be, returning `undefined` for anything else.
 *
 * Defensive on purpose. This is a **shared datastore**: entries survive deploys, so a
 * running instance will read what a previous version wrote, and nothing stops an operator
 * from poking at a key by hand. Trusting the shape means one malformed entry throws inside
 * a customer's question, and it would keep throwing on every turn of that conversation
 * until someone found and deleted the key.
 *
 * Skipping a bad entry loses one message; failing loses the conversation.
 *
 * @param {string} raw
 * @returns {import('@shopsage/assistant-core').ConversationTurn | undefined}
 */
export function decodeTurn(raw) {
  const parsed = parseJson(raw);

  if (parsed === undefined || typeof parsed !== 'object' || parsed === null) return undefined;

  const { role, content, at } = /** @type {Record<string, unknown>} */ (parsed);

  if (typeof role !== 'string' || !ROLES.has(role)) return undefined;
  if (typeof content !== 'string' || typeof at !== 'string') return undefined;

  return { role: /** @type {'user' | 'assistant'} */ (role), content, at };
}

/**
 * @param {string} raw
 * @returns {unknown}
 */
function parseJson(raw) {
  try {
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
}
