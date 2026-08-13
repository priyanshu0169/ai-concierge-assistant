# ADR 0008: Docker-first environment; the application owns dependency readiness

Status: Accepted
Date: 2026-07-30
Stage: 1

## Context

ShopSage needs three services locally: the backend, Qdrant, and a self-hosted embeddings server. The
embeddings model (`BAAI/bge-m3`) is roughly 2.2 GB and takes minutes to download on first run. Neither
the Qdrant nor the TEI image ships a shell, `curl` or `wget`.

Two questions follow. How does the stack run reproducibly? And who decides whether a dependency is
ready — Compose, or the application?

## Decision

**Docker Compose is the supported way to run ShopSage**, with three services named
`shopsage-backend`, `shopsage-qdrant` and `shopsage-embeddings`. Service names double as DNS names on
the Compose network.

**The application owns dependency readiness.** There are deliberately no Compose healthchecks on
Qdrant or the embeddings service. Instead:

- `depends_on` controls **start order only**. It never blocks startup on dependency health.
- The backend binds its port immediately and probes both dependencies itself, reporting each on
  `GET /health/ready` with a 503 while any is down.
- The backend does have a `HEALTHCHECK`, implemented with `node -e` and `fetch` so no extra tooling
  enters the image.

Supporting decisions:

- Two runnable image targets. `production` carries runtime dependencies only, no test code, and runs as
  the unprivileged `node` user. `development` adds dev dependencies and `node --watch`.
- `docker-compose.override.yml` selects development automatically, bind-mounting only `./packages` and
  `./config` — mounting the repository root would shadow `/app/node_modules` and break the workspace
  symlinks. A production-shaped run is `docker compose -f docker-compose.yml up`.
- `init: true` on the backend, so PID 1 forwards signals and SIGTERM actually reaches Node.
- Qdrant and the embeddings service publish to `127.0.0.1` only. They are a datastore and an inference
  endpoint with no authentication by default; publishing them on the LAN would expose the corpus.
- Dependency manifests are copied before source in the Dockerfile, so editing code does not invalidate
  the install layer. `npm ci --ignore-scripts` removes an arbitrary-code-execution path from the build.
- The embeddings model is configurable so a developer can substitute a smaller one.

## Alternatives

**Compose healthchecks with `depends_on: condition: service_healthy`.** The idiomatic answer, and it
makes `docker compose up` wait until everything is genuinely ready. Rejected for two reasons. First,
these images have no shell or HTTP client, so the healthcheck command would depend on image internals
(`/dev/tcp` tricks or an added package) and would break on an image update. Second, it encourages the
wrong runtime behaviour: a service that cannot start until its dependencies are healthy cannot start
during a partial outage, and in production nothing guarantees dependencies come up first. Reporting
readiness honestly is more robust than refusing to start.

**A wait-for-it style entrypoint script.** Common and simple. Rejected for the same reason: it turns a
slow dependency into a failed deployment. Also hides a 2.2 GB download behind a container that appears
hung.

**Install the model into the image at build time.** Fast, deterministic startup with no first-run wait.
Rejected: it makes the image multiple gigabytes, couples the image to a model choice that is meant to be
configurable, and moves the download into every CI build.

**Run dependencies natively, no Compose.** Fewer layers for a developer already running Qdrant.
Rejected as unreproducible — the stated requirement is that everything runs in Docker.

## Consequences

Easy: one command starts the stack. Readiness is honest and per-dependency, so an operator sees _which_
dependency is down without reading logs. The same readiness logic serves local Compose and any
production orchestrator. Model weights are cached in a volume, so only the first start is slow.

Hard: `docker compose up` returns before the stack is usable, and `/health/ready` returns 503 for
several minutes on first run. That looks like a failure to anyone who has not read the documentation, so
it is called out in the README, `Docker.md` and `Testing.md`. Compose also cannot express "wait until
ready" for callers that want it.

Accepted: BGE-M3 on CPU needs roughly 4 GB and is slow — single-digit embeddings per second on a laptop.
On a memory-constrained machine the container is OOM-killed and appears to restart repeatedly. Mitigated
by documenting `BAAI/bge-small-en-v1.5` (384 dimensions) as a development substitute, with the warning
that changing the model invalidates any existing collection.

Images are pinned by tag, not digest. Digest pinning is stricter and is tracked in the roadmap.
