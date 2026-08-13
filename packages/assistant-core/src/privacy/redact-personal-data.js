/**
 * Personal data, removed on the way into storage.
 *
 * ## What this is for
 *
 * Conversation history is the one place in ShopSage where free text is **retained**. Everything else
 * is transient: a prompt is built and discarded, a log line is structurally redacted, a tool result
 * lives for one turn. History outlives the conversation, so a customer who types a card number into
 * a chat box - and they do, when an assistant mentions payment - has created a retention problem out
 * of a typing habit.
 *
 * So this runs at the moment of writing, not at the moment of reading. The customer still sees what
 * they typed; the model still answered the real question. Only the copy that outlives the turn is
 * reduced.
 *
 * ## What it honestly cannot do
 *
 * **Free-text addresses are not reliably detectable and this does not claim to detect them.** "34
 * Bridge Street, flat 2" has no structure a regex can lock onto that "34 pairs, size 2" does not
 * also match. A detector aggressive enough to catch it would shred ordinary product questions, and a
 * detector tuned not to would catch almost nothing while looking like protection. Pretending
 * otherwise would be worse than the gap, because a control believed to work stops being reviewed.
 *
 * The real defence against addresses is structural and it is elsewhere: `trackOrder` never fetches
 * one, the order type has no field for one, and the tool tells the model not to ask. What is never
 * requested is never typed.
 *
 * Three things *are* detectable because they have real structure, and each is here because it is
 * both plausible in a shopping conversation and genuinely damaging to keep.
 */

const PLACEHOLDER = '[removed]';

/**
 * The detectors, in the order they run. Order is load-bearing: a card number is also a long run of
 * digits, so it must be claimed before the phone pattern gets to it.
 *
 * @type {readonly { label: string, pattern: RegExp, confirm?: (match: string) => boolean }[]}
 */
const DETECTORS = Object.freeze([
  {
    label: 'email',
    // Deliberately loose on the local part and strict on the shape. Anything with an @ and a dotted
    // domain is an address for this purpose - correctness as an RFC parser is not the goal, and a
    // near-miss address is just as identifying as a valid one.
    pattern: /[^\s<>@]+@[^\s<>@]+\.[a-z]{2,}/giu,
  },
  {
    label: 'payment card',
    // 13 to 19 digits, in the groupings people type them in. The Luhn check is what makes this safe
    // to apply: without it, a 16-digit order reference or a product code would be redacted, and a
    // customer would watch their own question get mangled in the next reply.
    pattern: /\b(?:\d[ -]?){12,18}\d\b/gu,
    confirm: (match) => passesLuhn(match.replace(/[ -]/gu, '')),
  },
  {
    label: 'phone number',
    // Two shapes only: an international number, or a 10-to-11 digit national number starting with a
    // trunk zero. Both are structured enough to be worth acting on. Anything shorter is where order
    // references, quantities and product codes live, and this stays out of that range on purpose -
    // a false positive here corrupts a legitimate question.
    pattern: /\+\d[\d\s-]{7,15}\d|\b0\d[\d\s-]{7,11}\d\b/gu,
    confirm: (match) => {
      const digits = match.replace(/\D/gu, '');

      return digits.length >= 10 && digits.length <= 15;
    },
  },
]);

/**
 * @typedef {object} Redaction
 * @property {string} text Safe to store.
 * @property {string[]} removed Categories found, for a log line. Never the values.
 */

/**
 * @param {string} text
 * @returns {Redaction}
 */
export function redactPersonalData(text) {
  /** @type {Set<string>} */
  const removed = new Set();

  // URLs are excluded from redaction, and this is the reason: a tracking link legitimately contains
  // a long run of digits, and roughly one in ten such runs passes a Luhn check by chance. Redacting
  // part of a URL would break a link that a customer needs, to protect data that was never there.
  const redacted = mapOutsideUrls(text, (span) => {
    let current = span;

    for (const detector of DETECTORS) {
      current = current.replace(detector.pattern, (match) => {
        if (detector.confirm !== undefined && !detector.confirm(match)) return match;

        removed.add(detector.label);

        return PLACEHOLDER;
      });
    }

    return current;
  });

  return { text: redacted, removed: [...removed] };
}

/**
 * A turn, with its content reduced to what may be retained.
 *
 * Applied to **assistant** turns as well as customer ones, which is not belt-and-braces. An
 * assistant repeats what it was told - "just to confirm, that was 07700 900123?" - so redacting only
 * the customer's side would leave the same string in history one message further down.
 *
 * @param {import('../types.js').ConversationTurn} turn
 * @returns {{ turn: import('../types.js').ConversationTurn, removed: string[] }}
 */
export function redactTurn(turn) {
  const { text, removed } = redactPersonalData(turn.content);

  return { turn: removed.length === 0 ? turn : { ...turn, content: text }, removed };
}

/**
 * Apply a transform to everything that is not a URL.
 *
 * @param {string} text
 * @param {(span: string) => string} transform
 * @returns {string}
 */
function mapOutsideUrls(text, transform) {
  const urls = /https?:\/\/\S+/giu;
  const parts = [];
  let cursor = 0;

  for (const match of text.matchAll(urls)) {
    const start = match.index ?? 0;

    parts.push(transform(text.slice(cursor, start)), match[0]);
    cursor = start + match[0].length;
  }

  parts.push(transform(text.slice(cursor)));

  return parts.join('');
}

/**
 * The Luhn checksum, which every payment card satisfies and arbitrary digit runs mostly do not.
 *
 * Not a validity check in any useful sense - it says nothing about whether a card exists. It is used
 * here purely as a cheap filter that turns "a long number" into "a long number shaped like a card",
 * which is the difference between a redactor that is safe to run on every message and one that is
 * not.
 *
 * @param {string} digits
 * @returns {boolean}
 */
function passesLuhn(digits) {
  let sum = 0;
  let double = false;

  for (let index = digits.length - 1; index >= 0; index -= 1) {
    let value = digits.charCodeAt(index) - 48;

    if (double) {
      value *= 2;
      if (value > 9) value -= 9;
    }

    sum += value;
    double = !double;
  }

  return sum % 10 === 0;
}
