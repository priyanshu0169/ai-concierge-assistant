# ADR 0027: The widget is a custom element that renders untrusted text as DOM

Status: Accepted
Date: 2026-08-03
Stage: 8

## Context

The assistant needs a face. The requirement is a single `<script>` tag on any website, no
framework, no build step asked of the host — and it has to work on a Magento storefront today
without becoming Magento-specific, because the same bundle is meant to sit in front of whatever
comes next.

Two constraints shape everything below. The widget **may not contain business logic**: it
consumes three public endpoints and renders what they return. And the text it renders **comes
from a language model**, which makes it untrusted input in the same sense a form field is.

`GET /v1/config` did not exist and is part of this stage.

## Decision

**A native custom element with a shadow root.** The browser's own component model: no runtime,
no adapter, nothing to reconcile with React, Vue, or a server-rendered page. The shadow root is
what makes it safe to drop onto a stranger's CSS — a host's `* { box-sizing: content-box }`
cannot reach in, and the widget's styles cannot leak out.

**Untrusted text is rendered as DOM nodes, never through `innerHTML`.** This is the decision
the rest of the widget is arranged around. A model can be talked into emitting `<script>`,
`<img onerror=…>`, or a `javascript:` link, and any of those assigned through `innerHTML`
executes. Building nodes makes injection structurally impossible rather than a sanitiser away.
Three consequences:

- The markdown renderer creates elements and text nodes. There is no code path in it that can
  produce an element the parser did not explicitly create.
- Link targets are checked against an `http`/`https` allow-list. `javascript:` is the obvious
  attack; `data:text/html` is the one people forget.
- Even the static shell is built with `createElement`. It would have been safe as a template
  string — but then the safe habit has an exception, and an exception is where the next author
  puts a model's answer.

The fake DOM the tests run against **cannot parse HTML**. That is deliberate: if this code ever
reaches for `innerHTML`, the tests fail rather than passing quietly against an implementation
that ignores it.

**Markdown is re-rendered whole on every delta, not appended.** Markdown is not incrementally
parseable: `**bol` is literal asterisks until the closing pair arrives. Appending would leave
the earlier half rendered wrongly for ever, and the alternative — deciding what to do with an
unclosed fence mid-answer — is a decision visible to a customer. Whole re-renders are throttled
to one a frame.

**`done.answer` is authoritative; deltas are a progressive preview.** Required by the streaming
contract ([ADR 0023](0023-streaming-delivery-over-sse.md)) and easy to get wrong: a model
returning no prose sends **zero** deltas, and the store's no-answer copy arrives only in `done`.
A renderer trusting deltas alone shows an empty bubble in exactly the case where saying
something matters most.

**`GET /v1/config` is the only unauthenticated route under `/v1`.** The widget needs it to
render before a customer has interacted with anything, and every field in it is about to be
painted into a public page. Authenticating data that is about to be published protects nothing.
It is assembled by **naming** each field rather than deleting unsafe ones from a copy — an
allow-list makes a newly added profile field invisible until somebody decides it belongs, where
a deny-list would publish it the day it is added. The system prompt is the exclusion that
matters most: it is how a store constrains the model, and publishing it hands anyone trying to
talk the assistant out of its instructions the exact text to work around.

**The session token lives in a closure, never in storage.** It is a credential, it is cheap to
re-mint from a same-origin endpoint that already holds the host's session, and anything
persisted is readable by every script on the origin for the life of the tab. The
_conversation id_ is persisted, in `sessionStorage` rather than `localStorage`, because a
conversation is session-scoped — `localStorage` would resurrect one from last week, long after
the server's idle timeout dropped it, so the id would be accepted and answer with no history.

**`token-url` is a host attribute.** The one seam that keeps this platform-agnostic: nothing in
the bundle names Magento, and any host that can mint a token the backend accepts can serve
these bytes unchanged.

**Theming is CSS custom properties on `:host`, and nothing else is reachable.** Custom
properties are the only thing that crosses a shadow boundary, which is exactly the trade
wanted: a page can rebrand the panel without knowing a class name, and cannot restyle the
layout or break it.

## Alternatives

**An iframe.** Perfect isolation, and it is what most chat widgets do. Rejected: an iframe
cannot size itself to its content, needs `postMessage` for every interaction, breaks the host
page's focus order, and would need its own document served from somewhere. A shadow root gives
most of the isolation with none of that.

**A framework — React, Preact, Lit.** Familiar, and Lit in particular exists for this. Rejected:
the widget would then impose a runtime on every host page, and a host already using a different
version would ship two. Lit is ~5 kB and would have saved perhaps a hundred lines of DOM
plumbing; the bundle is 23 kB minified with **zero** dependencies, and a widget that installs
nothing is easier to get approved onto a storefront than one that installs something.

**A markdown library — `marked`, `markdown-it`.** Complete, tested, and both emit **HTML
strings**, which would then need a sanitiser (`DOMPurify`, another dependency) to be safe against
model output. Two dependencies to arrive at a subset of what is here, with the security property
delegated rather than structural. The subset is what models actually emit; tables and block
quotes degrade to literal text, documented.

**`EventSource` for streaming.** The obvious tool, and unusable: it only issues GET requests
with no body, and the chat endpoint is a POST with JSON and an `Authorization` header. So SSE is
decoded by hand over `fetch`, including reassembly across chunk boundaries.

**Requiring the host to write the element tag.** Rejected as the _only_ option — the script tag
mounts itself from its own data attributes, so the integration is one line. A host that wants
control over placement can still write the element itself.

**`aria-modal="true"` on the panel.** Rejected: this sits on somebody's shop and must not tell a
screen reader the rest of the page has ceased to exist. A customer opening the assistant has not
stopped shopping.

## Consequences

23 kB minified, no dependencies, one `<script>` tag. Verified in a real browser over the
DevTools protocol — element registered, shadow root attached, config applied, the panel opened,
a real grounded answer streamed in with three citations, both status phases shown
("Sage is thinking" → "Searching the help centre"), the conversation continued across a page
reload, the layout going full-screen at 375px and back at desktop width, and zero console
errors.

**Three real defects, each found by looking at output rather than at code.**

1. **`GET /v1/config` published unresolved placeholders.** A store writing
   `"Hi! I'm {{assistantName}}."` would have greeted customers with the braces. The domain
   resolves those when building prompts; the config route published the raw template. Fixed by
   applying the same `renderTemplate` the domain uses — found by reading a live response.
2. **Theming precedence was inverted.** Brand colours were written as inline styles on the host
   element, and inline styles beat any stylesheet — so the store's brand was unoverridable and a
   page author's `shopsage-widget { --shopsage-accent: … }` did nothing, the opposite of what
   the code claimed. Fixed by writing them into a `:host` stylesheet inside the shadow root,
   where host-document rules correctly win. Only visible in a browser.
3. **Closing the panel could lose focus entirely.** Focus returned to whatever was active when
   the panel opened — which is `document.body` when it was opened programmatically. Focusing the
   body drops focus to the top of the page. Fixed by falling back to the launcher.

Also fixed en route: the markdown link pattern stopped at the first `)`, breaking every
Wikipedia-style URL and leaving a stray bracket in the prose.

The widget cannot be type-checked or linted with the rest of the repository, so it has its own
`tsconfig.json` with the DOM library and its own lint block with browser globals. Kept separate
deliberately: adding `DOM` to the root config would make `window` and `document` valid names in
every backend package, so a stray browser reference in Node code would type-check instead of
failing.

**`token-url` must be same-origin to the host, or CORS-enabled.** The demo puts the stand-in
issuer on another origin and the token fetch was blocked until it sent the headers — a real
integration note the contract had assumed away, now in `docs/Widget.md`.

Two things this does not do. There is no automated browser test in `npm test`: the verification
above was driven by hand over CDP, and wiring a browser into the suite is a Stage 10 concern
along with CI. And the widget has no retry for a dropped stream — it shows the store's fallback
copy and the customer asks again, which is honest but not resilient.
