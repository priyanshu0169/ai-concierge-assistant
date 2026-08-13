# Widget

`@shopsage/widget` — the embeddable assistant. A native custom element in a shadow root: no
framework, no runtime imposed on the host, no build step asked of it.

**23 kB minified, zero dependencies, one script tag.**

## Integration

```html
<script
  src="https://cdn.example.com/shopsage.js"
  data-backend-url="https://assistant.example.com"
  data-token-url="/assistant/session"
  defer
></script>
```

That is the whole thing. The script registers `<shopsage-widget>` and mounts one from its own
data attributes, so a host needs no markup. A page that wants control over placement writes the
element instead:

```html
<shopsage-widget backend-url="https://assistant.example.com" token-url="/assistant/session">
</shopsage-widget>
```

| Attribute     | Required | Meaning                                                             |
| ------------- | -------- | ------------------------------------------------------------------- |
| `backend-url` | ✅       | Where ShopSage is                                                   |
| `token-url`   |          | Where **this host** mints a session token. Omit if auth is disabled |
| `open`        |          | Start with the panel open                                           |

`defer` rather than `async`: registration should not race the host's own scripts for no reason.

> **`token-url` must be same-origin to the host page, or send CORS headers.** The fetch carries
> the host's session cookie (`credentials: 'include'`), which is what authorises it — so a
> cross-origin endpoint needs `Access-Control-Allow-Origin` **and**
> `Access-Control-Allow-Credentials`. A storefront serving it from its own origin needs neither.
> This was assumed away in the session-token contract and found by putting the two on different
> ports.

## Platform independence

Nothing in the bundle names Magento, and nothing in it knows what a store sells.

- Everything store-specific arrives from `GET /v1/config` **at run time** — assistant name,
  greeting, brand colours, suggested questions, message ceiling. One bundle serves every store;
  changing a greeting is not a rebuild.
- The only host-specific value is `token-url`, which is wherever _this_ platform mints a token
  the backend accepts.
- It talks to three public endpoints and nothing else.

Moving to a different commerce platform means pointing `token-url` somewhere else.

## What it deliberately does not do

**No business logic.** Worth stating precisely, because "widget" invites scope creep:

| It does not                         | Because                                                       |
| ----------------------------------- | ------------------------------------------------------------- |
| Build prompts                       | The domain owns the prompt; a widget with one is a second one |
| Decide whether to retrieve          | The model decides, via a tool                                 |
| Judge whether an answer is grounded | It renders citations when the API sends them                  |
| Know what a tool is                 | It renders `tool` events as a status line, by name            |
| Apply the no-answer message         | The backend does; the widget would have to guess when         |

It renders what three endpoints return.

## Security

The text this widget renders comes from a language model, which makes it **untrusted input**.
That single fact shapes the implementation.

**Model output is rendered as DOM nodes, never through `innerHTML`.** A model can be talked
into emitting `<script>`, `<img onerror=…>`, or a `javascript:` link, and any of those assigned
through `innerHTML` executes. Building nodes makes injection structurally impossible rather than
a sanitiser away.

| Threat                                 | Handling                                                       |
| -------------------------------------- | -------------------------------------------------------------- |
| `<script>` in an answer                | Rendered as text; no element is ever created                   |
| `<img onerror>`                        | Same — one text node                                           |
| `javascript:` link                     | Refused; the label survives as text                            |
| `data:text/html` link                  | Refused. The one people forget                                 |
| HTML inside a code fence               | Shown, not run — `textContent` on a `<code>`                   |
| A hostile brand colour                 | Validated against a hex pattern before reaching any stylesheet |
| A tampered `conversationId` in storage | Validated against the API's own id pattern before use          |

Even the static shell is built with `createElement`. It would be safe as a template string, but
then the safe habit has an exception — and an exception is where the next author puts a model's
answer.

The test DOM **cannot parse HTML**, deliberately: if this code ever reaches for `innerHTML`, the
tests fail rather than passing against an implementation that ignores it.

**Credentials.** The session token lives in a closure and is never persisted — it is cheap to
re-mint, and anything in storage is readable by every script on the origin for the tab's life.
Requests to ShopSage carry no cookies at all, which is what keeps the API CSRF-immune; the token
fetch is the single exception and it is the host's own endpoint.

## Streaming

The widget consumes the SSE protocol in [API](API.md), and the contract has one rule that is
easy to get wrong:

**`done.answer` is authoritative. Deltas are a progressive preview of it.** They are identical
in the normal case — but a model returning no prose sends **zero** deltas, and the store's
no-answer copy arrives only in `done`. A renderer trusting deltas alone shows an empty bubble in
exactly the case where saying something matters most.

| Event   | The widget does                                                      |
| ------- | -------------------------------------------------------------------- |
| `start` | Stores the conversation id **immediately**, before any token         |
| `tool`  | Shows "Searching the help centre" — this fills the ~4s pre-token gap |
| `delta` | Appends, and re-renders the markdown at most once a frame            |
| `done`  | Settles on `done.answer`, then attaches citations                    |
| `error` | Keeps the text that arrived, then shows the store's fallback copy    |

Markdown is **re-rendered whole on every delta**, not appended. Markdown is not incrementally
parseable: `**bol` is literal asterisks until the closing pair arrives, so appending would leave
the earlier half wrong for ever.

If `features.streaming` is off for the store, the widget uses `POST /v1/chat`. A real fallback,
not a formality — some infrastructure cannot carry an SSE connection cleanly.

**`streaming` is the only feature flag `GET /v1/config` publishes**, and Stage 9a did not add to that
list. The widget has no commerce-specific behaviour: a product answer is markdown with links, which it
already renders. Publishing `productSearch` or `orderTracking` on an unauthenticated endpoint would tell
anyone who asked what a store's assistant can do, for no benefit to the widget. The allow-list is
positive for exactly this reason — a new flag is invisible until someone decides it should not be.

That changed in Stage 9b, but less than expected: the confirmation card is driven entirely by the
`proposal` the API sends, so the widget still needs no feature flag to know whether to draw one. It draws
what arrives.

## The confirmation card

The one thing this widget does that is not rendering what the API returned. Everything else is a view;
this is an **affordance** — the button that turns a prepared change into a real one — which makes it the
highest-consequence code in the package. Four rules follow, and none of them is styling:

1. **The summary is rendered as text, not markdown.** The rest of the transcript is markdown because a
   model wrote it. This sentence is what consent is given to, so it appears exactly as the backend
   composed it. A markdown renderer could emphasise a price, insert a link, or swallow a line as syntax.
2. **It disarms on the first click** — the button is _removed_, not disabled, because a disabled button
   stays focusable in some browsers and keeps announcing itself. A double-tap on a phone is one gesture,
   and the server's take-once consume would refuse the second anyway; a UI that lets somebody press a
   buy-shaped button twice and says nothing has already failed them.
3. **It expires visibly**, and it re-checks expiry **on click** rather than trusting the timer. A tab
   suspended by a phone locking or a browser throttling background timers leaves the visual disarm
   unfired, so correctness cannot rest on a timer having run.
4. **It never states a total it computed.** The confirmed response carries the connector's own total, and
   that string is repeated verbatim — the same rule as the assistant's prose, one layer out.

It is appended as its own block rather than inside the assistant's bubble, because the model's prose and
the button must be visibly different things. A confirmation nested in a sentence a model wrote reads as
part of the sentence.

A failed request is reported as _"we could not tell whether that worked — please check your basket"_.
Deliberately non-committal: the request may have arrived and been applied, so "it did not work" would be
a guess.

The `proposal` event is the one SSE event a client may not merely display. Every other event is safe to
skip; this one, dropped, leaves an assistant claiming to have prepared something the customer cannot
accept. `done.proposal` repeats it, and the widget renders the repeat only when the separate event never
arrived — which is what a proxy buffering an unknown event type looks like.

## Markdown

The subset language models actually emit in answers:

| Supported                                 | Not supported                          |
| ----------------------------------------- | -------------------------------------- |
| `**bold**`, `*italic*`, `` `code` ``      | Tables                                 |
| Fenced code blocks, with a language label | Block quotes                           |
| Ordered and unordered lists               | Images                                 |
| `#`–`###` headings                        | Footnotes, definition lists            |
| `[links](https://…)`                      | Raw HTML (rendered as text, by design) |

Unsupported syntax degrades to literal text, which is the right failure mode: an unclosed `**`
should look like asterisks, not swallow the rest of a sentence.

Code blocks are `tabindex="0"` and labelled, because they scroll horizontally — a scroll region a
keyboard cannot reach is one some people cannot read.

## Accessibility

Not a checklist item; several of these are easy to get subtly wrong.

| Concern           | Decision                                                             |
| ----------------- | -------------------------------------------------------------------- |
| Panel role        | `role="dialog"`, **`aria-modal="false"`**                            |
| Panel name        | `aria-labelledby` pointing at its own heading                        |
| Transcript        | `role="log"`, `aria-live="polite"`, `tabindex="0"`                   |
| Status line       | A **separate** `role="status"` region                                |
| Announcements     | A third off-screen live region for "answer complete" and errors      |
| While answering   | `aria-busy="true"` on the transcript                                 |
| Keyboard          | Enter sends, Shift+Enter newlines, Escape closes                     |
| Focus on open     | Moves to the input                                                   |
| Focus on close    | Returns to whatever opened the panel — **never** to `document.body`  |
| Focus ring        | Visible on every interactive element, in the accent colour           |
| Suggested prompts | Real `<button>` elements                                             |
| Reduced motion    | `prefers-reduced-motion` gives a static indicator, not a missing one |
| Language          | `lang` from the store's locale, which can differ from the page's     |

**`aria-modal="false"` is deliberate.** This sits on somebody's shop and must not tell a screen
reader the rest of the page has ceased to exist — a customer opening the assistant has not
stopped shopping.

**`aria-live="polite"`, not `assertive`**, so an arriving answer is announced without talking
over the customer.

The off-screen live region is positioned off-screen rather than hidden: `display: none` and
`visibility: hidden` both remove a live region from the accessibility tree, which is the classic
way to ship one that never announces anything.

**Focus on close is a fixed bug.** It used to return to `document.activeElement` as recorded at
open time — which is `document.body` when the panel was opened programmatically, and focusing the
body drops focus to the top of the page.

## Mobile

Full screen below 480px. A 380px panel inside a 375px viewport leaves a customer pinching to
reach the send button. Verified at 375×667: the panel fills the width, loses its border radius,
and the composer stays above the fold.

The transcript uses `overscroll-behavior: contain`, so scrolling the conversation does not
scroll the page behind it.

## Theming

Custom properties are the only thing that crosses a shadow boundary, and that is exactly the
trade: a host can rebrand the panel without knowing a class name, and cannot restyle the layout
or break it with a global rule.

```css
shopsage-widget {
  --shopsage-accent: #b91c1c;
  --shopsage-radius: 4px;
  --shopsage-panel-width: 420px;
}
```

**Precedence, in order of increasing priority:**

1. Built-in defaults, in the widget's stylesheet
2. The store's brand, from `GET /v1/config`, as `:host` rules in a second stylesheet
3. **The host page**, via any rule matching the element

A store's brand is a default, not a decree. This originally worked the other way round — the
brand was written as inline styles on the element, which beat any stylesheet and made it
unoverridable. Only visible in a browser.

| Property                  | Default      |
| ------------------------- | ------------ |
| `--shopsage-primary`      | `#111827`    |
| `--shopsage-accent`       | `#2563eb`    |
| `--shopsage-surface`      | `#ffffff`    |
| `--shopsage-on-surface`   | `#1f2937`    |
| `--shopsage-muted`        | `#6b7280`    |
| `--shopsage-border`       | `#e5e7eb`    |
| `--shopsage-code-surface` | `#f3f4f6`    |
| `--shopsage-radius`       | `12px`       |
| `--shopsage-font`         | system stack |
| `--shopsage-panel-width`  | `380px`      |
| `--shopsage-panel-height` | `560px`      |
| `--shopsage-z-index`      | `2147483000` |
| `--shopsage-edge-gap`     | `20px`       |

Dark mode follows `prefers-color-scheme` unless a host overrides the surface colours.

## Session

| State            | Where              | Why                                                               |
| ---------------- | ------------------ | ----------------------------------------------------------------- |
| `conversationId` | `sessionStorage`   | Session-scoped: survives a refresh, ends with the tab             |
| Session token    | **In memory only** | A credential. Cheap to re-mint; storage is readable by any script |

`localStorage` was rejected: it would resurrect a conversation from last week, long after the
server's idle timeout dropped it, so the id would be accepted and answer with no history — worse
than starting fresh.

Every storage access is guarded. `sessionStorage` **throws** rather than returning null in
private browsing modes and inside a sandboxed frame, and a widget must not fail to load because
of it — it degrades to a conversation that does not survive a refresh.

A 401 triggers one token refresh and one retry, then gives up. Expected roughly every fifteen
minutes; the backend distinguishes `TOKEN_EXPIRED` from `UNAUTHORIZED` precisely so a client can
do this rather than give up.

## Building and trying it

```bash
npm run build -w @shopsage/widget    # dist/shopsage.js and dist/shopsage.min.js
```

`iife`, not `esm`: the bundle has to work from a plain `<script>` tag, and
`document.currentScript` — which the auto-mount reads — is null inside a module script.

`packages/widget/demo/index.html` is a host page standing in for a storefront, with the
by-hand checks worth running listed on it. See
[Testing](Testing.md#2a-decies-verify-the-widget-in-a-real-browser) for the procedure.

## Known limitations

- **No automated browser test in `npm test`.** The suite covers markdown, SSE decoding, the API
  client and session storage against a hand-written DOM; the element itself was verified by
  driving a real browser by hand. Wiring a browser into CI is a Stage 10 concern.
- **No retry on a dropped stream.** The store's fallback copy appears and the customer asks
  again. Honest, not resilient.
- **The transcript is not restored on reload** — only the conversation id is, so the assistant
  remembers but the panel starts empty. Rendering history would need an endpoint to read it,
  which does not exist and would have retention implications.
- **No file upload, no voice, no product cards.** Product rendering waits on the Stage 9
  commerce tools.
- **The markdown subset excludes tables**, which a model will occasionally reach for when asked
  to compare things. It degrades to literal text.
