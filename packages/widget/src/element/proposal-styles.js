/**
 * The confirmation card's styles, split out of `styles.js`.
 *
 * A separate module because `styles.js` outgrew the 250-line limit, and the limit was right to push
 * back: the confirmation is the one part of this widget that is a control rather than a view, and it
 * reads better as its own thing than as a section three hundred lines down a stylesheet.
 *
 * Themed through the same custom properties as everything else, so a store restyles it with the accent
 * it has already set and never needs to know these class names exist.
 */
export const PROPOSAL_STYLES = `
/* Deliberately unlike a message bubble - a border, a surface tint, its own heading - because it is not
 * one. It is a decision, and a customer skimming a conversation must be able to tell at a glance that
 * this block does something rather than says something. */
.proposal {
  align-self: stretch;
  border: 1px solid var(--shopsage-border);
  border-radius: var(--shopsage-radius);
  padding: 12px 14px;
  background: var(--shopsage-code-surface);
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.proposal-heading { margin: 0; font-weight: 600; font-size: 0.9375rem; }
.proposal-summary { margin: 0; white-space: pre-line; font-size: 0.875rem; }
.proposal-lines { margin: 0; padding-left: 18px; font-size: 0.875rem; display: grid; gap: 2px; }
.proposal-price { color: var(--shopsage-muted); }
.proposal-actions { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
.proposal-confirm {
  font: inherit;
  font-weight: 600;
  padding: 8px 18px;
  border: 0;
  border-radius: 999px;
  background: var(--shopsage-accent);
  color: #ffffff;
  cursor: pointer;
  /* Comfortably past the 44px minimum on the cross axis once padding is counted. A mis-tap on this
   * particular button costs money. */
  min-height: 40px;
}
.proposal-confirm:disabled { opacity: 0.65; cursor: default; }
/* The focus ring is never removed. This is the last control anybody should have to hunt for with a
 * keyboard. */
.proposal-confirm:focus-visible { outline: 2px solid var(--shopsage-primary); outline-offset: 2px; }
.proposal-expiry { color: var(--shopsage-muted); font-size: 0.75rem; }
.proposal-status { margin: 0; font-size: 0.875rem; font-weight: 500; }
`;
