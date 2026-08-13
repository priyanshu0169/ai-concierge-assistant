# ADR 0017: Crawl behaviour is site-profile data, not code

Status: Accepted
Date: 2026-07-31
Stage: 4

## Context

A crawl is defined by a set of store-specific facts: where to start, which sitemaps to
read, which URLs are content and which are cart pages, how deep to go, how fast to go,
and which paths are FAQs rather than blog posts.

Every one of those differs per store, and none of them is a secret. They also change
without a release — a store reorganises its help centre, or someone notices the crawler
wandering into a faceted-search trap and adds an exclude pattern.

The failure mode this decision exists to prevent is the obvious one: a scraper with a
store's URL patterns compiled into it. That codebase serves one store, and the second
store is served by a fork.

## Decision

**All crawl behaviour lives in `config/site-profile.json`, under `content.sources[]`.**
No path, host, pattern or store name appears anywhere in `@shopsage/scraper`.

Each entry is a discriminated union member keyed on `type` (`website` today):
`startUrls`, `sitemaps`, `include`, `exclude`, `allowedHosts`, `classify`, `maxDepth`,
`maxPages`, `requestsPerSecond`, `respectRobotsTxt`, `maxDocumentCharacters`,
`contentType`, `enabled`.

It belongs in the site profile rather than the environment because it passes the same
test `identity` and `prompts` pass: store-identifying, non-secret, differs per store,
edited by someone who is not deploying. It is validated at boot with everything else,
so a malformed regular expression is a configuration error naming the offending source
index — not an exception thrown three hundred pages into a crawl.

Four choices inside that are deliberate:

- **`include` empty means "no opinion", not "nothing".** Requiring a pattern to crawl
  anything would make the simplest possible configuration silently produce zero
  documents.
- **`exclude` is evaluated before `include`,** so exclude always wins. An operator who
  adds `/checkout` expects it gone, not overridden by a broad include pattern written
  last month.
- **`allowedHosts` defaults to the hosts of the seeds.** A crawler with no host
  restriction follows a footer link and starts crawling the internet. The safe
  behaviour has to be the one you get without thinking about it.
- **`respectRobotsTxt` defaults to true, and `requestsPerSecond` is capped at 50.** A
  crawler is an unannounced visitor to someone's production website. A site's own
  `Crawl-delay` is honoured when it asks for less than the profile configured — the
  configured rate is a ceiling, never an entitlement.

**This section is not part of the browser-safe subset served by `GET /v1/config`**
(Stage 8). A crawl plan is operational detail, and exclude patterns in particular can
name paths a store would rather not advertise.

## Alternatives

**Environment variables.** Consistent with other infrastructure settings, and no schema
work. Rejected because this is list- and object-shaped — several sources, each with
several pattern arrays — and encoding that into flat strings produces
`CONTENT_SOURCE_1_EXCLUDE_3`. It also puts store behaviour in the environment, which
[ADR 0004](0004-configuration-boundary.md) forbids for good reasons: changing an exclude
pattern would become a redeployment.

**A separate `crawl.json`.** Keeps a large section out of the profile, and lets crawl
config be owned by a different person. Genuinely tempting. Rejected because it splits
per-store configuration across two files that must be kept in step, and because
multi-store hosting (post-Stage 10) resolves _one_ profile per request — a second file
would need its own resolution path for no benefit.

**A code module per store.** Maximum flexibility: arbitrary logic per site. Rejected
outright — it is the fork-per-store outcome this project exists to avoid, and it makes
"onboard a store" a release rather than a configuration change.

**CLI flags on the ingestion command.** Fine for an experiment. Rejected as the primary
mechanism because the configuration would live in whatever ran the command — a cron
entry, someone's shell history — rather than in a reviewable file.

**Declarative URL globs instead of regular expressions.** Friendlier to non-engineers,
and impossible to write a catastrophic pattern in. A real trade-off, and globs lose
the ability to express alternation and anchoring that these patterns actually need
(`^https://host/(help|guides)(/|$)`). Regular expressions are kept, validated at boot;
a glob layer on top remains open if operators find them painful.

## Consequences

Easy: onboarding a store is one profile entry — no code change, no rebuild, no fork. The
same build serves two stores with completely different URL layouts. Crawl scope is
reviewable in a diff, and a bad pattern fails at boot naming its source. `enabled: false`
lets an operator park a source without deleting configuration they will want back.

Hard: the site profile now carries operational configuration alongside branding and
copy, which weakens the tidy story that a profile is only customer-facing settings. It
is also now large enough that a store's profile wants reviewing by two different
people. And regular expressions in a JSON file are genuinely unpleasant to write —
which is why the preview CLI exists.

The example shipped in `config/site-profile.json` is `enabled: false`, deliberately: an
example configuration must never crawl someone's website because a developer ran the
default stack.

Accepted: a determined operator can still point a crawl at a site they do not own, and
nothing here prevents that beyond honouring robots.txt by default. The safeguards are
about accidents, not about a hostile operator.
