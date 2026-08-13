# ADR 0018: The embeddings backend is a configuration choice

Status: Accepted
Date: 2026-07-31
Stage: 3 (revised), 4

Supersedes the "local and free by mandate" position recorded in Stage 1's
`docs/RAG.md` and in the original project brief.

## Context

Stage 3 built the embeddings client against self-hosted HuggingFace TEI, under an
explicit project rule: _embeddings are generated locally, never call a paid embedding
API_. That rule made sense when the only alternative was a metered third-party account.

Two things then changed.

The company's AI gateway — already the LLM's endpoint, already credentialed, already
inside the trust boundary — turns out to expose `text-embedding-3-small` on an
OpenAI-compatible `/embeddings` route. Using it is not "calling a paid API" in the sense
the rule was written to prevent; it is the same commercial arrangement the chat
completions already run under.

And self-hosting proved costly in practice, not in theory. `bge-m3` could not complete
warm-up on 8 GB of Docker memory: TEI reached `Warming up model` and exited **0**,
eighteen times, with `OOMKilled` unset — a failure with no OOM evidence and no obvious
cause. Every developer on a laptop pays that, plus a 2.2 GB download, before they can
run anything.

The requirement that does not change: a future deployment must be able to move back to
self-hosted inference — for data residency, for an air-gapped install, for a
multilingual open model, or purely on cost — **without touching application code**.

## Decision

**`EmbeddingsClient` gains no new surface. The backend moves behind an internal
provider seam**, selected by `EMBEDDING_PROVIDER`.

| Provider             | Speaks                                                  | For                                                   |
| -------------------- | ------------------------------------------------------- | ----------------------------------------------------- |
| `openai` _(default)_ | OpenAI embeddings wire format, `POST {base}/embeddings` | An internal AI gateway, LiteLLM, Azure OpenAI, OpenAI |
| `tei`                | HuggingFace TEI, `POST {base}/embed`                    | Self-hosted inference                                 |

A provider supplies exactly four things: the request shape, how to read vectors out of
the response, what a status code means, and how to prove the service is usable.
Everything else — batching, ordering, input validation, the dimension guard, retries,
correlation logging — stays above the seam and is shared, so a new backend inherits it
rather than reimplementing it slightly differently.

Consequences of that split worth stating:

- **The dimension check is shared, not per provider.** It is the rule that protects the
  corpus from mixed vector spaces, and it must not be able to differ by backend.
- **Results are re-ordered by the provider's `index` field.** The wire format does not
  promise response order, and `index` exists precisely so a caller need not trust it. A
  silently reordered batch attaches every vector to the wrong chunk — a corruption that
  produces no error and degrades every future answer.
- **Health means usable, for both.** The hosted provider verifies the model appears in
  the gateway's model list; the self-hosted one verifies the served model matches the
  configured one. A gateway without model discovery is reachable-but-unverified rather
  than unhealthy — refusing to start over an optional endpoint would be a false alarm.
- **Error bodies are scrubbed of the credential**, which the self-hosted path never
  needed. `sanitizeUpstreamText` moved into `platform` at its second caller.

Configuration is environment-driven and names no provider in code:

```ini
EMBEDDING_PROVIDER=openai
EMBEDDING_BASE_URL=<usually the same as LLM_BASE_URL>
EMBEDDING_API_KEY=<usually the same as LLM_API_KEY>
EMBEDDING_MODEL=text-embedding-3-small
EMBEDDING_DIMENSIONS=1536
```

The TEI container stays in `docker-compose.yml` behind a `selfhosted` profile — a
first-class option that is not started by default, because a 2.2 GB download nobody
asked for is a poor first run.

## Alternatives

**Keep TEI as the only backend.** Honours the original rule, no seam, no credential in
the embeddings path. Rejected because the rule was written against a risk that does not
apply here — the gateway is the same arrangement the LLM already uses — and because the
operational cost is real and falls on every developer.

**Switch to the gateway and drop TEI entirely.** Simplest possible code: one wire
format, no seam, no registry. Genuinely tempting, and it is what the immediate
requirement asks for. Rejected because it forecloses the case the seam exists for.
Air-gapped and data-residency deployments are foreseeable for a platform meant to serve
many stores, and re-introducing a second backend _after_ the client has been written
against one is exactly the retrofit this project keeps avoiding. The seam costs four
small functions.

**A generic "OpenAI-compatible or not" flag rather than named providers.** Fewer
concepts. Rejected because the two differ in more than a URL: request body, response
envelope, status semantics and health probe are all different. A boolean would branch in
four places instead of naming the thing once.

**Adapt TEI's output to the OpenAI envelope and keep one code path.** Attractive
symmetry. Rejected because it inverts the abstraction — the client would be pretending a
self-hosted server is a gateway, and the pretence leaks the moment a TEI-specific status
code (413, 422, 424) needs a distinct remediation.

**Send OpenAI's `dimensions` parameter to shorten vectors.** Supported by the v3 models,
and smaller vectors are cheaper to store and search. Deliberately not sent: it is another
way for `EMBEDDING_DIMENSIONS` and reality to disagree, and the guard that catches that
disagreement is the one thing standing between a model change and a silently corrupted
corpus. Worth revisiting with a measured storage cost behind it.

## Consequences

Easy: the default path needs no extra service, no model download and no memory budget —
`docker compose up` is now Qdrant and the backend. Embedding quality improved measurably
on the smoke corpus: the correct chunk beat the runner-up by 0.13 with
`text-embedding-3-small`, against 0.02 with `bge-small-en-v1.5`. Moving to self-hosted
inference is `EMBEDDING_PROVIDER=tei`, a base URL, and a re-ingestion.

Hard: embedding is now **metered and billable**, and ingestion is the expensive
operation — a full re-ingestion of a large corpus has a price that self-hosting did not.
Content also leaves the network to be embedded, which is a data-handling question a
store may need to answer even when the gateway is internal. And the hosted path reports
no input-token limit, so Stage 5's chunker cannot size itself from `health()` the way it
could against TEI; it will need a configured budget.

The original "never call a paid embedding API" rule is now **withdrawn**, not quietly
ignored. It is replaced by: the embeddings backend is a deployment decision, and the
architecture must never assume which one is in use.

Accepted: two providers means two wire formats to keep working, and only the configured
one is exercised on any given day. Both are covered by the test suite against fakes, but
the unused path will rot unless someone runs it — the same hazard as any
second implementation, and the reason `tei` keeps a compose profile rather than only a
paragraph of documentation.
