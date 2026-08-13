# ADR 0015: Callers keep their own point ids; the adapter derives the store's

Status: Accepted
Date: 2026-07-30
Stage: 3

## Context

Qdrant accepts only two kinds of point id: an unsigned integer, or a UUID.

The natural key for a chunk of content is a **content hash**. It is what makes
re-ingestion idempotent — hash the chunk, and an unchanged chunk maps to the same
point, so a repeated run overwrites instead of accumulating duplicates. That
matters because embedding is the expensive step and the corpus is mostly unchanged
between runs.

A content hash is neither an integer nor a UUID. So something has to bridge the
two, and where that bridge lives decides whether [ADR 0006](0006-vector-repository-port.md)
holds. If callers must supply UUIDs, then a Qdrant constraint has reached the
domain: `ingestion` would have to know why its ids look the way they do, and a
different vector store with different id rules would change ingestion code.

## Decision

**Callers use any non-empty string as an id. The adapter derives the store's id
and hides the derivation completely.**

- `toStoreId(id)` produces a **deterministic** RFC 4122 version 5 UUID from the
  caller's string, under a fixed namespace. The same input always yields the same
  UUID, which is what preserves idempotent re-ingestion.
- An id that is already a UUID is passed through unchanged, so nothing is derived
  twice.
- The caller's original id is stored in the payload under the reserved key
  `_pointId`, and `search()` returns _that_ — so a caller sees the id it supplied,
  never a UUID it did not choose. The reserved key is stripped from the payload on
  read, and `insert()` rejects a payload that sets it.

The namespace UUID is a constant in the source and must never change: changing it
re-derives every id, which would turn the next ingestion run into a full
duplication of the corpus.

## Alternatives

**Require callers to supply UUIDs.** No derivation, no reserved key, less code.
Rejected because it is precisely the leak the port exists to prevent — and it does
not remove the problem, it relocates it into `ingestion`, where "hash the content,
then convert it to a UUID because of the store we happen to use" would live
permanently.

**Hash to an unsigned 64-bit integer instead.** Qdrant accepts integers, and they
are more compact. Rejected because 64 bits of a hash carries a real collision
probability at corpus scale, and a collision here is silent: one chunk overwrites
an unrelated one and retrieval quietly returns the wrong content. A 128-bit UUID
makes that a non-issue.

**Keep a side table mapping caller ids to store ids.** Exact, no derivation, no
reserved payload key. Rejected as a whole new piece of state to keep consistent
with the vector store, plus a lookup on every read — to solve a problem a pure
function already solves.

**Return the store's UUID from `search()` and let callers map back.** Simplest
adapter. Rejected because callers then cannot correlate a result with the chunk
they ingested without the side table above.

## Consequences

Easy: `ingestion` (Stage 5) uses content hashes directly and re-running it is
naturally idempotent. Deleting by the caller's own id works, because deletion
derives the same UUID. Swapping to a store with different id rules changes one
function.

Hard: one payload key is reserved, and a caller that wanted that exact key cannot
have it — enforced with a clear error rather than silent overwriting. Payloads also
carry the id twice in effect, which is a few bytes per point.

The namespace constant is now load-bearing in a way that is not obvious from
reading it. It is commented as such, but this is the kind of constant someone
tidies up.

Accepted: derived ids are opaque in the Qdrant dashboard. An operator inspecting
points directly sees UUIDs and has to read `_pointId` to know what a point is —
which is exactly what that key is for.
