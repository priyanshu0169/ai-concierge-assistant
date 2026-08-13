# Testing

## Strategy

Tests run on Node's built-in runner (`node:test`) with `node:assert/strict`. No test framework, no
transpiler, no mocking library.

The reason is not minimalism for its own sake. This codebase ships JavaScript and runs it unmodified;
a test toolchain that transforms source means tests exercise something other than what production
runs. Everything is injected — logger sinks, clocks, `fetch`, `process` — so test doubles are plain
objects and there is nothing to mock.

```bash
npm test              # all packages
npm run test:coverage # with coverage
npm run verify        # format + lint + typecheck + test
```

### What is tested where

| Level            | Covers                                                                | Doubles used                         |
| ---------------- | --------------------------------------------------------------------- | ------------------------------------ |
| Unit             | Logging, redaction, errors, config schemas, timeouts, retries, health | Injected sink, clock, `fetch`, sleep |
| Wire             | Request building, response parsing, SSE decoding, tool reassembly     | Raw wire fixtures                    |
| Client           | `generate()` / `stream()` against a scripted gateway                  | Scripted `fetch`, recording logger   |
| HTTP integration | Real Express app on an ephemeral port, driven with `fetch`            | Stub probes, stub LLM, silent logger |

HTTP tests bind port 0 so the OS picks a free port — tests never collide with a running dev stack or
with each other.

Test config is built with the **real** parsers (`parseEnv`, `parseSiteProfile`) rather than
hand-written object literals. A fabricated config object drifts from the schema and hides genuine
breaks; going through the parser means a schema change that breaks production also breaks the tests.

Nothing in the suite sleeps or reaches the network. `withRetry` takes an injected `sleep` and `random`,
so backoff and jitter are asserted exactly rather than approximately.

Two details of the gateway double are load-bearing:

- **Scripted responses are thunks, not values.** A `Response` body can be read only once, so a retry
  test that reused one response would pass for the wrong reason.
- **SSE fixtures split events at awkward chunk boundaries.** A decoder that assumes one event per read
  passes every simple test and then drops tokens against a real gateway.

The recording logger is the **real** logger writing to memory, so assertions about token accounting and
redaction run against the records that would actually be shipped.

### Behaviour that is deliberately asserted

Some tests exist to pin down decisions that are easy to regress:

| Test                                                                           | Protects                                                                                                                                     |
| ------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `liveness` invokes no probe                                                    | A dependency outage must not trigger restart loops                                                                                           |
| Secrets are redacted at any nesting depth                                      | Credentials must never reach log storage                                                                                                     |
| 5xx messages are masked, 4xx are not                                           | Internal hostnames must not leak to customers                                                                                                |
| The shipped `config/site-profile.json` validates                               | The default profile cannot drift from the schema                                                                                             |
| `/health/info` contains no secret, URL, or system prompt                       | The debug endpoint stays browser-safe                                                                                                        |
| Access logs contain the full path, not the mount-relative one                  | Regression: `req.path` is rewritten inside mounted routers                                                                                   |
| Access logs strip the query string                                             | Customer text must not enter access logs                                                                                                     |
| An oversized `x-request-id` is replaced                                        | Log injection via an attacker-controlled header                                                                                              |
| Unknown site-profile keys are rejected                                         | A typo must fail at boot, not silently default                                                                                               |
| Token counts survive redaction                                                 | Regression: `token` matched the plural, so every cost measurement logged as `[redacted]`                                                     |
| A gateway's echoed credential never reaches a log record                       | Providers quote the API key back in 401 bodies                                                                                               |
| A timeout is **not** retried                                                   | Cost and latency: a retry pays twice for an abandoned generation                                                                             |
| A 4xx is not retried                                                           | The same request will fail again, billably                                                                                                   |
| A stream is not retried once a delta has been yielded                          | Replaying would duplicate rendered text                                                                                                      |
| An upstream 429 surfaces as a masked 502, not a 429                            | A customer must not be told they are throttled when they are not, and an exposed error publishes its details                                 |
| An unknown `finishReason` degrades to `unknown`                                | A label we do not recognise must not become an outage                                                                                        |
| Malformed tool arguments are reported by tool name only                        | Tool arguments carry customer input                                                                                                          |
| An SSE event split across chunks is reassembled                                | The failure mode that only appears against a real gateway                                                                                    |
| `generate()` returns exactly four keys                                         | No provider or model identifier may leak into the contract                                                                                   |
| `/v1/chat` returns no `usage`                                                  | Cost data is for operators, not browsers                                                                                                     |
| Unknown request fields are rejected                                            | Parameter smuggling into the model call                                                                                                      |
| The backend refuses to build a client without `LLM_*`                          | A misconfigured assistant is worse than an absent one                                                                                        |
| The 401 remediation names `LLM_MODEL`, not only `LLM_API_KEY`                  | Real finding: gateways answer 401 for a forbidden model, sending operators to rotate a working credential                                    |
| A wrong-width vector is rejected on every response                             | Mixed vector spaces produce plausible, meaningless similarity scores                                                                         |
| `health()` fails when the service serves another model                         | The silent-corruption case: the variable changed, the container did not                                                                      |
| `embedDocuments` preserves order across batches                                | A chunk's vector must be the vector for _that_ chunk                                                                                         |
| Documents are never given the query prefix                                     | Asymmetric models are trained with the instruction on queries only                                                                           |
| Empty input is rejected with the offending index                               | One bad chunk must not fail a whole batch anonymously                                                                                        |
| A search without `siteId` cannot be expressed or sent                          | One store answering from another store's content                                                                                             |
| A filtered delete without `siteId` is refused                                  | "Remove this store's content" must not become "remove everything" — there is no undo                                                         |
| The same caller id always derives the same UUID                                | Re-ingestion must upsert, not duplicate                                                                                                      |
| `search()` returns caller ids, and hides `_pointId`                            | No store id format may leak to a caller                                                                                                      |
| A result carries only `id`, `score`, `payload`                                 | No Qdrant concept may leak into a domain shape                                                                                               |
| `createCollection` tolerates 409                                               | The ingestion CLI runs repeatedly against a populated store                                                                                  |
| A NaN in a vector is rejected                                                  | Vector stores accept NaN happily and then poison every score                                                                                 |
| Re-ingesting an unchanged document embeds nothing                              | The whole basis of cheap re-ingestion: embedding is the expensive step                                                                       |
| A shortened document deletes its trailing chunks                               | Otherwise the tail of the old version stays in the index and keeps answering questions                                                       |
| Pruning refuses to run after any failure in the crawl                          | An unreachable page is not a deleted page                                                                                                    |
| Pruning refuses to run below 50% coverage of stored documents                  | A crawl that died early must not be read as "the rest no longer exists"                                                                      |
| `--force` re-embeds every chunk regardless of hash                             | The escape hatch for a chunking or model change the hash cannot see                                                                          |
| Chunk ids are positional (`documentId#0`), not content-based                   | An edited chunk must overwrite in place, not orphan its previous version                                                                     |
| The heading breadcrumb is embedded but not displayed                           | Showing "Title > Heading" back to a customer as if it were content would be nonsense                                                         |
| An unanswerable question fails if anything is retrieved                        | The direct measure of hallucination resistance: a confident wrong answer is the worst output this can produce                                |
| The tool loop stops after a bounded number of rounds                           | A model will call the same tool with the same arguments forever, and nothing else would stop it                                              |
| The final round is issued with **no tools**                                    | Withdrawing the option is the only mechanism that guarantees prose; a prompt instruction is a request                                        |
| A throwing tool becomes a tool result, not an exception                        | One failed lookup must not turn a customer's question into a 502                                                                             |
| An unknown tool name is answered by naming what exists                         | Models invent tool names; the next round can recover instead of burning the budget                                                           |
| `buildMessages` receives no chunks                                             | Context must arrive as a tool result, or the model cannot search again when the first query missed                                           |
| History is persisted only after a successful turn                              | A failed turn must not leave a question in history that was never answered                                                                   |
| `sources` are attached only when chunks were retrieved                         | An answer from the model's own knowledge must not carry a citation implying otherwise                                                        |
| At most two chunks per source URL reach the context                            | Five excerpts from one page read to a model as five sources agreeing                                                                         |
| The highest-scoring excerpt is included even if oversized                      | Dropping the best answer to respect a character budget is the wrong trade                                                                    |
| Context truncation cuts at a chunk boundary                                    | A model handed half a sentence will reason from half a sentence                                                                              |
| An empty answer becomes `noAnswerMessage`, placeholders resolved               | An empty chat bubble reads as broken software                                                                                                |
| A disabled feature flag yields no tool, and no tool definition                 | Adding a tool to the platform must not change an existing store's behaviour until its profile opts in                                        |
| Tool wire definitions are derived from the tools themselves                    | A tool cannot be executable but undeclared, or declared but unexecutable                                                                     |
| The `searchKnowledge` description states the corpus has no products            | A model believing otherwise presents whatever it finds as current price and stock                                                            |
| `/v1/chat` does not serialize `grounded`                                       | An internal quality metric must not become a client-visible contract                                                                         |
| A template value is not re-scanned for placeholders                            | A store's own copy must not be able to expand into another placeholder                                                                       |
| An unknown placeholder is left visible, not deleted                            | Deleting it silently changes a prompt's meaning; leaving it makes the typo obvious                                                           |
| Inherited object properties are not treated as template values                 | `{{toString}}` must not resolve                                                                                                              |
| A conversation key contains the site id                                        | Cross-tenant reads must be impossible, not merely filtered out                                                                               |
| Append, trim and expire happen in one transaction                              | Two tabs on one conversation would otherwise interleave and lose a turn                                                                      |
| The expiry is refreshed on every write                                         | The timeout must mean "idle this long", not "created this long ago"                                                                          |
| Both store implementations expire on the same rule                             | Two implementations of one port that behave differently are two products                                                                     |
| An unreadable stored entry is skipped, not thrown                              | A shared store outlives a release; one bad entry must not break a conversation permanently                                                   |
| A store operation that never answers still fails                               | Real finding: with Redis stopped, `/health/ready` hung indefinitely instead of reporting `down`                                              |
| A failed connect is retried on the next request                                | A memoized rejection would make the first outage permanent for the process's life                                                            |
| A vendor error never reaches a customer                                        | Nothing above the adapter should recognise a Redis error type, or see a datastore address                                                    |
| Production refuses to boot without `CONVERSATION_STORE`                        | `memory` is right at one replica and silently wrong at two, and only an operator knows which                                                 |
| Teardown hooks run after the server closes                                     | Closing a store connection under a live request turns a clean deploy into 502s                                                               |
| Health endpoints are never rate limited                                        | Throttling a readiness probe pulls a healthy instance out of the load balancer                                                               |
| A rejected request still costs a token                                         | Otherwise a flood of 400s is free                                                                                                            |
| The allowance refills continuously                                             | A fixed window permits a double-rate burst across its boundary                                                                               |
| `Retry-After` advises one request, not a full bucket                           | Three times the necessary idle time, otherwise                                                                                               |
| `RateLimit-*` headers are sent on success too                                  | A client should slow down before it is refused, not discover the limit by hitting it                                                         |
| The rate-limit client map is bounded                                           | The key comes from a client address — unbounded is a memory hole inside the anti-flood middleware                                            |
| Per-client stream excess is 429, whole-service is 503                          | A well-behaved customer must not be told they are throttled when the service is simply full                                                  |
| A concurrency slot is released exactly once                                    | Counting down twice lets the ceiling drift upward for the life of the process                                                                |
| A client holding no streams is forgotten                                       | The same unbounded-map hole as above                                                                                                         |
| `<script>` in an answer creates no element                                     | Model output is untrusted input; `innerHTML` would make this XSS by design                                                                   |
| A `javascript:` or `data:` link is refused, keeping the words                  | `data:text/html` is the one people forget                                                                                                    |
| HTML inside a code fence is shown, not run                                     | A fence's whole purpose is that its contents are not markup                                                                                  |
| An unclosed `**` stays literal text                                            | The state of every streamed answer mid-delta; swallowing the sentence is the wrong failure                                                   |
| A URL containing balanced parentheses survives                                 | Real bug: `[^)]+` broke every Wikipedia-style link and left a stray bracket                                                                  |
| An SSE event split across chunks is reassembled                                | Passes every local test and drops tokens against a real gateway                                                                              |
| A multi-byte character split across chunks is not corrupted                    | The symptom is mangled text in exactly one language                                                                                          |
| A malformed SSE payload does not kill the stream                               | The terminal `done` still carries the authoritative answer                                                                                   |
| The client sends only the two fields the API accepts                           | The API rejects unknown ones, so a stray field is a 400 after a backend upgrade                                                              |
| One 401 refreshes and retries; a second does not                               | An expiry is routine; a rejection must not loop                                                                                              |
| Cookies are sent **only** to the token endpoint                                | Every ShopSage call is cookie-free, which is what makes the API CSRF-immune                                                                  |
| A tampered `conversationId` in storage is discarded                            | Any script on the origin can write there, and it becomes a storage key on the server                                                         |
| Storage that throws does not break the widget                                  | `sessionStorage` throws in private browsing and sandboxed frames                                                                             |
| No session token is ever persisted                                             | A credential in storage is readable by every script on the origin for the tab's life                                                         |
| `GET /v1/config` serves without a token                                        | The widget needs it before a customer has interacted with anything                                                                           |
| `GET /v1/config` excludes the system prompt                                    | It is how a store constrains the model; publishing it hands over the text to work around                                                     |
| `GET /v1/config` resolves `{{assistantName}}`                                  | Real bug: a store's greeting reached customers with the braces intact                                                                        |
| All eight shared contract vectors behave as agreed                             | The two sides are built by different people at different times; this is what catches a divergence                                            |
| The vector id set itself is asserted                                           | A case quietly disappearing would narrow the contract without failing anything                                                               |
| `alg: none` is refused **before** verification                                 | The classic JWT break is choosing the method from an attacker-supplied header                                                                |
| A token for another store is refused                                           | Tenancy: a correctly signed token from store A must not work against store B                                                                 |
| No response says which check failed                                            | Real finding: a 401 is an exposed error, so the reason in `details` was being published                                                      |
| An expiry is logged `info`, a forged algorithm `error`                         | One level for both means drowning in expiries or missing an attack                                                                           |
| A valid token with no usable scope answers 200                                 | Insufficient scope withholds a capability; it does not refuse a request                                                                      |
| The example token carries no email or numeric id                               | The pseudonym decision, checked against the fixture rather than only asserted in prose                                                       |
| An unknown `kid` refetches at most once a minute                               | Otherwise forged `kid`s make ShopSage a DoS amplifier against the storefront                                                                 |
| A failed refresh serves the stale key set                                      | Keys that still verify must not be discarded over a network blip                                                                             |
| No keys at all is 503, not 401                                                 | The caller's token may be valid; we simply cannot check it                                                                                   |
| One failing teardown hook does not skip the others                             | And does not make the exit code non-zero — a false failure makes every deploy look broken                                                    |
| Streamed and buffered answers match for the same scenario                      | Two delivery modes must not become two products with two behaviours                                                                          |
| The buffered path emits no deltas at all                                       | It must not pay for a stream it cannot use; `generate()` is one request                                                                      |
| Deltas reassemble exactly to `done.answer`                                     | A renderer appends deltas; a mismatch shows the customer text the server never sent                                                          |
| Empty deltas are dropped                                                       | An OpenAI-compatible stream's first event carries the role and no content                                                                    |
| An SSE stream writes nothing until its first event                             | While no status line is out, a failure can still become a real HTTP status code                                                              |
| An event is framed exactly `event:` / `data:` / blank line                     | `EventSource` is unforgiving, and a framing bug looks like a stream that never delivers                                                      |
| A keepalive comment goes out while idle                                        | The pre-first-token gap can exceed a proxy's idle timeout, and this only fails behind a real proxy                                           |
| The heartbeat stops when the stream closes                                     | A stray interval outlives the request and keeps the process alive through shutdown                                                           |
| Nothing is written to a response that has already ended                        | Writing to a disconnected client throws, and there is nobody left to tell                                                                    |
| A pre-first-event failure is a status code, not an event                       | A dependency outage must stay visible to load balancers and monitoring                                                                       |
| A mid-stream failure is a masked `error` event inside a 200                    | No status code can change by then, and the internal message still must not leak                                                              |
| A closed tab logs nothing above `info`                                         | Real finding: the abort path filed an `error` with a stack trace on every abandoned chat                                                     |
| An abandoned turn is not persisted                                             | A stream cut mid-sentence would otherwise be replayed to the model as history                                                                |
| A disabled `streaming` flag 404s and never reaches the domain                  | A capability a store has not enabled does not exist for that store                                                                           |
| `/v1/chat/stream` publishes no `grounded` and no token usage                   | The same rule as the buffered path, enforced against the SSE body                                                                            |
| A price is never rendered from the decimal `amount`                            | Only the connector's `formatted` string is ever shown; a reconstructed price is a computed one                                               |
| A tool result forbids totals, discounts and tax arithmetic                     | The rule lives where the model reads it, not only in the prompt                                                                              |
| "Which is cheaper" and "by how much" are separated in as many words            | Real finding: with only the general rule, a live model answered "cheaper by £31.00"                                                          |
| An unstated `taxIncluded` is reported as unstated                              | A store quoting ex-VAT to a consumer without saying so has a legal problem; neither side may infer it                                        |
| Availability absent from the connector is absent from the result               | Never inferred, per the accepted contract                                                                                                    |
| An availability value the contract does not define is dropped                  | An unrecognised value in the prompt invites the model to interpret it                                                                        |
| Prices sort by numeric value, never via `Number()`                             | `"9.00" > "10.00"` lexicographically, and floats must never touch money                                                                      |
| Mixed currencies are refused rather than ordered                               | "Cheapest" across currencies would be a fabricated comparison                                                                                |
| `trackOrder` has exactly one parameter, `reference`                            | The model chooses arguments, so an identity parameter is one it can be talked into changing                                                  |
| An order maps four fields even when the connector sends more                   | What is never mapped is never written into conversation history                                                                              |
| A recommendation reason claims no quality, popularity or fitness               | A fabricated reason is indistinguishable from a real one to the customer reading it                                                          |
| Out-of-stock products are not recommended, but are not hidden                  | "Everything matching is out of stock" is a useful answer; "we do not sell that" would be false                                               |
| Term matching happens at word starts                                           | Real finding: substring matching had "for" match "reinforced" and reported it as a match                                                     |
| The rules block appears once per tool result, not once per product             | Real finding: a third of a shortlist result was the same rules restated                                                                      |
| An order reference survives redaction                                          | The redactor's false positives are the design risk: a mangled order number loses the customer's own thread                                   |
| A URL containing a Luhn-valid digit run is left intact                         | ~1 in 10 digit runs passes Luhn; breaking a tracking link protects data that was never there                                                 |
| Both sides of a turn are redacted, not only the customer's                     | An assistant repeats what it was told, one message further down                                                                              |
| The reply to the customer is **not** redacted                                  | Redaction is a retention control, not an output filter                                                                                       |
| A redaction log records the category and never the value                       | A log is retention, which is the thing being avoided                                                                                         |
| The session token reaches the connector and no log record                      | Why it lives on `req.sessionCredential` and not on the loggable `req.session`                                                                |
| A commerce feature with no `MAGENTO_API_URL` fails at boot                     | Degrading failures into answers means a misconfiguration would otherwise be silent, per customer                                             |
| The site profile's `magentoApiUrl` beats the environment                       | Documented precedence that the first implementation ignored                                                                                  |
| A connector 503 is retried; a 403 and a 404 are not                            | Retry means "the connector asked to be tried again", not "any failure"                                                                       |
| A connector's error text never reaches the raised error                        | Upstream error copy is written for its own operator                                                                                          |
| A tool cannot reach the write port at all                                      | "The model must not commit" is a property of what is reachable, not a rule to be trusted with                                                |
| `create-magento-cart.js` imports no retry helper                               | A write must never be retried, and no test can observe a second charge — so this watches the import                                          |
| A write failure is marked non-retryable at every status                        | A 5xx may mean the cart changed and the reply was lost                                                                                       |
| Only sku and quantity are sent to the cart                                     | The connector is the authority on price; sending one invites it to trust ShopSage's copy                                                     |
| `applied` defaults to false, never to true                                     | Telling a customer their item is in the basket when the connector never said so is the failure being avoided                                 |
| A proposal is consumed exactly once                                            | The guarantee that makes a double-tapped confirm button safe                                                                                 |
| `GETDEL` is used, and `del` is not                                             | A `get` then `del` is a race with a basket on the other end of it                                                                            |
| A stranger's refused attempt leaves the proposal usable                        | Real finding: consumption precedes the ownership check, so a leaked id could destroy somebody's prepared change                              |
| An expired proposal is **not** restored                                        | It is finished either way; writing it back would store something already dead                                                                |
| Expiry and subject mismatch give the identical refusal                         | A stranger with a guessed id learns only that it did not work                                                                                |
| The same proposal yields the same idempotency key                              | Two attempts must carry one key or a connector cannot recognise the repeat                                                                   |
| The idempotency key is not the proposal id                                     | The id is a bearer token, and connectors log their idempotency keys                                                                          |
| A coupon proposal never carries the code to the browser                        | The customer typed it and it is already in the summary; a working code in browser history is a gift                                          |
| The coupon tool reaches no connector                                           | Validity is only knowable by applying it, which is what has not been agreed to yet                                                           |
| The coupon code is never logged                                                | A working promotional code is worth something, and a log outlives the conversation                                                           |
| A second proposal in one turn is refused before the tool runs                  | Two buttons is two decisions where the customer expects one, and nothing is read or built to be thrown away                                  |
| An unstorable proposal is withheld from the reply                              | Better to say nothing was prepared than to render a button that cannot work                                                                  |
| Both chat paths send the session subject                                       | Real finding: the streamed path is a separate object literal, and a field forgotten there breaks every store with streaming on               |
| The confirmation summary is rendered as text, not markdown                     | It is what consent is given to; a renderer could emphasise a price or swallow a line as syntax                                               |
| The confirm button disarms on the first click                                  | A double-tap on a phone is one gesture, and a buy-shaped button that accepts two presses has already failed                                  |
| Expiry is re-checked on click, not left to a timer                             | A suspended tab leaves the visual disarm unfired, so correctness cannot rest on a timer having run                                           |
| A failed confirmation says "we could not tell"                                 | The request may have arrived and been applied, so "it did not work" would be a guess                                                         |
| The widget renders no total it computed                                        | The same rule as the assistant's prose, one layer out                                                                                        |
| An unknown path collapses to `route="other"`                                   | A caller-supplied label lets anybody create unbounded series that never expire; the monitoring system falls over before the service does     |
| Histogram buckets render cumulatively, and `+Inf` equals the count             | Getting either backwards produces a histogram that looks plausible and computes nonsense quantiles                                           |
| Label order does not create a second series                                    | Without a sorted series key the sum is right only if a dashboard happens to add both                                                         |
| A metric family with no observations is still declared                         | An absent metric and a metric that is zero are different facts                                                                               |
| `/metrics` refuses a credential of a different length without a 500            | `timingSafeEqual` throws on a length mismatch rather than returning false                                                                    |
| Metrics on with no token is a **boot failure**                                 | Serving it open would publish spend and traffic volume silently, which is the worst combination                                              |
| The scrape carries no conversation id, subject, order reference or query       | Metrics are aggregate by definition; anything identifying in a label is both a leak and a cardinality bomb                                   |
| A decorated port yields every value and error through unchanged                | Observation must sit outside the value path, or a metrics bug becomes a customer bug                                                         |
| Zero reported tokens are recorded as _no_ measurement                          | A gateway with usage reporting off would otherwise show a token distribution at zero and read as "calls are free"                            |
| `observePorts` returns its input by identity when metrics are off              | A disabled feature that still allocates a wrapper per call is one you find out about from a profiler                                         |
| An abandoned stream is its own outcome                                         | `abandoned` over `streamed` says whether customers are giving up or a proxy is cutting connections                                           |
| A failed turn is counted, not left as a hole                                   | A hole in a count is not something an alert can be written against                                                                           |
| Plain `fetch` overflows on oversized response headers; `crawlerFetch` does not | Reproduced against a real server, not asserted on faith - the bug and the fix are both wire-level                                            |
| The crawler sends only `accept` and `user-agent`, never a cookie               | `fetch` neither stores nor replays cookies unless a caller sets one; confirmed rather than assumed                                           |
| `createWebsiteSource` with no `fetchImpl` override reaches the same fix        | The default matters more than the helper - this is the path a real crawl actually takes                                                      |
| `parseHtmlPage` extracts real text past a script-heavy, Knockout-bound head    | Reconstructs the shape of markup that made a previous parser silently lose a real `<main>` on a real page (see ADR 0032 and 2a-quaterdecies) |

### Current results

```
tests 1098 · pass 1098 · fail 0 · suites 236
```

Everything shipped in Stages 1–10a has coverage; the suite runs in about 12 seconds.

**Stage 9a's most useful tests were not tests.** Four defects were found by running the real client
against the reference connector and _reading the output_ — a rules block repeated three times, a
substring match reporting "for" as a match, a reason that did not fit its sentence, and a live model
computing a price difference. None would have failed a unit test, because each was the code doing
exactly what it was written to do. The reference connector exists partly for this: a verification
target that is neither a mock nor a production system.

**The widget's tests run against a hand-written DOM**, not `jsdom`. Partly for the reason every
other double here is hand-written — no framework, no transpiler, and a full DOM implementation
would be the project's largest dependency by an order of magnitude. But mostly because that DOM
**cannot parse HTML**: if the widget ever reaches for `innerHTML`, the tests fail rather than
passing against an implementation that quietly ignores it. The safety property is enforced by the
test double's own limitations.

What the suite does **not** cover is the custom element itself — `customElements`, `attachShadow`,
focus and layout need a browser. That was verified by hand over the DevTools protocol; see
§2a-decies. Wiring a browser into CI is a Stage 10 concern.

**The session-token suite is driven by a shared fixture, not by hand-written cases.**
`packages/session-token/test/vectors/vectors.json` holds the eight contract vectors agreed with the
Magento module (§14 of [Proposal 0001](proposals/0001-assistant-session-token.md)), generated by a
checked-in script so the other side can reproduce rather than trust them. Each vector carries the instant
it must be evaluated at, so a "valid" token stays valid and nothing expires on a date nobody chose.

A test also asserts the **set of vector ids** — a case quietly disappearing would silently narrow the
contract.

`assistant-core`'s share of that runs with **no network, no Docker and no mocking framework** — the four
ports are satisfied by plain object literals, which is the practical payoff of
[ADR 0021](adr/0021-the-domain-declares-its-ports.md). A test for "the model asked for a tool that does
not exist" is four lines and needs no gateway.

The `rag-backend` chat tests were rewritten rather than extended. They now stub the conversation manager
and assert **only** the HTTP contract — shape, status codes, validation, the error envelope — because
what happens inside a turn belongs to `assistant-core` and is tested there without an Express app in the
way. The Stage 2 tests asserting "no context and no history in this stage" became assertions about what
is now sent, exactly as the roadmap said they would.

Stage 4 was written while Node.js was temporarily unavailable on the development machine and shipped
with lint and typecheck clean but its tests never executed. That gap is now closed: once Node returned,
the full suite ran and found **four real defects**, all fixed and re-verified —

- Inline HTML markup (`Return <strong>unopened</strong> items`) extracted with the word boundary
  eaten (`Returnunopened items`). A genuine bug that would have corrupted every scraped page; fixed in
  the block-to-text conversion in `@shopsage/scraper`.
- `z.discriminatedUnion` rejects a member wrapped in `.refine()` — moved the cross-source validation
  (duplicate ids, missing seeds) to `.superRefine()` on the array, which also lets the error name the
  offending source by index.
- Two test fixtures of my own that were too short, or accidentally byte-identical, tripping thresholds
  the implementation was correctly enforcing.

The lesson stands documented rather than just fixed: lint and typecheck passing is not evidence that
code runs correctly, only that it is well-formed. See [Roadmap](Roadmap.md) for the stage history.

## Manual verification

### 1. Quality gates

```bash
npm run verify
```

Expected: format check clean, no lint errors, no type errors, 533 tests passing.

### 2. Run locally without Docker

The backend now needs a gateway. Either point it at a real one, or at the throwaway stub below.

```bash
export LLM_API_KEY=sk-local-not-a-real-key
export LLM_BASE_URL=https://your-gateway/v1
export LLM_MODEL=your-model
npm run dev

curl -fsS http://localhost:3000/health
curl -fsS http://localhost:3000/health/info
```

Expected: `/health` → `{"status":"ok",...}`. `/health/info` → `siteId: "demo-store"`,
`assistantName: "Sage"`, `enabledFeatures: ["knowledgeSearch","streaming"]`. Boot logs one
`llm gateway configured` record naming the model and the gateway host.

Also expected: `/health/ready` returns 503, because Qdrant and the embeddings service are not running.
That is the correct answer, not a failure — and note that a broken gateway does **not** show up here.

### 2a. Ask a question

```bash
curl -fsS -XPOST localhost:3000/v1/chat \
  -H 'content-type: application/json' \
  -d '{"message":"What is your return policy?"}'
```

Expected: 200 with `conversationId` (`c_` + 32 hex), `messageId` (`m_` + 32 hex), an `answer`,
`sources: []` and `finishReason`. The response must contain **no** token usage.

Then check the logs for exactly one `llm completion` record, and confirm it carries readable token
counts rather than `[redacted]`:

```bash
npm run dev 2>&1 | grep 'llm completion'
# ..."model":"…","promptTokens":123,"completionTokens":45,"totalTokens":168,...
```

Verify the correlation chain holds by supplying a trace id and finding it on both records:

```bash
curl -fsS -XPOST localhost:3000/v1/chat -H 'content-type: application/json' \
  -H 'x-request-id: manual-trace-1' -d '{"message":"hello"}'
# both `llm completion` and `request completed` carry requestId=manual-trace-1
```

### 2a-bis. Verified gateways

"OpenAI-compatible" is a claim, not a guarantee — endpoints differ most in streaming and tool-call
encoding, which is exactly what this project hand-rolls. Each endpoint therefore gets verified once, by
hand, and recorded here.

| Gateway                            | Model         | Verified   | Notes                                     |
| ---------------------------------- | ------------- | ---------- | ----------------------------------------- |
| LiteLLM proxy (internal, Heimdall) | `gpt-4o-mini` | 2026-07-30 | Full pass. `/v1` and bare paths both work |

What passed on that gateway:

| Path                                              | Result                                                       |
| ------------------------------------------------- | ------------------------------------------------------------ |
| `POST /v1/chat`, conversation id round-trip       | ✅ Identity answered from the site profile                   |
| `stream()`                                        | ✅ 10 deltas, first at ~1.2 s, one `end` event               |
| `stream_options: { include_usage: true }`         | ✅ Accepted — usage reported on streams                      |
| Tool call requested                               | ✅ `finishReason: tool_calls`, arguments parsed to an object |
| Tool result fed back, full loop closed            | ✅ Gateway accepted the `assistant`/`tool` message pair      |
| **Streamed** tool call reassembled from fragments | ✅ Correct name and arguments                                |
| Nonexistent model                                 | ✅ Mapped, not retried — **returns 401, see below**          |
| Invalid credential                                | ✅ Mapped, not retried, remediation given                    |
| Credential in any log record                      | ✅ **0 occurrences** across every record emitted             |
| Token counts readable in every completion record  | ✅ Not `[redacted]`                                          |

**Measured latency:** 1124–1514 ms for short completions (5 calls); first stream delta at ~1219 ms.
That makes the `LLM_TIMEOUT_MS=60000` default very generous — it is headroom for a long answer at
`LLM_MAX_TOKENS=1024`, not a typical wait. 30000 would be defensible for this gateway.

**Finding worth keeping:** a model the key is not entitled to use returns **401**, not 403 or 404
(`team not allowed to access model`). The 401 remediation hint therefore names `LLM_MODEL` as well as
`LLM_API_KEY` — otherwise an operator rotates a credential that was fine. Pinned by a test.

### 2a-ter. Verify retrieval against the real services

Unit tests drive fakes, so the retrieval clients need one pass against real Qdrant and real TEI. Start
them, then check each property below. All of these were verified on 2026-07-30 with
`bge-small-en-v1.5` (384 dimensions) and Qdrant v1.12.4.

```bash
docker compose up -d shopsage-qdrant shopsage-embeddings
curl -fsS http://localhost:8080/info      # model_id, max_input_length
curl -fsS http://localhost:6333/readyz
```

| Property                                                      | How it was confirmed                      |
| ------------------------------------------------------------- | ----------------------------------------- |
| `health()` reports the running model and input limit          | `BAAI/bge-small-en-v1.5`, 512 tokens      |
| A model mismatch fails readiness with a remediation           | 503, remediation names `EMBEDDING_MODEL`  |
| A dimension mismatch is rejected before anything is stored    | `expectedDimensions: 1024, received: 384` |
| **Vectors are normalized** — cosine distance requires it      | magnitude `1.000000`                      |
| Documents embed across batches, in order                      | 5 documents, batch size 4                 |
| `createCollection` is idempotent                              | called twice, no error                    |
| Re-inserting the same ids upserts                             | count unchanged after re-insert           |
| Search returns the right chunk for a real question            | returns policy ranked first               |
| Caller ids come back; `_pointId` is hidden                    | ids all `sha256:…`                        |
| **Two stores in one collection cannot see each other**        | neither direction leaked                  |
| A score floor drops weak matches at the store                 | `minScore: 0.9` → 0 results               |
| Delete by id, and by tenant filter, leave other stores intact | other store still had its point           |
| A missing collection reports a remediation                    | 404 → names `QDRANT_COLLECTION`           |

Then the backend, which should probe both through the clients:

```bash
curl -fsS http://localhost:3000/health/ready
# {"status":"ok","checks":[{"name":"qdrant","status":"up",…},{"name":"embeddings","status":"up",…}]}

# And the case a URL probe cannot catch: point EMBEDDING_MODEL at a model the
# container is not serving, restart the backend, and expect 503 with the fix named.
EMBEDDING_MODEL=BAAI/bge-m3 npm run dev
curl -sS http://localhost:3000/health/ready | grep 'unexpected model'
curl -sS -o /dev/null -w '%{http_code}\n' http://localhost:3000/health   # still 200
```

That last line matters as much as the 503: liveness must stay green, or a dependency
misconfiguration becomes a restart loop.

### 2a-quater. Verify ingestion end to end against real services

Unit tests drive fakes throughout `@shopsage/ingestion`, so a real pass needs an actual site to crawl,
real Qdrant, and the real embedding gateway. This was run once, deliberately, against a small
four-page static site built for the purpose (returns policy, shipping, sale items, a help index, plus
`/cart` and `/checkout` which the crawl must exclude) and a golden-question set matched to it.

```bash
docker compose up -d shopsage-qdrant

# Point a site profile's content.sources at the throwaway site, then:
SITE_PROFILE_PATH=<profile with the test source> QDRANT_COLLECTION=shopsage_verify_check \
  node packages/ingestion/src/cli/ingest.js --verbose
```

| Property                                                      | Observed                                                                        |
| ------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| Crawl respects robots.txt and `exclude`                       | `/cart` and `/checkout` never fetched                                           |
| Four pages produce seven structure-aware chunks               | matches the page structure (headings split sections)                            |
| First run embeds every chunk                                  | 7 embedded, 4.5s                                                                |
| **Second run, unchanged corpus, embeds nothing**              | 0 embedded, 7 skipped, **0.3s**                                                 |
| A narrowed re-crawl (1 of 4 pages) refuses to prune           | logged: `coverage 0.25 < minimum 0.5`, 0 documents removed, all 7 points intact |
| `evaluate` against the real embeddings and real Qdrant search | **7/7 passed, recall@6 = 1, refusal accuracy = 1**, exit code 0                 |

The narrowed-crawl case is the one worth trusting least by default: it is a deliberately incomplete
run, and the correct outcome is that **nothing gets deleted** — verified by counting points in Qdrant
directly before and after, not by trusting the CLI's own report of what it did.

```bash
curl -s -X POST http://localhost:6333/collections/<test-collection>/points/count \
  -H 'content-type: application/json' -d '{"exact":true}'
```

### 2a-quinquies. Verify a grounded answer end to end

The Stage 6 verification, and the first one where every part of the system participates in a single
customer request: real LLM gateway, real embedding gateway, real Qdrant, real crawled content. Unit
tests cannot reach this — the ports are all doubles there by design.

Ingest the same four-page fake site into a throwaway collection, then boot the backend against it:

```bash
SITE_PROFILE_PATH=<profile with the test source> QDRANT_COLLECTION=shopsage_stage6_check \
  node packages/ingestion/src/cli/ingest.js --verbose
# documents 4  chunks 7 / embedded 7 skipped 0 / failures 0 / completed in 6.3s

SITE_PROFILE_PATH=<same profile> QDRANT_COLLECTION=shopsage_stage6_check PORT=3500 \
  node packages/rag-backend/src/server.js
```

**Readiness first**, because the new probe is the fastest way to catch a mismatched collection:

```bash
curl -s localhost:3500/health/ready
# {"status":"ok","checks":[{"name":"qdrant","status":"up","latencyMs":206},
#   {"name":"embeddings","status":"up","latencyMs":834},
#   {"name":"knowledge-collection","status":"up","latencyMs":74}]}
```

Then the three cases that matter, in this order:

```bash
# 1. A question the corpus answers.
curl -s -XPOST localhost:3500/v1/chat -H 'content-type: application/json' \
  -d '{"message":"How long do I have to return something?"}'
```

| Property                                    | Observed                                                                          |
| ------------------------------------------- | --------------------------------------------------------------------------------- |
| The answer comes from the crawled page      | _"You have thirty days from the delivery date to return unopened items…"_         |
| `sources` is populated, deduplicated by URL | 3 sources, the returns policy first                                               |
| Two gateway calls, not one                  | round 1 `finishReason: tool_calls`, 238 prompt tokens; round 2 `stop`, 544 tokens |
| The log records the turn's shape            | `grounded: true, sources: 3, toolRounds: 1, exhausted: false, historyTurns: 0`    |

The prompt growing from 238 to 544 tokens between the two calls is the retrieved context arriving. That
number is the evidence the tool loop actually fed the model content rather than the model answering from
its own knowledge and happening to be right — which is the failure this test exists to distinguish.

```bash
# 2. A question the corpus cannot answer.
curl -s -XPOST localhost:3500/v1/chat -H 'content-type: application/json' \
  -d '{"message":"Who is the chief executive of the company?"}'
```

| Property                   | Observed                                                         |
| -------------------------- | ---------------------------------------------------------------- |
| The store's no-answer copy | _"I could not find the answer to that. Would you like…a human…"_ |
| **No citations**           | `sources: []`                                                    |
| Logged as ungrounded       | `grounded: false, sources: 0, toolRounds: 0`                     |

`toolRounds: 0` here is worth reading carefully: the model declined to search at all rather than
searching and finding nothing. Both paths must produce the same customer-visible outcome, and this run
exercised the first.

```bash
# 3. A follow-up that is meaningless without history.
CID=$(curl -s -XPOST localhost:3500/v1/chat -H 'content-type: application/json' \
  -d '{"message":"How long does delivery take in the US?"}' | jq -r .conversationId)
curl -s -XPOST localhost:3500/v1/chat -H 'content-type: application/json' \
  -d "{\"message\":\"And internationally?\",\"conversationId\":\"$CID\"}"
```

| Property                         | Observed                                                                    |
| -------------------------------- | --------------------------------------------------------------------------- |
| The follow-up resolves correctly | _"International delivery typically takes seven to fourteen business days…"_ |
| History was replayed             | `historyTurns: 2` on the second turn, `0` on the first                      |
| Still grounded                   | `grounded: true`, shipping page cited                                       |

_"And internationally?"_ has no retrievable meaning on its own; it only works because the previous
question and answer were replayed to the model, which then phrased its own tool query. This is also the
partial answer to query rewriting in [RAG](RAG.md#deferred-decisions) — the model does some of it for
free, though a dedicated step would retrieve better.

Finally, drop the throwaway collection, since a stale one will satisfy the readiness probe later and
answer questions from content nobody remembers ingesting:

```bash
curl -s -X DELETE localhost:6333/collections/shopsage_stage6_check -H "api-key: $QDRANT_API_KEY"
```

### 2a-sexies. Verify streaming end to end

The Stage 7a verification. Unit tests cover framing and event order against a stubbed manager; what they
cannot show is **whether tokens actually arrive progressively**, which is the entire point of the
endpoint. A stream that buffers passes every unit test.

Set up as in the previous section, then drive it with a client that timestamps each event:

```bash
curl -N -X POST localhost:3000/v1/chat/stream \
  -H 'content-type: application/json' \
  -d '{"message":"How long do I have to return something?"}'
```

`-N` disables curl's own buffering — without it curl will make a working stream look broken.

Observed against the real gateway, real embeddings and real Qdrant:

```
status 200  content-type text/event-stream; charset=utf-8
x-accel-buffering no  cache-control no-cache, no-transform
   +70ms  start  {"conversationId":"c_0e05d1cd…","messageId":"m_a6eddc27…"}
 +1786ms  tool   {"name":"searchKnowledge","phase":"started"}
 +2910ms  tool   {"name":"searchKnowledge","phase":"finished"}
 +4295ms  delta  "You"          ← first token
 +4825ms  done   {"answer":"You have thirty days…","sources":[…3…],"finishReason":"stop"}
--- 48 delta events, first at +4295ms, total 4826ms ---
```

| Property                                | Observed                                         |
| --------------------------------------- | ------------------------------------------------ |
| Events arrive progressively             | Four distinct timestamps, not all at the end     |
| `start` precedes any model work         | +70ms, before the first gateway call             |
| `tool` events fill the pre-token gap    | Two events across the 4.3s before the first word |
| Deltas are many, not one                | 48 events over ~530ms                            |
| Total latency matches the buffered path | 4.8s streamed vs 4.9s buffered                   |

**The timestamps are the assertion.** If every event shares roughly one timestamp, something between the
handler and the client is buffering — most likely curl without `-N`, or a proxy
([Deployment](Deployment.md#streaming-through-a-proxy)).

Then the invariants a client depends on:

| Check                                     | Expected                                                   |
| ----------------------------------------- | ---------------------------------------------------------- |
| Deltas joined                             | Exactly equal to `done.answer`                             |
| `done` keys                               | `answer, conversationId, finishReason, messageId, sources` |
| Same question via `POST /v1/chat`         | Identical answer and identical sources                     |
| `grep grounded` / `usage` on the raw body | No match                                                   |
| Follow-up with `done.conversationId`      | Resolves from history, cites the right page                |

All five verified. The parity check is the one worth repeating after any change to the tool loop, since
it is what stops the two delivery modes drifting apart.

**Then the disconnect**, which is the case with the most ways to go wrong:

```bash
# Abort after the first delta, then read the server's logs.
node <a client that calls controller.abort() on the first delta>
```

| Property                                   | Observed                                                                     |
| ------------------------------------------ | ---------------------------------------------------------------------------- |
| The gateway call is cancelled, not ignored | No `llm completion` record for the interrupted round                         |
| Logged as ordinary                         | `client disconnected mid-stream` and `assistant turn abandoned`, both `info` |
| **Zero** `warn`/`error`/`fatal` records    | A closed tab is not a fault                                                  |
| Nothing persisted                          | A later question on the same `conversationId` has no history                 |

That third row is a regression check on a real defect: the first implementation logged the abort's
rejection as a stream failure, producing an `error` record with a stack trace every time a customer
closed a tab.

**Finally the feature flag**, with `features.streaming: false` in the profile:

| Request                | Expected                                                  |
| ---------------------- | --------------------------------------------------------- |
| `POST /v1/chat/stream` | 404 `NOT_FOUND`, `application/json` — not an event stream |
| `POST /v1/chat`        | 200, unaffected                                           |
| `GET /health/info`     | `enabledFeatures` no longer lists `streaming`             |

### 2a-septies. Verify conversations survive a second replica

The Stage 7b verification, and the only one that cannot be done with a single process. Unit tests drive
a fake Redis; what they cannot show is whether two backends genuinely share history.

```bash
docker compose up -d shopsage-redis shopsage-qdrant
# ...ingest as above, then start two backends against the same Redis:
for port in 3801 3802; do
  CONVERSATION_STORE=redis REDIS_URL=redis://127.0.0.1:6379 PORT=$port     node --env-file=.env packages/rag-backend/src/server.js &
done
```

Both must report the new probe:

```
ok | qdrant:up embeddings:up knowledge-collection:up conversations:up
```

**The test is a fact that cannot be retrieved**, so that retrieval cannot accidentally supply the answer.
Ask on one replica, recall on the other:

```bash
# replica 3801
{"message":"Please remember this for later: my reference code is TANGERINE-42."}
# replica 3802, same conversationId
{"message":"What reference code did I give you?"}
```

| Store                       | Answer from the second replica                    |
| --------------------------- | ------------------------------------------------- |
| `CONVERSATION_STORE=redis`  | _"You provided the reference code TANGERINE-42."_ |
| `CONVERSATION_STORE=memory` | _"I could not find the answer to that…"_          |

Both were run. The `memory` row is the control, and it is the reason this stage exists.

An earlier attempt used _"And internationally?"_ as the follow-up and the memory store **still answered
plausibly** — retrieval happened to cover it. That is precisely why the reference-code phrasing is used
instead: the interesting failure is not that history loss is obvious, it is that it usually is not.

Then the state itself, which should look exactly like the documented data model:

```bash
docker exec shopsage-redis redis-cli --scan --pattern 'shopsage:conv:*'
# shopsage:conv:demo-store:c_f62013dd…      ← siteId in the key
docker exec shopsage-redis redis-cli TYPE  shopsage:conv:demo-store:c_f62013dd…   # list
docker exec shopsage-redis redis-cli LLEN  shopsage:conv:demo-store:c_f62013dd…   # 4
docker exec shopsage-redis redis-cli TTL   shopsage:conv:demo-store:c_f62013dd…   # 3558
```

| Property                   | Observed                                                           |
| -------------------------- | ------------------------------------------------------------------ |
| Log on the writing replica | `historyTurns: 0, persisted: true`                                 |
| Log on the reading replica | `historyTurns: 2, persisted: true`                                 |
| TTL                        | Set from the profile, and counting down                            |
| Expiry                     | Force it with `EXPIRE key 1`; the next turn starts with no history |

**Then take Redis away**, which is where the interesting behaviour is:

```bash
docker compose stop shopsage-redis
```

| Check                                 | Expected                                                                   |
| ------------------------------------- | -------------------------------------------------------------------------- |
| `GET /health/ready`                   | 503 in ~5s, `conversations: down` naming the timeout                       |
| `GET /health`                         | **200** — liveness must never restart a working process                    |
| `POST /v1/chat`                       | 502, masked                                                                |
| `POST /v1/chat/stream`                | **502 JSON**, not an SSE `error` event — the read precedes the first event |
| `docker compose start shopsage-redis` | Readiness returns to 200 with **no backend restart**                       |

The first row is a regression check on a real defect: before every operation had a deadline,
`/health/ready` hung indefinitely here rather than reporting `down`.

Finally, production's refusal to guess:

```bash
NODE_ENV=production node --env-file=.env packages/rag-backend/src/server.js; echo $?
# {"level":"fatal","msg":"bootstrap failed","err":{"message":"Conversation store is not configured",
#  "details":{"missing":["CONVERSATION_STORE"],"remediation":"set CONVERSATION_STORE=redis …"}}}
# 1
```

Exit code 1, so an orchestrator does not route traffic to it.

### 2a-octies. Verify the limits, live

Unit tests drive the bucket against a fake clock; what they cannot show is the headers a real client
receives or the interaction with real answer latency.

Boot with tight limits, then send four questions against a limit of three:

```bash
RATE_LIMIT_MAX_REQUESTS=3 RATE_LIMIT_WINDOW_MS=60000 MAX_CONCURRENT_STREAMS_PER_CLIENT=1   node --env-file=.env packages/rag-backend/src/server.js
```

```
req 1 → 200  limit=3 remaining=2 reset=0s
req 2 → 200  limit=3 remaining=1 reset=16s
req 3 → 200  limit=3 remaining=0 reset=33s
req 4 → 429  limit=3 remaining=0 reset=50s retry-after=10
```

| Property                      | Observed                                                          |
| ----------------------------- | ----------------------------------------------------------------- |
| Headers on **every** response | `RateLimit-Limit/Remaining/Reset`, not only on the refusal        |
| `Retry-After` on the refusal  | 10s — **not** 20s, because tokens refilled during the ~5s answers |
| Refusal cost                  | 2–7ms, no gateway call                                            |
| Health polled five times      | `200 200 200 200 200` — never throttled                           |

The `retry-after=10` is worth reading rather than skimming: the configured rate is one token per 20s, and
roughly half of one had accrued while the earlier answers were being generated. A fixed window would have
said "wait until the top of the minute" regardless. That difference is the whole argument for a bucket.

**Then the two concurrency ceilings**, which need two requests genuinely in flight:

```bash
# MAX_CONCURRENT_STREAMS_PER_CLIENT=1 — start one stream, then a second before it finishes
```

| Configuration                | Second request                                                                 |
| ---------------------------- | ------------------------------------------------------------------------------ |
| per-client 1                 | `429`, `code: RATE_LIMITED`, `details.scope: client`                           |
| per-client 5, service-wide 1 | `503`, `code: SERVICE_UNAVAILABLE`, `details.scope: service`, `Retry-After: 5` |

Both were run. The second row is the one to check after any change to the guard: it is easy to write a
concurrency limit that reports everything as a 429 and thereby tells a blameless customer they are the
problem. In both cases the first stream completed normally.

### 2a-nonies. Verify authentication against a real issuer

The Stage 7d verification. The verifier's own suite is driven by the shared contract vectors, which is
the strongest test in the project — but it cannot show the wiring: which routes are covered, what a
client is told, and what is logged.

Stand up something that behaves like the Magento module — minting real ES256 tokens and publishing a
real JWKS — then point the backend at it:

```bash
AUTH_ENABLED=true AUTH_ISSUER=http://127.0.0.1:8700 AUTH_AUDIENCE=shopsage-demo-store AUTH_JWKS_URL=http://127.0.0.1:8700/assistant/.well-known/jwks.json   node --env-file=.env packages/rag-backend/src/server.js
```

Readiness gains a fifth probe:

```
ok | qdrant:up embeddings:up knowledge-collection:up conversations:up session-keys:up
```

Then the matrix. Observed, against the real gateway and real Qdrant behind it:

| Case                  | HTTP  | Code                | Answer                                             |
| --------------------- | ----- | ------------------- | -------------------------------------------------- |
| Valid token           | `200` | —                   | _"You have thirty days from the delivery…"_        |
| No token              | `401` | `UNAUTHORIZED`      | —                                                  |
| Garbage token         | `401` | `UNAUTHORIZED`      | —                                                  |
| Expired               | `401` | **`TOKEN_EXPIRED`** | —                                                  |
| Another store's `sid` | `401` | `UNAUTHORIZED`      | —                                                  |
| Wrong audience        | `401` | `UNAUTHORIZED`      | —                                                  |
| `alg: none`           | `401` | `UNAUTHORIZED`      | —                                                  |
| Guest (`chat` only)   | `200` | —                   | Full knowledge-base answer                         |
| **No usable scope**   | `200` | —                   | _"I don't have information on the return policy…"_ |

**The last row is the one to check after any change to capability gating**, because it is not what a
reader expects a scope failure to look like. The token was valid and the request succeeded; the
`searchKnowledge` tool was simply absent, and the log confirms it — `toolRounds: 0`, `grounded: false`,
`sources: 0`. No retrieval was attempted at all.

Then the log, which is where the graded severities live:

```
info   missing_token          ← ordinary
info   unreadable_header      ← ordinary
info   expired                ← every customer, every 15 minutes, by design
warn   audience_mismatch      ← suspicious
error  tenancy_violation      ← another store's token. Base rate zero
error  algorithm_none         ← an attack. Base rate zero
```

| Check                         | Expected                                                      |
| ----------------------------- | ------------------------------------------------------------- |
| JWKS fetches for ~10 requests | **2** — verification is local, not a per-request Magento call |
| Subjects in the log           | `ps_…` pseudonyms                                             |
| `grep '@'` over the whole log | No match — no email address anywhere                          |
| A rejection body              | Never names the failed check; the reason is log-only          |

The last row was a **real leak** before it was a test: a 401 is an exposed error, so the reason in
`details` was being published. Assert it under `NODE_ENV=production`, where the guarantee has to hold.

### 2a-decies. Verify the widget in a real browser

The Stage 8 verification, and the only one in the project that needs a browser. The suite covers
markdown, SSE decoding, the API client and session storage against a hand-written DOM; what it
cannot reach is `customElements`, `attachShadow`, focus, layout and the cascade.

Driven over the **DevTools protocol** rather than with a headless screenshot, because that gives
programmatic access to the shadow root and to the page's console:

```bash
npm run build -w @shopsage/widget

# Serve the demo page and the bundle from one origin, standing in for a storefront.
# Point it at a running backend and at something that mints session tokens.
chrome --headless=new --remote-debugging-port=9333 --user-data-dir=/tmp/p about:blank
# then drive it: Page.navigate, Runtime.evaluate against el.shadowRoot
```

| Check                              | Observed                                                            |
| ---------------------------------- | ------------------------------------------------------------------- |
| Element registered and mounted     | `defined: true, mounted: true, hasShadow: true`                     |
| Config applied                     | launcher `Ask us`, heading `Sage`, welcome `Hi! I'm Sage.`          |
| Panel starts closed                | `panelHidden: true`                                                 |
| ARIA structure                     | `dialog` / `aria-modal="false"` / `log` / `polite` / `tabindex="0"` |
| Opening moves focus                | `focused: TEXTAREA`                                                 |
| **Status phases during a turn**    | `Sage is thinking` → `Searching the help centre`                    |
| **A real streamed answer**         | _"You have thirty days from the delivery date…"_                    |
| Citations                          | 3 sources, `rel="noopener noreferrer"`                              |
| Conversation persisted             | `sessionStorage` holds `c_25bc935a38…`                              |
| **Survives a page reload**         | Same id, and a follow-up answered from history                      |
| Mobile at 375×667                  | Panel fills the width, radius `0px`, composer above the fold        |
| Desktop again                      | `380px`, radius `12px`                                              |
| Host CSS overrides the store brand | `rgb(185, 28, 28)` — the page's colour, not the profile's           |
| Escape closes                      | Focus returns to `launcher`                                         |
| Console                            | **No output at all**                                                |

**Three of those rows are regression checks on real defects**, and all three were invisible in
the code:

- `welcome: Hi! I'm Sage.` — it read `Hi! I'm {{assistantName}}.` until the config route applied
  the same `renderTemplate` the domain uses.
- `Host CSS overrides the store brand` — it did not. Brand colours were inline styles on the
  element, and inline styles beat any stylesheet, so the store's brand was unoverridable.
- `Focus returns to launcher` — it returned to `document.body`, which drops focus to the top of
  the page.

The console row matters as much as the rest: a widget that works while logging errors is a widget
whose next failure nobody notices.

**A note on the harness.** The demo puts the token endpoint on a different origin from the host
page, so the token fetch is blocked until that endpoint sends CORS headers — the widget correctly
showed the store's `fallbackMessage` rather than crashing. A real storefront serves it
same-origin. That is a genuine integration requirement the session-token contract had assumed
away, now recorded in [Widget](Widget.md#integration).

### 2a-undecies. Verify commerce reads against the reference connector

The Stage 9a verification, and the one that found four defects unit tests could not. Everything below
runs the **real** client over **real** HTTP against the reference connector, with a **real** model
writing the answers — the only stubbed thing is the catalogue's contents.

```bash
docker compose --profile reference up -d
# .env:
#   MAGENTO_API_URL=http://shopsage-reference-connector:8750
# config/site-profile.json: productSearch, productComparison, recommendations, orderTracking → true
```

**Boot record.** One line, and it should name the features that made the connector mandatory:

```
commerce connector configured {"host":"shopsage-reference-connector:8750",
  "features":["productSearch","productComparison","recommendations","orderTracking"],
  "timeoutMs":5000,"identifiesItself":false}
```

The field is called `identifiesItself` rather than anything clearer because the logger's key redactor
matches `token`, `auth`, `credential`, `secret`, `key`, `bearer` and `signature` — two earlier names for
this boolean were published as `"[redacted]"`. Worth knowing before adding a field to any boot record.

**A product question:**

```bash
curl -s -X POST http://127.0.0.1:3000/v1/chat -H 'content-type: application/json'   -d '{"message":"do you sell waterproof walking jackets?"}'
```

Expect the price quoted **exactly** as the connector formatted it (`£120.00 including tax`), the
availability in the connector's own words, and the product link present.

**The three arithmetic refusals.** These are the checks worth running on any prompt or model change,
because the general rule alone was **not** enough — the middle one is how that was discovered:

| Ask                                           | Expected                                       |
| --------------------------------------------- | ---------------------------------------------- |
| "how much would three of them cost in total?" | Declines; says the basket will show the total  |
| "which is cheaper and by how much?"           | Names the cheaper one, gives **no** difference |
| "what percentage cheaper is X than Y?"        | Declines explicitly                            |

Before the compare-specific wording was added, the second answered _"cheaper by £31.00"_.

**Scope gating, live:**

```bash
curl -s -X POST http://127.0.0.1:3000/v1/chat -H 'content-type: application/json'   -d '{"message":"where is my order 000001234?"}'
```

With authentication disabled the session holds `chat` only, so `trackOrder` is **absent** and the
assistant says it cannot look an order up. It must not describe an order it never fetched.

**Redaction, in real storage.** The check that matters, because the failure is invisible in the response:

```bash
CID=$(curl -s -X POST http://127.0.0.1:3000/v1/chat -H 'content-type: application/json'   -d '{"message":"email me at sam@example.com and my card is 4242 4242 4242 4242"}'   | python -c "import sys,json; print(json.load(sys.stdin)['conversationId'])")
docker compose exec -T shopsage-redis redis-cli --raw LRANGE "shopsage:conv:demo-store:$CID" 0 -1
```

Expect `"content":"email me at [removed] and my card is [removed]"`. The reply the customer received is
**not** redacted — that is the point, and it is worth confirming both halves.

**A connector outage:**

```bash
docker compose stop shopsage-reference-connector
curl -s -X POST http://127.0.0.1:3000/v1/chat -H 'content-type: application/json'   -d '{"message":"got any hoodies?"}'
```

Expect a **200** with an honest "I could not look that up", `tool execution failed` in the backend log,
and `/health/ready` **unaffected** — a commerce outage must not pull instances that can still answer
from store content. Then `docker compose start shopsage-reference-connector`.

**A misconfiguration:** blank `MAGENTO_API_URL` with a commerce feature on should refuse to boot and name
the feature. This is the counterpart to degrading failures into answers — see
[ADR 0028](adr/0028-commerce-reads-behind-one-adapter.md).

### 2a-duodecies. Verify the cart, propose to confirm

The Stage 9b verification, and the one that found the two defects the suite could not. It needs a session
that holds the `cart` scope, which means **authentication on**: with it off there is no token to forward
and the connector correctly refuses an unauthenticated cart write.

Stand up something that mints real ES256 tokens against the shared fixture's key and publishes its JWKS —
the same stand-in §2a-nonies uses, plus a `sub` and `scope` parameter so two sessions can be told apart.
Then:

```bash
docker compose --profile reference up -d
# .env:
#   AUTH_ENABLED=true
#   AUTH_ISSUER=https://store.example.com
#   AUTH_AUDIENCE=shopsage-demo-store
#   AUTH_JWKS_URL=http://host.docker.internal:8700/jwks.json
#   MAGENTO_API_URL=http://shopsage-reference-connector:8750
# config/site-profile.json: cart and coupons → true
```

Readiness gains a sixth probe, and the proposal store is in it:

```
degraded | qdrant:up embeddings:up knowledge-collection:down conversations:up cart-proposals:up session-keys:up
```

**The happy path.** Observed, with a real model and the reference connector:

| Step                        | Result                                                                 |
| --------------------------- | ---------------------------------------------------------------------- |
| _"add two of JK-WPF-GRN-M"_ | `proposal.summary`: `2 × Waterproof shell jacket… at £120.00 each`     |
| Assistant's prose           | _"I have prepared… Please confirm to proceed."_ — never "I have added" |
| `POST /v1/cart/confirm`     | `applied` · _"Added to your basket."_ · total **£240.00**              |
| Confirm again               | `gone`                                                                 |

That £240.00 is the **connector's** figure. Nothing on ShopSage's side multiplied anything, which is the
point of §5 of the contract and of [ADR 0028](adr/0028-commerce-reads-behind-one-adapter.md).

**Two sessions.** Mint tokens for `ps_alice` and `ps_bob`, both with `cart`:

| Step                              | Result                                 |
| --------------------------------- | -------------------------------------- |
| alice prepares                    | `cp_…`                                 |
| **bob** confirms alice's proposal | `gone` — refused                       |
| alice confirms her own            | `applied` — **survives bob's attempt** |
| alice again                       | `gone`                                 |

The third row is the fix for a real defect. Before it, bob's refused attempt consumed the proposal and
alice could never confirm her own change.

**The rest of the matrix:**

| Case                            | Result                                                                                        |
| ------------------------------- | --------------------------------------------------------------------------------------------- |
| Guest (`chat` only)             | `403 FORBIDDEN` on confirm; neither cart tool is ever offered                                 |
| No cart feature enabled         | `404` — the route is not mounted                                                              |
| Coupon `SAGE10`                 | `applied` · _"SAGE10 applied — 10% off this order."_ (the store's wording)                    |
| Coupon `NOTREAL99`              | `rejected` · _"We could not apply NOTREAL99…"_ — and the assistant never claimed it was valid |
| `code` in the wire payload      | **absent**                                                                                    |
| Streamed turn                   | `start`, `tool`, `tool`, **`proposal`**, 130 × `delta`, `done`                                |
| _"add X and also apply SAGE10"_ | One proposal. _"Once you confirm, I can then apply the coupon code."_                         |

That last row is the one-proposal-per-turn rule producing exactly the behaviour its refusal message was
written for.

**What to re-run after any change here:** the two-session rows and the double-tap. They are the ones
protecting money, and both were wrong at some point during this stage.

### 2a-terdecies. Verify metrics against real traffic

The Stage 10a verification. Unit tests cover the exposition format and every decorator; what they cannot
show is whether the numbers mean anything.

```bash
# .env:
#   METRICS_ENABLED=true
#   METRICS_TOKEN=local-development-metrics-token
docker compose --profile reference up -d
```

Boot record: `metrics endpoint configured {"path":"/metrics","guarded":true}`.

**The guard:**

| Request                | HTTP                                                               |
| ---------------------- | ------------------------------------------------------------------ |
| No credential          | `401`                                                              |
| Wrong credential       | `401`                                                              |
| Correct credential     | `200`                                                              |
| Credential of one byte | `401` — not a `500`, which is what a naive `timingSafeEqual` gives |

**Then generate traffic** — two buffered turns, one streamed, a config fetch and one request to a path that
does not exist — and scrape. Observed:

```
shopsage_assistant_turns_total{mode="buffered",outcome="ungrounded",site="demo-store"} 2
shopsage_assistant_turns_total{mode="streamed",outcome="ungrounded",site="demo-store"} 1
shopsage_llm_tokens_total{kind="prompt",model="gpt-4o-mini",site="demo-store"} 6862
shopsage_llm_tokens_total{kind="completion",model="gpt-4o-mini",site="demo-store"} 305
shopsage_dependency_calls_total{dependency="retrieval",operation="retrieve",outcome="error",…} 1
shopsage_http_requests_total{method="GET",route="other",site="demo-store",status="404"} 1
shopsage_assistant_time_to_first_token_ms_sum{site="demo-store"} 2505
shopsage_assistant_turn_duration_ms_sum{mode="buffered",site="demo-store"} 7476
shopsage_assistant_turn_duration_ms_sum{mode="streamed",site="demo-store"} 3624
```

**Read those numbers, because they are the point of the stage.** Every one of those three turns returned
`200`. All three were **ungrounded**, and one retrieval **failed** — the knowledge collection was not
ingested in that container. Readiness already said `knowledge-collection:down`; nothing had connected that
to the answers customers were getting.

The last three lines are Stage 7a's argument as a measurement: 2.5s to the first token on a streamed turn,
against 3.7s average of a buffered turn showing nothing at all.

**Two checks worth running every time:**

- `route="other"` after requesting several nonexistent paths, and **no** series containing those paths.
  This is the cardinality guard, and it is the one that takes a monitoring system down if it regresses.
- `grep -cE "c_[0-9a-f]{16}|ps_|ORD-"` over the scrape returns **0**. A metric label is aggregate by
  definition; anything identifying in one is both a leak and a cardinality bomb.

**A consistency check that needs no extra metric:** `llm_tokens_per_call_count` should equal
`dependency_calls_total{dependency="llm"}` summed over operations. Divergence _is_ the count of gateway
calls that reported no usage — which is what `LLM_STREAM_INCLUDE_USAGE=false` produces.

### 2a-quaterdecies. Verify the crawler against a real production site

Everything above exercises the scraper against synthetic fixtures. This is the one check that cannot
be: whether the crawler, fetcher, and text extractor survive a real, uncontrolled storefront's HTML —
which is a materially different test than any fixture a test author would think to write, because a
test author writes the malformed cases they can imagine, and a real site serves the ones they can't.

```bash
npm run ingest -- --verbose
```

The first run against a real site profile failed on every page:

```
crawl started {"seeds":2167,"allowedHosts":[...],"maxPages":50,"maxDepth":3}
crawl finished {"visited":50,"emitted":0,"skipped":0,"failed":50,"remainingInFrontier":3356}
```

every failure `TypeError: fetch failed` / `HeadersOverflowError` — fixed by
[ADR 0031](adr/0031-crawler-scoped-header-size.md). The next run no longer failed, but still emitted
nothing:

```
crawl finished {"visited":50,"emitted":0,"skipped":50,"failed":0,"remainingInFrontier":3356}
```

`--verbose` debug logging (`logger.debug('page skipped', { url, reason, textLength })`, added to
`crawl.js` specifically to answer this) showed every one of the 50 visited pages skipped for
`"reason":"too little text","textLength":0` — not thin, exactly zero, including ordinary category
pages with visibly substantial copy. That traced to `node-html-parser` silently failing to attach a
real, present `<main>` element to its own parsed tree — fixed by
[ADR 0032](adr/0032-linkedom-instead-of-node-html-parser.md).

After both fixes, the same real site profile, unchanged:

```
crawl finished {"visited":50,"emitted":50,"skipped":0,"failed":0,"remainingInFrontier":3356}
source finished {"documents":50,"chunksTotal":299,"chunksEmbedded":299,"chunksSkipped":0,"failures":0}
```

and Qdrant's knowledge collection held 299 points afterward, up from 0 — checked directly against
`GET /collections/<name>` on the running container, not inferred from the ingestion log.

**What this run does not prove:** that 50 pages is representative of the other ~3,300 still in the
frontier, or that some other real site's malformed HTML does not find a gap `linkedom` has too. It
proves the specific failure mode this stage found (silent, zero-error, zero-text extraction from a
present element) is closed for the input that exposed it — not that no other input ever could expose a
different one. A crawl against real, unbounded input is the one place this project's test suite
cannot substitute for actually running it.

### 2b. Verify against a stub gateway

To exercise the retry path, the 401 path and prompt assembly without spending anything, run a stub that
answers 503 once and then normally. Point `LLM_BASE_URL` at it and confirm:

| Observation                                                          | Meaning                                            |
| -------------------------------------------------------------------- | -------------------------------------------------- |
| The stub is called **twice** for one request                         | The 503 was retried                                |
| A `warn` record `llm request failed, retrying` with a delay          | Backoff ran, with jitter                           |
| The stub sees `system:` with the company and assistant name resolved | Copy comes from the profile, placeholders included |
| The stub sees `temperature: 0.2`                                     | The profile/env sampling settings are applied      |
| With `LLM_AUTH_STYLE=api-key`, the stub 401s and is called **once**  | A 4xx is not retried                               |
| That request returns 502 with a generic message                      | Gateway detail never reaches a customer            |
| The log for it carries `remediation: check LLM_API_KEY…`             | The operator is told what to fix                   |

### 3. Docker stack

See [Docker](Docker.md#verification) for the full command list. Expected outcomes:

| Check                                          | Expected                                              |
| ---------------------------------------------- | ----------------------------------------------------- |
| `docker compose config --quiet` (both modes)   | Exit 0, no output                                     |
| `docker compose build shopsage-backend`        | Builds; image ≈ 240 MB                                |
| `GET /health`                                  | 200                                                   |
| `GET /health/info`                             | Site profile from the mounted `config/`               |
| `GET /health/ready` before the model downloads | 503, `embeddings: down`                               |
| `GET /health/ready` after                      | 200, both `up`                                        |
| `docker inspect ... .State.Health.Status`      | `healthy`                                             |
| `docker compose stop shopsage-backend`         | Logs show `shutdown started` then `shutdown complete` |

### 4. Configuration failure cases

Each of these must **exit non-zero at boot** with one JSON line on stderr naming the problem:

```bash
SITE_PROFILE_PATH=./nope.json npm start            # Unable to read configuration file
PORT=99999 npm start                               # Environment configuration is invalid: PORT
LOG_LEVEL=verbose npm start                        # invalid enum value
LLM_BASE_URL=ftp://host npm start                  # must be an absolute http(s) URL
LLM_TEMPERATURE=5 npm start                        # must be <= 2

# With no gateway configured at all: all three named in one message.
env -u LLM_API_KEY -u LLM_BASE_URL -u LLM_MODEL npm start
# {"msg":"bootstrap failed","err":{"message":"LLM gateway configuration is incomplete",
#  "details":{"missing":["LLM_API_KEY","LLM_BASE_URL","LLM_MODEL"],"remediation":"…"}}}

# A blank credential is *absent*, not empty — the same failure, not a 401 later.
LLM_API_KEY= npm start                             # missing: ["LLM_API_KEY"]
```

Then corrupt the profile and confirm the error names the exact key:

```bash
node -e "const f='config/site-profile.json',fs=require('fs');const p=JSON.parse(fs.readFileSync(f));p.retrieval.topk=5;fs.writeFileSync('/tmp/bad.json',JSON.stringify(p))"
SITE_PROFILE_PATH=/tmp/bad.json npm start          # Site profile is invalid: retrieval - unrecognized key
```

That last case is the important one: an unknown key must be an error, because silently ignoring
`topk` while `topK` keeps its default is the kind of bug that surfaces months later as "retrieval
tuning doesn't do anything".

### 5. Edge cases worth exercising by hand

| Case                  | Command                                                                                            | Expected                         |
| --------------------- | -------------------------------------------------------------------------------------------------- | -------------------------------- |
| Unknown route         | `curl -i localhost:3000/nope`                                                                      | 404, `NOT_FOUND` envelope        |
| Malformed JSON        | `curl -i -XPOST -H 'content-type: application/json' -d '{' localhost:3000/health`                  | 400, `VALIDATION_FAILED`         |
| Oversized body        | `curl -i -XPOST -H 'content-type: application/json' --data-binary @big.json localhost:3000/health` | 413                              |
| Trace continuation    | `curl -i -H 'x-request-id: my-trace-1' localhost:3000/health`                                      | Same id echoed back              |
| Log injection attempt | `curl -i -H "x-request-id: $(printf 'a%.0s' {1..400})" localhost:3000/health`                      | Fresh UUID instead               |
| Blocked CORS origin   | `curl -i -H 'origin: https://evil.example' localhost:3000/health`                                  | No `access-control-allow-origin` |
| Graceful shutdown     | `kill -TERM <pid>`                                                                                 | `shutdown complete`, exit 0      |

### 5a. Chat edge cases

| Case                    | Body                                                   | Expected                                       |
| ----------------------- | ------------------------------------------------------ | ---------------------------------------------- |
| Empty message           | `{"message":""}`                                       | 400, issue path `message`                      |
| Whitespace-only message | `{"message":"   "}`                                    | 400 — trimmed before validation                |
| Oversized message       | `{"message":"<2001 chars>"}`                           | 400 — the profile ceiling, not a constant      |
| Unknown field           | `{"message":"hi","temperature":2}`                     | 400 — no parameter smuggling                   |
| Hostile conversation id | `{"message":"hi","conversationId":"../../etc/passwd"}` | 400 — it **is** a storage key now              |
| Continued conversation  | `{"message":"and abroad?","conversationId":"c_…"}`     | 200, same id echoed back, `historyTurns` > 0   |
| Unknown conversation id | `{"message":"hi","conversationId":"c_never-seen"}`     | 200, `historyTurns: 0` — not a 404             |
| Unreachable gateway     | point `LLM_BASE_URL` at a dead port                    | 502 masked after 3 attempts, ~2 retry warnings |
| Slow gateway            | stub that never responds, `LLM_TIMEOUT_MS=2000`        | 504 `TIMEOUT` after ~2 s, **one** attempt only |
| Missing collection      | `QDRANT_COLLECTION=does_not_exist`                     | `/health/ready` 503 naming the ingest command  |
| Qdrant unreachable      | `QDRANT_URL=http://127.0.0.1:6399`                     | **200**, not 502 — see below                   |

### 5b. Streaming edge cases

| Case                        | Request                                       | Expected                                                   |
| --------------------------- | --------------------------------------------- | ---------------------------------------------------------- |
| Same validation as buffered | `{"message":""}`                              | 400 JSON envelope — **not** an event stream                |
| Streaming disabled          | `features.streaming: false`                   | 404 `NOT_FOUND`, `application/json`                        |
| Client aborts               | close the connection after the first delta    | 2 `info` records, no history written, no `error` record    |
| Unreachable gateway         | point `LLM_BASE_URL` at a dead port           | 502 JSON envelope — the failure precedes the first event   |
| Gateway dies mid-answer     | stub that closes the stream after some deltas | 200, then an `error` event; the deltas already sent stand  |
| curl without `-N`           | `curl -XPOST …/v1/chat/stream` (no `-N`)      | Everything lands at once — **curl's** buffering, not a bug |

That last row is worth knowing before anyone reports streaming as broken: curl buffers by default, and
the symptom is identical to a buffering proxy.

That Qdrant row above is the one that surprises people, so it was verified rather than reasoned about.
With Qdrant pointed at a dead port and the real LLM gateway otherwise intact:

```
readiness  503  qdrant: down "Vector store health check is unreachable"
                knowledge-collection: down
                embeddings: up

POST /v1/chat  200 in 4947ms
{"answer":"I could not find the answer to your question about the return policy
  duration. Would you like me to connect you with a human for assistance?","sources":[]}

log  tool execution failed   tool=searchKnowledge  UpstreamError ECONNREFUSED 127.0.0.1:6399
log  assistant answered      grounded=false sources=0 toolRounds=1 exhausted=false
```

A dead vector store does **not** fail the request. The tool throws, the loop converts the throw into a
tool result, and the model tells the customer it could not look something up. Readiness reports
`qdrant: down` so the instance is pulled out of the load balancer, while a request already in flight
degrades instead of erroring — which is the whole point of
[ADR 0022](adr/0022-bounded-tool-loop.md)'s "a tool failure becomes a tool result".

Two details worth knowing. The 502 in the log is the _internal_ error's status as it was caught and
recorded; the HTTP response was 200, and the access log confirms it. And the 4.9s includes **6 retry
attempts** against the dead port — the vector store's own retry policy runs before the tool gives up, so
a hard-down Qdrant costs about as much wall-clock as a successful grounded answer rather than failing
fast. Acceptable, but it means a Qdrant outage does not shed load.

### 6. Secret redaction

The highest-value manual check, because a leak here is silent. Three separate paths can leak the
credential, so check all three:

```bash
# 1. Boot and normal operation.
LLM_API_KEY=sk-should-never-appear LOG_LEVEL=debug npm run dev 2>&1 | grep -c 'sk-should-never-appear'
```

Expected: `0`.

```bash
# 2. A gateway that quotes the key back, the way real providers do. Point LLM_BASE_URL at a stub
#    responding 401 with: {"error":{"message":"Incorrect API key provided: sk-should-never-appear"}}
#    then ask a question and grep the logs again.
```

Expected: `0`. The record should show `upstreamBody` containing `[redacted]` in place of the key,
alongside the remediation hint.

```bash
# 3. A config object logged wholesale.
node -e "import('@shopsage/platform').then(({createLogger})=>createLogger().info('cfg',{env:process.env}))" \
  | grep -c 'sk-should-never-appear'
```

Expected: `0`.

And the counterpart check, that redaction has not gone too far:

```bash
npm run dev 2>&1 | grep 'llm completion' | grep -c 'redacted'
```

Expected: `0` — token counts are measurements, and a redactor that eats them is broken, not safe.

## Known gaps

- **No CI pipeline yet.** `npm run verify` is the intended gate; wiring it to GitHub Actions is a
  Stage 10 task.
- **No coverage threshold enforced.** Coverage is measurable (`npm run test:coverage`) but not gated.
- **No automated tests against real services.** Every LLM, embeddings and Qdrant test drives a scripted
  `fetch`, which proves ShopSage's behaviour and proves nothing about a given endpoint's conformance.
  "OpenAI-compatible" gateways differ most in streaming and tool-call encoding, and TEI and Qdrant both
  have version-specific quirks, so **each deployment needs verifying by hand** — §2a-bis, §2a-ter and
  §2b are the script. Automating them needs a service-backed test profile, which is a Stage 10 task.
- **No retrieval quality measurement.** The scores in [RAG](RAG.md) come from one hand-built five-sentence
  corpus. That is enough to show the ranking works and that intuition about thresholds is wrong; it is
  nowhere near enough to tune anything. The golden question set in Stage 5 is the fix.
- **`bge-m3` itself is unverified end to end.** It could not complete warm-up on the development machine
  (see [Docker](Docker.md#when-out-of-memory-leaves-no-oom-evidence)), so the real-service checks ran
  against `bge-small-en-v1.5`. The dimension and model guards were exercised in both directions, but the
  shipped default model has not itself been run.
- **No load or soak testing.** The LLM path now exists and dominates latency, so this is worth doing
  from Stage 7c, once rate limiting defines the concurrency shape.
- **No contract tests against the real Magento module.** Still blocked on that repository existing. The
  reference connector narrows the gap — both sides now have a runnable specification to compare against
  rather than prose — but nothing yet proves the real module agrees with it. That is the first thing to
  build when the repository appears.
- **The price rule is verified by hand, not automatically.** The tests pin the _prompt and tool text_,
  which is deterministic. Whether a given model obeys it is not, and the one measurement that matters
  needs a live model: §2a-undecies is the script. A model or prompt change invalidates it, and the
  regression it protects against is a wrong number about money in the store's own voice.
- **Personal-data redaction does not detect free-text addresses**, and the code says so rather than
  implying otherwise. See [ADR 0028](adr/0028-commerce-reads-behind-one-adapter.md); the defence there is
  structural.
- **The cart path is verified by hand, and it is the path that spends money.** The unit tests cover the
  proposal lifecycle, the ownership check, the take-once consume and the widget card, but the two defects
  this stage found were both _wiring_ — a field missing from one of two call sites, and an ordering
  consequence visible only with two real sessions. §2a-duodecies is the script, and it needs a token
  issuer that can mint distinct subjects. Automating it needs a service-backed test profile, which is
  the same Stage 10 task the other real-service checks are waiting on.
- **Nothing alerts.** Stage 10a made the numbers visible and nobody is told when they move. A falling
  grounded rate is exactly the failure this project has spent nine stages designing against, and it is now
  observable rather than observed. Alerting rules are Stage 10d, along with the spend ceiling that is the
  other half of open decision 8.
- **No coverage threshold is enforced.** `npm run test:coverage` works and nothing gates on it, so nobody
  knows where the 1098 tests are thin. Stage 10b measures first and picks a floor from what it says — a
  number chosen before measuring is a number that gets lowered.
- **Nothing tests two replicas sharing a proposal store.** The Redis implementation is unit-tested against
  a fake that implements `GETDEL` for real, and §2a-septies proves the _conversation_ store works across
  processes — but the specific failure of a confirmation reaching an instance that never saw the proposal
  has not been reproduced. It is the reason the proposal store follows `CONVERSATION_STORE` rather than
  having its own switch.
- **No retrieval-quality evaluation.** From Stage 5 this becomes the most important kind of testing
  in the project: a golden question set with expected sources, so prompt and chunking changes can be
  measured instead of guessed at. Tracked in [Roadmap](Roadmap.md).
