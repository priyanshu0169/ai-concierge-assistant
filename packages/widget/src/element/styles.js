import { PROPOSAL_STYLES } from './proposal-styles.js';

/**
 * The widget's stylesheet, scoped by its shadow root.
 *
 * **Every value a host might want to change is a custom property**, and custom properties are
 * the one thing that pierces a shadow boundary. That is the whole theming story: a host writes
 * `shopsage-widget { --shopsage-accent: #b91c1c; }` in its own stylesheet and the panel
 * follows, without the host needing to know a single class name. Nothing else about the
 * internals is reachable, which is the trade — a host cannot restyle the layout, and equally
 * cannot break it with a global `* { box-sizing: content-box }`.
 *
 * The defaults come from the site profile via `GET /v1/config`, so a store's brand colours
 * arrive as inline custom properties on the host element and a page author can still override
 * them. Precedence lands the right way round: profile as the default, host CSS wins.
 *
 * A single string rather than a constructed stylesheet object: `adoptedStyleSheets` needs a
 * feature check and a fallback anyway, and a `<style>` element in the shadow root works
 * everywhere the rest of this relies on.
 */
export const STYLES = `
:host {
  /* Theming surface. A host overrides any of these; nothing else here is reachable. */
  --shopsage-primary: #111827;
  --shopsage-accent: #2563eb;
  --shopsage-surface: #ffffff;
  --shopsage-on-surface: #1f2937;
  --shopsage-muted: #6b7280;
  --shopsage-border: #e5e7eb;
  --shopsage-code-surface: #f3f4f6;
  --shopsage-radius: 12px;
  --shopsage-font: system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif;
  --shopsage-panel-width: 380px;
  --shopsage-panel-height: 560px;
  --shopsage-z-index: 2147483000;
  --shopsage-edge-gap: 20px;

  position: fixed;
  bottom: var(--shopsage-edge-gap);
  z-index: var(--shopsage-z-index);
  font-family: var(--shopsage-font);
  font-size: 15px;
  line-height: 1.5;
  color: var(--shopsage-on-surface);
  /* The host page's box-sizing must not reach in, and ours must not leak out. */
  box-sizing: border-box;
}

:host([hidden]) { display: none; }
:host(:not([data-position='bottom-left'])) { right: var(--shopsage-edge-gap); }
:host([data-position='bottom-left']) { left: var(--shopsage-edge-gap); }

*, *::before, *::after { box-sizing: inherit; }

button {
  font: inherit;
  color: inherit;
  cursor: pointer;
  border: 0;
  background: none;
}

/* A visible focus ring on every interactive element, in the accent colour so it survives
   rebranding. Removing outlines is the single most common accessibility regression. */
:where(button, a, textarea, [tabindex]):focus-visible {
  outline: 2px solid var(--shopsage-accent);
  outline-offset: 2px;
  border-radius: 4px;
}

.launcher {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 12px 18px;
  border-radius: 999px;
  background: var(--shopsage-primary);
  color: #fff;
  box-shadow: 0 6px 20px rgb(0 0 0 / 18%);
  transition: transform 120ms ease;
}
.launcher:hover { transform: translateY(-1px); }
.launcher[hidden] { display: none; }

.panel {
  display: flex;
  flex-direction: column;
  width: var(--shopsage-panel-width);
  height: var(--shopsage-panel-height);
  max-height: calc(100vh - (var(--shopsage-edge-gap) * 2));
  background: var(--shopsage-surface);
  border: 1px solid var(--shopsage-border);
  border-radius: var(--shopsage-radius);
  box-shadow: 0 12px 40px rgb(0 0 0 / 18%);
  overflow: hidden;
}
.panel[hidden] { display: none; }

.header {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 12px 14px;
  background: var(--shopsage-primary);
  color: #fff;
  flex: 0 0 auto;
}
.header h2 { margin: 0; font-size: 15px; font-weight: 600; }
.header .spacer { flex: 1; }
.header button { color: #fff; padding: 6px; line-height: 0; border-radius: 6px; }
.avatar { width: 26px; height: 26px; border-radius: 50%; object-fit: cover; }

.transcript {
  flex: 1 1 auto;
  overflow-y: auto;
  padding: 14px;
  display: flex;
  flex-direction: column;
  gap: 12px;
  /* Momentum scrolling inside the panel, without the page scrolling behind it. */
  overscroll-behavior: contain;
}

.message { display: flex; flex-direction: column; gap: 6px; max-width: 88%; }
.message[data-role='user'] { align-self: flex-end; align-items: flex-end; }
.message[data-role='assistant'] { align-self: flex-start; }

.bubble {
  padding: 9px 12px;
  border-radius: var(--shopsage-radius);
  background: var(--shopsage-code-surface);
  overflow-wrap: anywhere;
}
.message[data-role='user'] .bubble { background: var(--shopsage-accent); color: #fff; }

.bubble > :first-child { margin-top: 0; }
.bubble > :last-child { margin-bottom: 0; }
.bubble p { margin: 0 0 8px; }
.bubble h1, .bubble h2, .bubble h3 { margin: 10px 0 6px; font-size: 1em; font-weight: 600; }
.bubble ul, .bubble ol { margin: 0 0 8px; padding-left: 20px; }
.bubble li { margin: 2px 0; }
.bubble a { color: inherit; text-decoration: underline; }
.bubble code {
  font-family: ui-monospace, 'SF Mono', Menlo, Consolas, monospace;
  font-size: 0.9em;
  background: rgb(0 0 0 / 7%);
  padding: 1px 4px;
  border-radius: 4px;
}
.bubble pre {
  margin: 8px 0;
  padding: 10px;
  border-radius: 8px;
  background: var(--shopsage-primary);
  color: #f9fafb;
  /* Scrolls on its own rather than widening the panel, which is what keeps a long line from
     breaking the layout on a phone. */
  overflow-x: auto;
}
.bubble pre code { background: none; padding: 0; color: inherit; }

.sources { display: flex; flex-wrap: wrap; gap: 6px; }
.sources a {
  font-size: 12px;
  padding: 3px 8px;
  border: 1px solid var(--shopsage-border);
  border-radius: 999px;
  color: var(--shopsage-muted);
  text-decoration: none;
  background: var(--shopsage-surface);
}
.sources a:hover { color: var(--shopsage-accent); border-color: var(--shopsage-accent); }

${PROPOSAL_STYLES}

.status { font-size: 13px; color: var(--shopsage-muted); display: flex; align-items: center; gap: 7px; }
.status[hidden] { display: none; }
.dots { display: inline-flex; gap: 3px; }
.dots i { width: 5px; height: 5px; border-radius: 50%; background: currentColor; animation: pulse 1.2s infinite; }
.dots i:nth-child(2) { animation-delay: 0.15s; }
.dots i:nth-child(3) { animation-delay: 0.3s; }

@keyframes pulse { 0%, 60%, 100% { opacity: 0.25; } 30% { opacity: 1; } }

/* A customer who has asked not to see motion gets a static indicator, not a missing one. */
@media (prefers-reduced-motion: reduce) {
  .dots i { animation: none; opacity: 0.6; }
  .launcher { transition: none; }
}

.prompts { display: flex; flex-wrap: wrap; gap: 6px; padding: 0 14px 10px; flex: 0 0 auto; }
.prompts[hidden] { display: none; }
.prompts button {
  font-size: 13px;
  padding: 6px 11px;
  border: 1px solid var(--shopsage-border);
  border-radius: 999px;
  color: var(--shopsage-on-surface);
  background: var(--shopsage-surface);
}
.prompts button:hover { border-color: var(--shopsage-accent); color: var(--shopsage-accent); }

.composer {
  display: flex;
  align-items: flex-end;
  gap: 8px;
  padding: 10px;
  border-top: 1px solid var(--shopsage-border);
  flex: 0 0 auto;
}
.composer textarea {
  flex: 1;
  resize: none;
  border: 1px solid var(--shopsage-border);
  border-radius: 8px;
  padding: 8px 10px;
  font: inherit;
  color: inherit;
  background: var(--shopsage-surface);
  max-height: 96px;
}
.composer button[type='submit'] {
  padding: 8px 14px;
  border-radius: 8px;
  background: var(--shopsage-accent);
  color: #fff;
  font-weight: 500;
}
.composer button[disabled] { opacity: 0.5; cursor: default; }

.counter { font-size: 11px; color: var(--shopsage-muted); padding: 0 10px 8px; text-align: right; }
.counter[hidden] { display: none; }

/* Announcements for assistive technology, positioned off-screen rather than hidden:
   display:none and visibility:hidden both remove a live region from the accessibility tree,
   which is the classic way to ship one that never announces anything. */
.sr-only {
  position: absolute;
  width: 1px;
  height: 1px;
  margin: -1px;
  padding: 0;
  overflow: hidden;
  clip: rect(0 0 0 0);
  white-space: nowrap;
  border: 0;
}

/* Full screen below the breakpoint. A 380px panel inside a 375px viewport leaves a customer
   pinching to reach the send button. */
@media (max-width: 480px) {
  :host {
    inset: 0;
    bottom: 0;
  }
  :host(:not([data-position='bottom-left'])),
  :host([data-position='bottom-left']) { right: 0; left: 0; }
  .panel {
    width: 100vw;
    height: 100%;
    max-height: none;
    border: 0;
    border-radius: 0;
  }
  .launcher {
    position: fixed;
    bottom: var(--shopsage-edge-gap);
    right: var(--shopsage-edge-gap);
  }
}

@media (prefers-color-scheme: dark) {
  :host {
    --shopsage-surface: #111827;
    --shopsage-on-surface: #f3f4f6;
    --shopsage-border: #374151;
    --shopsage-code-surface: #1f2937;
    --shopsage-muted: #9ca3af;
  }
}
`;
