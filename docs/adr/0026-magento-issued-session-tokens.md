# ADR 0026: Magento-issued session tokens, verified against a cached key set

Status: Accepted
Date: 2026-08-03
Stage: 7d

## Context

`POST /v1/chat` has been an unauthenticated, LLM-backed endpoint since Stage 6. Rate limiting
in Stage 7c bounded the cost of abusing it but could not answer the question authentication
exists for: **who is asking**. Without that, the Stage 9 commerce tools cannot be built at
all — `trackOrder` with a client-asserted identity is an order-history disclosure endpoint
for the whole store.

This was the one item in the original Stage 7 that was genuinely blocked, because it is a
contract between two codebases in two repositories. The contract was written, reviewed and
accepted before any code:
[Proposal 0001](../proposals/0001-assistant-session-token.md), whose seven questions were
all answered. **This ADR records the decision; the proposal is the specification.**

## Decision

Everything in the proposal, as accepted. The points worth restating here are the ones that
shaped code rather than the wire format.

**A new package, `@shopsage/session-token`, which issues nothing.** It holds public keys
only. Magento is the sole issuer and the sole holder of a private key (decision 4), so a
compromise of ShopSage yields nothing that could mint a token for a customer. That asymmetry
is why `HS256` is not merely discouraged but **absent from the implementation**: a symmetric
key would make this service an identity provider by accident.

**The algorithm is pinned by configuration and the token's `alg` is only compared against
it.** This is the single most important line in the package. Choosing a verification method
from a value the attacker supplies is the classic JWT break — sign with `HS256` using the
RSA public key as the HMAC secret, and a naive verifier agrees. `verify-signature.js`
therefore exposes an allow-list of _implementations_, never a lookup from the header.

**No JWT dependency.** Node's `crypto` verifies both supported algorithms natively:
`createPublicKey({ format: 'jwk' })` imports a JWKS entry, and `dsaEncoding: 'ieee-p1363'`
is exactly the raw R‖S signature encoding JWS specifies. Roughly 200 lines, and the
security-critical part is a decision worth owning in readable code.

**`decode.js` deliberately cannot inspect a claim.** It splits, parses, and returns — no
claim access, so it cannot be misused to peek at an unverified token. The signed input is
reconstructed from the original text rather than re-encoded from the parsed objects, because
re-encoding canonicalises key order and whitespace and the signature covers the bytes that
were actually sent.

**Two caching rules in the key store are security controls, not optimisations.** A refetch
triggered by an unknown `kid` is limited to one a minute — otherwise a stream of tokens with
random `kid`s makes ShopSage fetch the JWKS once per request, turning its own authentication
into a denial-of-service amplifier pointed at the storefront it depends on. And a failed
refresh **serves the stale set**, because keys that still verify must not be discarded over a
network blip.

**Holding no keys is a 503, never a 401.** The caller's token may be perfectly valid; we
simply cannot check it. Reporting that as "your credentials are bad" sends an operator
looking in exactly the wrong place, and tells a load balancer the instance is fine.

**The precise reason is logged and then discarded.** A 401 is an exposed error, so the
envelope publishes its `details` — right for a validation failure, wrong here, because
knowing the _audience_ was wrong rather than the signature is what an attacker needs next.
The **code** survives, because `TOKEN_EXPIRED` versus `UNAUTHORIZED` is the one distinction a
client legitimately acts on.

**Rejections are graded by severity.** An expiry happens to every customer every fifteen
minutes by design; a swapped algorithm has a base rate of zero in honest traffic. Logging
both at one level means either drowning in expiries or missing an attack, so `expired` is
`info`, an audience mismatch is `warn`, and `alg: none`, a bad signature or another store's
`sid` are `error`.

**Authentication runs before rate limiting**, which re-keys the limiter from an IP address to
the pseudonymous subject. That was designed for in Stage 7c
([ADR 0025](0025-rate-limiting-and-capacity.md)) and cost one line: a shared corporate NAT
stops looking like one abusive client, and an attacker rotating addresses stops looking like
many innocent ones.

**Insufficient scope withholds a capability rather than refusing a request.** The tool is
absent from the registry, so the model says it cannot look that up — already how a disabled
feature behaves ([ADR 0022](0022-bounded-tool-loop.md)). Offering the tool and refusing the
call would have the model promise something it cannot deliver.

**`req.session` is non-optional, and disabling authentication supplies a synthetic _guest_
session** rather than none. A handler that could receive `undefined` grows a fallback, and a
fallback in an authorisation path is how a gate stops gating. The guest holds `chat` and
nothing else, so a developer sees the same tool set a guest sees rather than a superset that
hides a gating bug until production.

**`AUTH_ENABLED` has no default in production**, following `CONVERSATION_STORE`
([ADR 0024](0024-durable-conversation-store.md)) and `LLM_*`
([ADR 0013](0013-required-config-per-entry-point.md)).

**The tool registry is now built per turn, not per process.** The tool set depends on the
session as well as the store, and a guest and a signed-in customer meet the same deployment.
Construction is a filter over a frozen table, so the cost is nil.

## Alternatives

**`jose`.** Modern, audited, and would have been perhaps twenty lines including JWKS
caching. Rejected, and it was the closest call in this stage: the deciding factor is that the
contract specifies caching semantics — bounded refetch, serve stale — that would have meant
fighting or auditing the library's own policy, and that algorithm pinning is the one thing
worth being able to read in full. The reasoning flips immediately if this ever needs JWE,
nested tokens, or more than two algorithms.

**Opaque tokens with an introspection endpoint.** Revocable at any moment, which a JWT is
not. Rejected: it puts a Magento round trip on every request, so a storefront blip becomes an
assistant outage, and a 15-minute revocation window was explicitly accepted (decision 6).

**The customer id in `sub`.** The obvious design. Rejected in favour of a pseudonym
(decision 2), so ShopSage stores no customer identifier next to conversation history. It
costs nothing — Magento resolves identity either way — and it materially improves the answer
to open decision 5.

**Requiring a token only for commerce scopes, leaving chat anonymous.** Would keep the
assistant working if the session endpoint were down. Rejected (decision 5): a token for every
session is what lets rate limiting key on a subject at all, and anonymous abuse then has to
get past Magento first.

**Symmetric signing with a shared secret.** Simplest key distribution. Rejected permanently,
above.

**Checking `jti` for replay.** Rejected: a bearer token is used many times legitimately, once
per message, so treating `jti` as a nonce would break the first follow-up question. It is for
correlation across the two systems.

## Consequences

Verified end to end against a stand-in issuer that mints real ES256 tokens and publishes a
real JWKS. Every contract case behaves as agreed:

| Case                  | Result                                                                 |
| --------------------- | ---------------------------------------------------------------------- |
| Valid token           | `200`, grounded answer with citations                                  |
| No token / garbage    | `401 UNAUTHORIZED`, never reaches the domain                           |
| Expired               | `401` **`TOKEN_EXPIRED`** — distinct, as agreed                        |
| Another store's `sid` | `401`, logged `error` as a tenancy violation                           |
| Wrong audience        | `401`, logged `warn`                                                   |
| `alg: none`           | `401`, logged `error`                                                  |
| Guest (`chat` only)   | `200`, full knowledge-base answer                                      |
| **No usable scope**   | **`200`**, `toolRounds: 0` — the assistant says it cannot look that up |

The last row is the contract's most distinctive decision working in practice, and it is not
what a reader expects a scope failure to look like.

The JWKS was fetched **twice across ten requests**, so verification is genuinely local.
Subjects appear in logs as `ps_…` pseudonyms and no email address appears anywhere.

**One real leak, found by a test written for it.** The precise rejection reason was reaching
the client, because a 401 is an exposed error and the envelope publishes `details`. Caught by
asserting the guarantee under `NODE_ENV=production` — the same shape of test Stage 2 used for
gateway masking — and fixed by having the middleware strip the reason after logging it.

The assistant now depends on Magento being able to issue tokens: if the session endpoint is
down, nobody can chat. That was accepted knowingly (decision 5), and it is bounded — an
issuer outage does not stop verification while a cached key set is held, and readiness
reports `session-keys` separately so the two failure modes stay distinguishable.

Still not done, and the reason Stage 9 exists: **nothing forwards the token to Magento yet.**
The pseudonym design only pays off when a commerce tool needs identity, which needs
`magento-client`. Until then, `sub` is used purely as a stable key for rate limiting and
conversation ownership.
