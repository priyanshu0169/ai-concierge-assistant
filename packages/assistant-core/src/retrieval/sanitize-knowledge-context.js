/**
 * Dynamic commerce values, removed on the way out of the knowledge base.
 *
 * ## What this is for
 *
 * The knowledge corpus is a crawl of the store's own website, so it is **eventually consistent by
 * construction**: a page indexed on Tuesday says whatever it said on Tuesday. That is fine for the
 * things the corpus exists to answer - what products exist, how they differ, where they come from,
 * how to serve them - because those stay true for months.
 *
 * It is not fine for anything transactional. A price, a stock level, a coupon or a delivery
 * estimate is only true at the moment it is read, and the live catalogue owns all of them
 * (docs/adr/0028). A figure quoted from an indexed page is a number about money, in writing, in the
 * store's own voice, and possibly wrong - the most damaging output this system can produce.
 *
 * ## Why this is code and not an instruction
 *
 * It was an instruction first, in three places at once: the system prompt, the `searchKnowledge`
 * tool description, and the commerce rules. A live model quoted "$95", "$100" and "$215" from
 * indexed pages anyway, on the first realistic question asked of it.
 *
 * It was not disobeying. The commerce rule said "quote prices exactly as **a tool** returned
 * them", and `searchKnowledge` *is* a tool - so the rule licensed the behaviour it was written to
 * prevent. That specific wording is fixed now, but the lesson generalises: instruction-following is
 * a distribution, not a guarantee, and a leaked price looks exactly like a correct one. Nothing
 * alerts.
 *
 * So this follows the precedent set for cart writes in docs/adr/0029, where the model cannot commit
 * a change because the write port is not in its reach: **the model cannot quote a price because no
 * price reaches it.** A property of what is available, rather than a rule to be trusted with.
 *
 * ## Why here, and not at ingestion
 *
 * Stripping during ingestion would give the same guarantee and cost nothing at run time, but it
 * destroys the corpus copy of information the store genuinely published. Two requirements sit at
 * two different layers and only one of them is about the model:
 *
 * - The **corpus** should be faithful to the source: debuggable, re-purposable, and changeable in
 *   policy without a re-crawl.
 * - The **context** should contain no transactional values at all.
 *
 * Masking on the way out satisfies both. It also means a policy change takes effect on the next
 * request rather than after a re-ingestion, which matters while the policy is still being settled.
 *
 * Note that this deliberately masks a price in a *buying guide* as readily as one in a product
 * listing. "Beluga typically runs $200-400/oz" is exactly as stale as a listing price; the sentence
 * is worth keeping in the corpus, and is not worth handing to a model as though it were current.
 *
 * ## Adding a value type
 *
 * Add an entry to `DYNAMIC_VALUES`. Each rule is a label, a pattern and the marker that replaces a
 * match. The marker is deliberately short - it can appear many times in one chunk - and says what
 * is missing rather than pretending nothing was there, because a silent deletion invites a model to
 * reconstruct the number from context.
 */

/**
 * The value types removed from knowledge before it reaches the model.
 *
 * Only `price` is implemented, because it is the only one this corpus currently carries: a scan of
 * all 4,174 chunks found 10,183 price tokens in exactly two shapes, and no stock, coupon or
 * delivery language at all. The others are listed as the extension points they will become rather
 * than written speculatively against text nobody has seen - a pattern guessed at now would be
 * untested against real input and would give false confidence.
 *
 * @type {readonly { label: string, pattern: RegExp, marker: string }[]}
 */
const DYNAMIC_VALUES = Object.freeze([
  {
    label: 'price',
    // Both observed shapes in one pattern: a bare amount (`$11`, `$1,250.00`) and a listing's
    // "from" form (`FROM $16`). The optional prefix is consumed with the amount so the replacement
    // reads as a phrase rather than leaving a dangling "FROM".
    //
    // Currency is `$` only, matching this corpus. A `£` or `€` store would add its symbol here; the
    // instruction backstop in the tool result covers a format this misses in the meantime.
    pattern: /(?:\bfrom\s+)?\$\s?\d[\d,]*(?:\.\d{2})?/giu,
    marker: '[price not shown]',
  },
]);

/**
 * @typedef {object} SanitizedKnowledge
 * @property {import('../types.js').RetrievedChunk[]} chunks Safe to put in front of a model.
 * @property {string[]} removed Value types found, for a log line. Never the values themselves.
 */

/**
 * Remove every dynamic commerce value from retrieved knowledge.
 *
 * **The single place** where this happens. Applied at the retrieval boundary rather than inside any
 * one tool, so a tool added later cannot reintroduce the leak by forgetting to call it: what the
 * domain receives is already clean.
 *
 * Pure - returns new chunks and never mutates its input, so a caller holding the originals (a test,
 * a future feature that legitimately wants the raw text) still has them.
 *
 * @param {import('../types.js').RetrievedChunk[]} chunks
 * @returns {SanitizedKnowledge}
 */
export function sanitizeKnowledgeContext(chunks) {
  if (!Array.isArray(chunks)) return { chunks: [], removed: [] };

  /** @type {Set<string>} */
  const removed = new Set();

  const sanitized = chunks.map((chunk) => {
    const text = sanitizeValue(chunk.text, removed);
    const title = sanitizeValue(chunk.title, removed);
    const headingPath =
      chunk.headingPath === undefined ? undefined : sanitizeValue(chunk.headingPath, removed);

    // Every field a chunk can carry into the prompt is covered, not just `text`: a product page's
    // own title routinely ends in its price, and that title is rendered into the context as an
    // excerpt label by `buildContext`.
    return {
      ...chunk,
      text,
      title,
      ...(headingPath === undefined ? {} : { headingPath }),
    };
  });

  return { chunks: sanitized, removed: [...removed] };
}

/**
 * Apply every rule to one string, recording which ones matched.
 *
 * @param {string} value
 * @param {Set<string>} removed Mutated: this is the accumulator across a whole context.
 * @returns {string}
 */
function sanitizeValue(value, removed) {
  if (typeof value !== 'string' || value === '') return value;

  let current = value;

  for (const rule of DYNAMIC_VALUES) {
    current = current.replace(rule.pattern, () => {
      removed.add(rule.label);

      return rule.marker;
    });
  }

  return current;
}
