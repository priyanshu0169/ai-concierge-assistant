# Proposal 0001: The assistant session token

**Status: ACCEPTED — this is the authentication specification for ShopSage.**
Proposed: 2026-08-03 · Accepted: 2026-08-03
Owner: ShopSage
Accepted by: project owner, on behalf of the Magento module

Every recommendation below was accepted as written, and all seven open questions were
answered — see [Decisions](#decisions-as-accepted). This document is now the implementation
contract for both codebases rather than a draft: a change to it is a change to an interface
two repositories depend on, and needs the same review this did.

Resolves [Roadmap](../Roadmap.md) open decision 2. Recorded as a decision in
[ADR 0026](../adr/0026-magento-issued-session-tokens.md); implemented in ShopSage Stage 7d.

## Decisions as accepted

| #   | Question            | Decision                                                                    |
| --- | ------------------- | --------------------------------------------------------------------------- |
| 1   | Signing algorithm   | **ES256.** Stay open to RS256 later; **never HS256**                        |
| 2   | `sub` a pseudonym   | **Yes.** No customer id, email or other PII. Forward the token for identity |
| 3   | Pseudonym stability | **Session-stable.** Constant for a Magento session, new on a new one        |
| 4   | Key custody         | Magento is the sole issuer and sole holder of the private key               |
| 5   | Guest tokens        | **Yes**, accepting that chat depends on Magento issuing them                |
| 6   | Revocation window   | **Accepted:** 15-minute lifetime, refresh at ~80%, ±60s skew                |
| 7   | Audience naming     | **Store-specific:** `shopsage-<store-id>`                                   |
|     | Shared test vectors | **Approved**, expanded to eight cases — see §14                             |

Two consequences of decision 2 worth stating plainly, because they constrain future work:
ShopSage must **never** persist or log anything that identifies a customer, and any tool
needing customer data must forward the token to Magento rather than resolve identity itself.

---

## 1. The problem

The widget runs in the customer's browser, on the storefront, and calls ShopSage
cross-origin. ShopSage needs to know three things about a request:

1. **Which store** it belongs to — for tenancy, once one deployment serves several.
2. **Whether it is a real storefront session** — for abuse and cost control.
3. **What it is allowed to do** — a guest must not be able to read somebody's orders.

Only Magento knows any of that. The widget cannot be trusted to assert it: anything the
browser sends, a customer can change. So Magento must vouch for the session in a way
ShopSage can verify without asking Magento on every request.

The failure mode being designed against is precise. If the widget could say "I am customer
41," then anyone could say "I am customer 41," and the Stage 9 `trackOrder` tool becomes an
order-history disclosure endpoint for the entire store.

## 2. Principles

Five, and they explain most of the specific choices below.

| Principle                                      | Consequence                                                        |
| ---------------------------------------------- | ------------------------------------------------------------------ |
| The browser never asserts identity             | Magento signs; ShopSage verifies; the widget only carries          |
| ShopSage should not learn who the customer is  | `sub` is an opaque pseudonym, not a customer id — see §4.2         |
| ShopSage must not be able to forge a token     | Asymmetric signing; ShopSage holds only a public key               |
| A Magento outage must not stop the assistant   | Self-contained tokens, cached keys, no per-request call to Magento |
| Wrong configuration must fail loudly, not open | Pinned algorithm, pinned issuer and audience, no fallbacks         |

## 3. The flow

```
   Browser (storefront)              Magento module                ShopSage
        │                                  │                          │
        │  1. GET /assistant/session       │                          │
        │     (same-origin, Magento        │                          │
        │      session cookie)             │                          │
        │─────────────────────────────────▶│                          │
        │                                  │ mints + signs a JWT      │
        │◀─────────────────────────────────│                          │
        │     { token, expiresAt }         │                          │
        │                                  │                          │
        │  2. POST /v1/chat                │                          │
        │     Authorization: Bearer <jwt>  │                          │
        │──────────────────────────────────┼─────────────────────────▶│
        │                                  │                          │ verify locally
        │                                  │◀─── 3. GET /assistant/   │ (cached JWKS)
        │                                  │        .well-known/      │
        │                                  │        jwks.json         │
        │                                  │     (cached ~10 min,     │
        │                                  │      not per request)    │
        │◀─────────────────────────────────┼──────────────────────────│
        │     answer                       │                          │
```

Step 3 is the only call ShopSage makes to Magento for authentication, and it is cached. A
Magento outage does not stop the assistant answering knowledge-base questions with keys it
already holds.

## 4. The token

### 4.1 Header

| Field | Value            | Notes                                                             |
| ----- | ---------------- | ----------------------------------------------------------------- |
| `alg` | `ES256` (see §5) | **Read for logging only.** Verification uses the pinned algorithm |
| `typ` | `at+jwt`         | RFC 9068. Distinguishes an access token from other JWTs           |
| `kid` | e.g. `2026-08-a` | Selects the key from the JWKS. Required                           |

### 4.2 Claims

| Claim   | Type   | Required | Example                    | Meaning                                        |
| ------- | ------ | -------- | -------------------------- | ---------------------------------------------- |
| `iss`   | string | ✅       | `https://shop.example.com` | The Magento instance that issued it            |
| `aud`   | string | ✅       | `shopsage-<store-id>`      | Which deployment it is for — store-specific    |
| `sub`   | string | ✅       | `ps_7f3a…` (opaque)        | **Pseudonym**, not a customer id — see below   |
| `exp`   | number | ✅       | unix seconds               | Expiry                                         |
| `iat`   | number | ✅       | unix seconds               | Issued at                                      |
| `jti`   | string | ✅       | uuid                       | Unique per token, for correlation              |
| `sid`   | string | ✅       | `demo-store`               | Store identifier, matching ShopSage's `siteId` |
| `scope` | string | ✅       | `chat orders cart`         | Space-separated, RFC 6749 style                |
| `nbf`   | number |          | unix seconds               | Honoured if present                            |

**`sub` is the recommendation most worth arguing about.** The obvious design puts the
Magento customer id in the token. This proposes an **opaque, stable-per-session
pseudonym** instead, because ShopSage does not need to know who the customer is:

- It needs a **stable key** for rate limiting and for owning a conversation. A pseudonym
  does that perfectly.
- When it eventually needs customer _data_ — `trackOrder` in Stage 9 — it will call the
  Magento connector and **forward this same token**. Magento resolves the pseudonym back
  to a customer, because Magento minted it. ShopSage never has to.

The result is that ShopSage stores no customer identifier next to conversation history.
That is a materially better position for open decision 5 (PII and retention), and it costs
nothing: Magento is doing the lookup either way.

The pseudonym should be **stable for the duration of a browsing session** so a refreshed
token continues the same conversation, and **not correlatable across sessions** unless
someone deliberately wants that. Question 3 below asks which.

## 5. Signing algorithm

**Recommended: `ES256` (ECDSA P-256 + SHA-256).** `RS256` is an acceptable fallback.

| Option  | Verdict                                                                                 |
| ------- | --------------------------------------------------------------------------------------- |
| `ES256` | **Recommended.** ~64-byte signature, small keys, fast verification                      |
| `RS256` | Acceptable. Widest library support; ~256-byte signature makes a noticeably bigger token |
| `HS256` | **Rejected.** Symmetric means ShopSage holds a key that can _mint_ tokens               |
| `none`  | Rejected, obviously, and treated as an attack when seen                                 |

`HS256` deserves the explicit rejection rather than a shrug. With a shared secret, a
ShopSage compromise becomes a Magento identity compromise: an attacker who reads
ShopSage's configuration can mint a token for any customer. With asymmetric signing there
is nothing in ShopSage worth stealing for that purpose.

Token size matters slightly more here than usual, because the header goes on every request
including long-lived SSE connections. `ES256` keeps a typical token around 350–450 bytes.

**The verifier pins the algorithm.** ShopSage will be configured with the expected
algorithm and will refuse anything else _before_ verifying. This is not defensive
decoration: reading `alg` from the token to decide how to verify it is the classic JWT
break — sign with `HS256` using the RSA public key as the HMAC secret, and a naive verifier
accepts it.

## 6. Lifetime and refresh

| Setting                  | Proposed     | Reasoning                                                                                         |
| ------------------------ | ------------ | ------------------------------------------------------------------------------------------------- |
| Token lifetime           | **15 min**   | Long enough for a real conversation, short enough that a leaked token expires before it is useful |
| Widget refresh threshold | 80% (12 min) | Refresh before expiry rather than after a failure                                                 |
| Clock skew tolerance     | **±60 s**    | Two servers, two clocks                                                                           |

**There is no refresh token.** The widget re-fetches from `GET /assistant/session`, which
is same-origin and authenticated by the ordinary Magento session cookie. A refresh token
would be a second credential to design, store and revoke, and the storefront already has a
session — the browser is _already_ holding the thing that proves who it is.

The skew tolerance is not fussiness. Without it, two servers a few seconds apart produce
intermittent 401s that appear random, correlate with nothing, and are extremely unpleasant
to diagnose.

**Revocation is by expiry, and that is a real tradeoff.** A token stays valid for up to 15
minutes after a customer logs out. The alternative — asking Magento to validate every token
— couples ShopSage's availability to Magento's and adds a round trip to every request.
Question 5 asks whether 15 minutes is acceptable for this store's risk appetite; the
mechanism supports any value.

## 7. Key rotation

Magento publishes a JWKS at a stable URL:

```
GET https://shop.example.com/assistant/.well-known/jwks.json
```

```json
{
  "keys": [
    {
      "kty": "EC",
      "crv": "P-256",
      "kid": "2026-08-a",
      "use": "sig",
      "alg": "ES256",
      "x": "…",
      "y": "…"
    },
    {
      "kty": "EC",
      "crv": "P-256",
      "kid": "2026-07-a",
      "use": "sig",
      "alg": "ES256",
      "x": "…",
      "y": "…"
    }
  ]
}
```

**Rotation procedure**, which requires no coordination between the two teams:

1. Magento generates a new key and **publishes it in the JWKS while still signing with the
   old one**.
2. Wait longer than ShopSage's JWKS cache TTL (10 min) plus a margin — 30 minutes is ample.
3. Magento starts signing with the new `kid`.
4. Keep the old key published for at least one token lifetime (15 min) so tokens already in
   circulation still verify.
5. Remove the old key.

Skipping step 1–2 and rotating in one move causes a brief window where every request 401s.
The overlap is the whole point of publishing a _set_.

**ShopSage's caching rules**, and two of them are load-bearing:

| Rule                                         | Why                                                                          |
| -------------------------------------------- | ---------------------------------------------------------------------------- |
| Cache the key set for ~10 minutes            | Verification must not become a per-request call to Magento                   |
| Unknown `kid` → refetch once, then fail      | Picks up a rotation without waiting for the TTL                              |
| **Refetch at most once per minute**          | Otherwise forged random `kid`s make ShopSage a DoS amplifier against Magento |
| **Serve a stale key set if a refetch fails** | A Magento blip must not invalidate keys that still work                      |

That third rule matters more than it looks. Without it, an attacker sends a stream of
tokens with random `kid` values and ShopSage dutifully hammers Magento's JWKS endpoint once
per request — turning ShopSage's authentication into an attack on the storefront.

## 8. Validation flow

Order is deliberate: cheap checks before expensive ones, and **nothing trusts a claim
before the signature is verified**.

| #   | Check                                     | Failure                                                 |
| --- | ----------------------------------------- | ------------------------------------------------------- |
| 1   | `Authorization: Bearer <token>` present   | `401 UNAUTHORIZED`                                      |
| 2   | Parses as a JWT, three segments           | `401`                                                   |
| 3   | Header `alg` is the **configured** one    | `401` + logged as an attack                             |
| 4   | `kid` present and resolvable (§7)         | `401`, or `503` if no key set at all                    |
| 5   | **Signature verifies**                    | `401` + logged as an attack                             |
| 6   | `exp` / `nbf` within skew                 | `401 TOKEN_EXPIRED` — distinct, so the widget refreshes |
| 7   | `iss` equals the configured issuer        | `401` + logged as suspicious                            |
| 8   | `aud` contains this deployment's audience | `401` + logged as suspicious                            |
| 9   | `sid` equals this deployment's `siteId`   | `401` + logged as **tenancy violation**                 |
| 10  | Parse `scope` into capabilities           | —                                                       |

Steps 3 and 5 are the security core. Steps 7–9 catch a valid token being replayed against
the wrong deployment — most often a staging token against production, occasionally
something worse — and are worth logging distinctly from an ordinary expiry, because their
base rate should be zero.

**`jti` is not checked for replay.** A bearer token is used many times legitimately, once
per message; treating `jti` as a nonce would break the first follow-up question. It exists
for correlation in logs, so a support conversation can be traced across both systems.

## 9. Failure scenarios

| Situation                                  | Status | Code                  | Widget should…                                         |
| ------------------------------------------ | ------ | --------------------- | ------------------------------------------------------ |
| No token                                   | 401    | `UNAUTHORIZED`        | Fetch a token, retry once                              |
| Malformed token                            | 401    | `UNAUTHORIZED`        | Fetch a fresh token, retry once                        |
| Expired                                    | 401    | `TOKEN_EXPIRED`       | **Refresh and retry** — expected, not an error to show |
| Not yet valid (`nbf`)                      | 401    | `UNAUTHORIZED`        | Surface the fallback message; likely clock skew        |
| Bad signature                              | 401    | `UNAUTHORIZED`        | Do not retry                                           |
| `alg` mismatch or `none`                   | 401    | `UNAUTHORIZED`        | Do not retry. **Alert-worthy server-side**             |
| Wrong `iss` / `aud` / `sid`                | 401    | `UNAUTHORIZED`        | Do not retry. **Alert-worthy server-side**             |
| Unknown `kid`, still unknown after refetch | 401    | `UNAUTHORIZED`        | Retry once after a delay                               |
| JWKS unreachable, **cached keys usable**   | —      | —                     | Nothing — requests succeed normally                    |
| JWKS unreachable, **no keys at all**       | 503    | `SERVICE_UNAVAILABLE` | Retry with backoff                                     |
| Valid token, insufficient scope            | 200    | —                     | Nothing — see below                                    |

Two rows are the ones most often got wrong elsewhere.

**No keys at all is a 503, not a 401.** The caller's token may be perfectly good; ShopSage
simply cannot check it. Reporting that as "your credentials are bad" sends an operator
looking in exactly the wrong place, and tells a load balancer the instance is healthy when
it is not.

**Insufficient scope is not an error at all.** A guest asking "where is my order?" should
not get a 401 — the request was legitimate and correctly authenticated. Instead the
`trackOrder` tool is simply **absent from the registry for that session**, and the model
says it cannot look that up, which is already how a disabled feature behaves today
([ADR 0022](../adr/0022-bounded-tool-loop.md)). Scope becomes another input to the same
capability gate the site profile's feature flags already feed.

## 10. Scopes

| Scope    | Grants                      | Issued to                        |
| -------- | --------------------------- | -------------------------------- |
| `chat`   | Knowledge-base Q&A          | Everyone, including guests       |
| `cart`   | `addToCart`, `applyCoupon`  | Sessions with a cart             |
| `orders` | `trackOrder`, order history | **Authenticated customers only** |

**Guests get a token too**, carrying only `chat`. That is deliberate and it buys three
things:

1. Rate limiting keys on `sub` instead of an IP address — a real improvement over Stage 7c,
   where a shared corporate NAT looks like one abusive client and an attacker rotating
   addresses looks like many innocent ones.
2. Anonymous abuse now requires obtaining tokens from Magento, which Magento can throttle
   against its own session.
3. Every request has a store identity, which is what multi-store tenancy will need.

The cost is that ShopSage cannot serve anyone if Magento cannot mint tokens. Question 4.

## 11. What each side implements

**Magento module:**

- [ ] `GET /assistant/session` — mints a token for the current storefront session, guest or
      customer, returning `{ token, expiresAt }`
- [ ] `GET /assistant/.well-known/jwks.json` — public keys, cacheable, no authentication
- [ ] Key generation, storage and the rotation procedure in §7
- [ ] Rate limiting on the session endpoint, since it is now the front door
- [ ] Accepting the same token on `/assistant/*` connector calls and resolving `sub` back to
      a customer (Stage 9)

**ShopSage:**

- [ ] Verification middleware implementing §8
- [ ] JWKS client with the caching and refetch rules in §7
- [ ] `AUTH_*` configuration: issuer, audience, JWKS URL, algorithm, skew
- [ ] Rate limiting re-keyed from IP to `sub` — a one-function change, by design
      ([ADR 0025](../adr/0025-rate-limiting-and-capacity.md))
- [ ] Scope-gated tool registry
- [ ] A readiness probe that fails only when **no** usable key set is held

**Both:** a shared set of test vectors — a valid token, an expired one, one signed by the
wrong key, one with `alg: none`, one for another `sid` — so each side can prove it rejects
what it should without the other running.

## 12. Development

Verification will be behind `AUTH_ENABLED`, which must be **explicitly false** to disable —
and which follows the `CONVERSATION_STORE` precedent
([ADR 0024](../adr/0024-durable-conversation-store.md)): no default in production, so a
deployment cannot ship unauthenticated by forgetting rather than by deciding. With it off,
requests get a synthetic guest session so the tool-gating path is still exercised locally.

## 13. Deliberately not proposed

| Not doing                    | Why                                                                                |
| ---------------------------- | ---------------------------------------------------------------------------------- |
| Token introspection endpoint | Couples ShopSage's availability to Magento's and adds a round trip per request     |
| Refresh tokens               | A second credential to design and revoke; the Magento session already exists       |
| Encrypted tokens (JWE)       | Nothing in the payload is confidential — that is the point of a pseudonymous `sub` |
| ShopSage minting its own     | It would then be an identity provider, which is Magento's job                      |
| mTLS between the services    | Worth considering for the _connector_ calls; irrelevant for a browser              |
| Cookie-based sessions        | The API is deliberately cookie-free and therefore CSRF-immune                      |

## 14. Shared test vectors

Approved, and expanded to the eight cases below. These are the artifact that lets each side
prove compliance **without the other running**, which matters because the two are built by
different people at different times.

Canonical location: `packages/session-token/test/vectors/` in this repository —
`vectors.json` plus the key pair that signed them, and `generate-vectors.mjs` to reproduce
them. The Magento module should verify it can mint tokens that ShopSage's suite accepts, and
that ShopSage rejects each failure case.

| #   | Case              | Token differs by                  | Expected                              |
| --- | ----------------- | --------------------------------- | ------------------------------------- |
| 1   | Valid             | —                                 | Accepted; claims exposed as a session |
| 2   | Expired           | `exp` in the past                 | Rejected — `TOKEN_EXPIRED`            |
| 3   | Wrong signing key | Signed by a different private key | Rejected — signature                  |
| 4   | `alg: none`       | Header `alg`, empty signature     | Rejected **before** verification      |
| 5   | Wrong audience    | `aud` naming another deployment   | Rejected — audience                   |
| 6   | Wrong `sid`       | Another store's identifier        | Rejected — **tenancy violation**      |
| 7   | Invalid scope     | `scope` empty or unrecognised     | Accepted, **capability withheld**     |
| 8   | Unknown `kid`     | A `kid` absent from the JWKS      | Rejected after one bounded refetch    |

Two notes on making these deterministic:

- **Every vector carries the `now` it should be evaluated at.** Otherwise a "valid" token
  expires and the suite starts failing on a date nobody chose. ShopSage's verifier takes an
  injectable clock for exactly this reason.
- **Case 7 is not a rejection.** A token with no usable scope is a perfectly valid token,
  and the request succeeds — the capability is simply absent, and the assistant says it
  cannot do that. A verifier that 401s here has implemented the contract wrongly, which is
  precisely why the case is in the set.

## Open questions — all resolved

Recorded for the record; the answers are in [Decisions](#decisions-as-accepted).

| #   | Question                                              | Answer                                |
| --- | ----------------------------------------------------- | ------------------------------------- |
| 1   | Is `ES256` acceptable to the Magento module?          | Yes; RS256 kept possible, HS256 never |
| 2   | Who owns key generation and storage?                  | Magento, solely                       |
| 3   | Is `sub` stable across sessions or per session?       | Per Magento session                   |
| 4   | Is requiring a token for guests acceptable?           | Yes, dependency accepted              |
| 5   | Is a 15-minute revocation window acceptable?          | Yes                                   |
| 6   | Issuer and audience naming for multi-store?           | `shopsage-<store-id>`                 |
| 7   | Does anything need customer identity inside ShopSage? | No — forward the token instead        |

Nothing further is open. A change to any of the above is a change to this contract.
