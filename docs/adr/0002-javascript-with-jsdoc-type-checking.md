# ADR 0002: JavaScript with JSDoc, type-checked by TypeScript

Status: Accepted
Date: 2026-07-30
Stage: 1

## Context

The project mandates JavaScript with ES modules and JSDoc. It also mandates enterprise-grade quality
and long-term maintainability across roughly ten packages with typed ports between them.

Those two requirements pull in opposite directions. The architecture leans heavily on interfaces —
`VectorRepository`, `LlmClient`, `ContentSource`, `ConversationStore` — whose whole purpose is to be
implemented more than once. An interface that exists only as prose in a comment is not an interface; a
second implementation drifts from it and nothing notices until runtime.

## Decision

Keep JavaScript as the shipped language. Add TypeScript as a **type checker only**.

- Every source and test file is `.js` with ES modules. Node runs it unmodified.
- Public functions, options objects and ports are annotated with JSDoc.
- `tsconfig.json` sets `allowJs`, `checkJs`, `strict` and `noEmit`. `npm run typecheck` runs
  `tsc --noEmit`.
- There is **no build step** for backend packages. Nothing is compiled, bundled or transformed.

Types are therefore enforced, not decorative, while the deployment artefact stays plain JavaScript.

## Alternatives

**JSDoc as documentation only, unchecked.** What the mandate literally asks for, and the cheapest.
Rejected because unchecked annotations rot: they drift from the code silently and then actively mislead,
which is worse than having none. Checking them costs one dev dependency and one script.

**Full TypeScript.** Better ergonomics — real interfaces, declaration merging, no `import('...')`
gymnastics. Rejected because it contradicts an explicit project requirement, and because it introduces
a build step: source maps, a compiled `dist/`, a watch process, and the permanent question of whether
you are debugging source or output.

**Type stripping via `--experimental-strip-types`.** Would give TypeScript syntax with no build step.
Rejected as too new to stake a platform on, and it still means `.ts` files.

## Consequences

Easy: `node src/server.js` runs the actual shipped code; stack traces point at real lines; no build
directory; contributors need no toolchain knowledge beyond Node. Type errors still fail CI.

Hard: JSDoc is verbose next to TypeScript, especially for generics and cross-package types, which
require `import('@shopsage/platform').Logger`. Some patterns need explicit casts —
`/** @type {Foo} */ (value)` — which are noisier and easier to abuse than a TypeScript assertion. And
one seam genuinely does not work in JSDoc: augmenting Express's `Request` with `requestId` and `log`
needs a `.d.ts` file, so `packages/rag-backend/src/types.d.ts` exists as a deliberate exception.

Accepted: the discipline only holds if `npm run typecheck` is part of the gate. Uncheckable types are
worse than no types, so a `@ts-ignore` should be treated as a design smell in review.
