# ADR 0013: Required configuration is enforced per entry point, not in the shared schema

Status: Accepted
Date: 2026-07-30
Stage: 2

## Context

The Stage 2 plan said: flip `LLM_API_KEY`, `LLM_BASE_URL` and `LLM_MODEL` from optional to required.
The intent is right — an assistant with no model cannot do its only job, and failing at boot with a
precise message is far better than a 502 on a customer's first question.

The obvious implementation is to make them required in `envSchema`. That schema is shared by every
process in the monorepo, and the roadmap has two more entry points that never call a model: the
ingestion CLI (Stage 5) and the scraper (Stage 4). Under a shared-required rule, running a content
scrape would demand gateway credentials it will not use — which in practice means either handing a
batch job a production credential it has no business holding, or inventing a dummy value, which
defeats the validation entirely.

There is also a plainer problem: `parseEnv({})` becoming a failure makes the schema's own defaults
untestable, and every test that does not care about the LLM has to carry fake credentials.

## Decision

The shared environment schema keeps `LLM_*` **optional**. Required-ness is enforced by the entry
point that needs it.

For the backend that is `composition/llm-options.js`, which maps the environment onto
`@shopsage/llm-client` options and refuses to produce them if any of the three is absent. The
composition root constructs the client eagerly, so **the backend cannot start without a configured
gateway** — the operator-visible behaviour the plan asked for.

Two details make the error usable:

- It reports **every** missing variable at once. One variable per boot attempt is a miserable way to
  configure a service.
- It names the **environment variable**, not the client's option name, so the message matches what
  the operator actually edits. `apiKey` is not a thing anyone can set.

The client validates its own options too, with zod, which is defence in depth for a programmatic
caller rather than the primary check.

## Alternatives

**Require `LLM_*` in `envSchema`.** One rule, one place, and impossible to forget in a new entry
point. Rejected because it couples processes that share a schema but not a dependency, and pushes
operators toward dummy credentials. It also changes a shared contract to express a fact about one
consumer.

**A per-process schema, or a schema composed from fragments.** Precise, and arguably the "correct"
long-term shape. Rejected as premature: there is one entry point today. When the ingestion CLI and
scraper exist, composable schema fragments become worth building, and this decision can be revisited
with three real consumers instead of one and two hypotheticals.

**Let the backend start and fail `/v1/chat` with a 503.** Better operability in one respect — the
instance stays inspectable, `/health/info` still answers, and an operator can see what profile
loaded. Rejected because it hides a misconfiguration behind a running-looking service. A deployment
that appears healthy and answers every customer question with an error is worse than one that visibly
failed to start, and the project's stated position is that a misconfigured assistant is worse than an
absent one.

## Consequences

Easy: unrelated entry points stay independent of the gateway. The backend still fails fast, with a
message naming exactly what to set. Tests that do not exercise the LLM need no fake credentials, and
`parseEnv({})` remains meaningful.

Hard: the rule is enforced in a place a reader might not look. The mitigation is a comment in
`env-schema.js` pointing here, and a test asserting the backend refuses to build its client without
the three variables.

Under Compose, a missing credential now means the backend container exits at boot and — with
`restart: unless-stopped` — restarts in a loop. That is the correct twelve-factor behaviour for
missing required configuration, and the reason the failure writes one JSON line naming the variables
before exiting.

Accepted: when a second entry point needs its own required set, this will want revisiting as
composable schema fragments rather than a second bespoke check.
