# ADR 0001: Monorepo with npm workspaces

Status: Accepted
Date: 2026-07-30
Stage: 1

## Context

ShopSage is one platform made of many collaborating parts: a backend, a domain core, four outbound
clients, a scraper, an ingestion pipeline, and a browser widget. They share an error taxonomy, a
logging contract and configuration types, and during early development they will change together
constantly — a change to the retrieval port touches the core, the repository and the backend in one
commit.

We also need boundaries to be real. The whole architecture rests on `assistant-core` not importing
Express and `llm-client` being the only package that knows about a model provider. If everything lives
in one flat `src/`, those rules are review conventions and they erode.

## Decision

A single repository with npm workspaces and one package per bounded responsibility under `packages/*`,
scoped as `@shopsage/*`.

No Lerna, Nx or Turborepo. npm workspaces provides what we need — hoisted installs, symlinked local
dependencies, `--workspaces` script fan-out — with no extra tool, no extra config file and no extra
concept for a new contributor to learn.

The Magento connector stays in a **separate repository**, because it is a PHP Magento module with a
different toolchain, release cycle and audience.

## Alternatives

**One package, folders for structure.** Simplest to start, and the boundaries are unenforceable.
Nothing stops a handler importing a Qdrant client directly, and by the time that matters the imports
are everywhere. A package boundary makes the dependency direction visible in `package.json`, where a
reviewer sees it.

**Separate repository per package.** Real isolation, at the cost of coordinating a version bump and a
release across four repositories for a single logical change. That price is worth paying when packages
have independent consumers and release cadences; ours do not.

**Nx or Turborepo.** Task graphs, affected-project detection and remote caching are genuinely valuable
— at a scale we are nowhere near. Two packages and a five-second test suite do not need a build
orchestrator. Revisit when the suite is slow enough that someone complains.

**pnpm workspaces.** Faster, stricter about phantom dependencies, and a better fit long term. Rejected
for now only because npm ships with Node and adds no prerequisite to onboarding. The `packages/*`
layout means switching later is a lockfile change, not a restructure.

## Consequences

Easy: atomic cross-package changes; one install; one lint, typecheck and test invocation; boundaries
visible in manifests.

Hard: no independent versioning — every package moves together, which is right while there is one
consumer and wrong if a package ever gains external users. Hoisting can also mask a missing
dependency declaration, since an undeclared package may still resolve from the root.

Accepted: workspace packages are `private: true` and unpublished. If one is ever published, it needs
its own version policy and a real `files` allow-list.
