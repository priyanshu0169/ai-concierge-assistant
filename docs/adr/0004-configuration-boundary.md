# ADR 0004: Configuration boundary — environment versus site profile

Status: Accepted
Date: 2026-07-30
Stage: 1

## Context

Everything store-specific must be configuration, so one build serves any Magento store. That covers a
wide range of things: the assistant's name, the system prompt, brand colours, which capabilities are
enabled, retrieval tuning, service addresses, and API credentials.

Treating all of that as one undifferentiated pile of "config" causes two specific failures. Put a
credential in a file that is committed, edited by marketing, and partly served to browsers, and you
have leaked it. Put an 800-character system prompt in an environment variable, and you have made copy
changes a redeployment and made the prompt unreadable and un-diffable.

## Decision

Two sources with a hard boundary.

**Environment variables** hold infrastructure and secrets: service URLs, API keys, timeouts, ports,
log level. Rarely differ between stores. Injected by the platform or a secret manager.

**`config/site-profile.json`** holds behaviour and identity: company and assistant names, prompts and
copy, branding, feature flags, retrieval tuning, localization. Always differs between stores. Never
secret. Selected by `SITE_PROFILE_PATH`.

The rule, stated so it can be applied in review: **a secret never appears in a site profile, and
customer-facing copy never appears in the environment.**

Supporting decisions:

- Both are validated with zod at boot; failure is fatal. A store answering customers from a half-valid
  profile is worse than a store that is down.
- The site profile is **strict** — unknown keys are rejected. Silently ignoring `topk` while `topK`
  keeps its default is the kind of bug that surfaces months later as "retrieval tuning does nothing".
- Blank environment values are treated as absent, so `FOO=` falls back to the default. Operators leave
  placeholders in env files constantly; reading those as the empty string would defeat every default.
- The profile is **sectioned** (`identity`, `prompts`, `branding`, `retrieval`, `features`,
  `integrations`) rather than flat, so ownership is obvious: marketing owns `prompts`, design owns
  `branding`, engineering owns `retrieval`.
- Feature flags default to **off**, so adding a capability to the platform cannot change an existing
  store's behaviour until its profile opts in.
- Where both sources can specify the same thing — `magentoApiUrl` — **the profile wins**, because the
  Magento address is store-identifying data. The token stays in the environment because it is a secret.

## Alternatives

**Everything in environment variables.** Pure twelve-factor and needs no file. Rejected because
multi-line prompts in env vars are unreadable and unreviewable, structure has to be faked with
`PROMPT_1`/`PROMPT_2` naming, and there is no schema to validate against.

**Everything in one config file.** Simple and structured. Rejected because it puts secrets in a file
that gets committed, mounted, and partially served to browsers. One `git add` and the LLM key is in
history.

**A configuration service or database.** Runtime updates without redeploying, an admin UI later.
Rejected as premature: it adds a network dependency to startup and a bootstrapping problem — the
service needs configuration to find its configuration.

**Flat profile keys, as originally sketched.** Matches the original specification most literally.
Rejected on maintainability: the profile already has more than thirty keys, and a flat object of that
size stops being navigable.

## Consequences

Easy: onboarding a store is a JSON file plus a few environment variables — no code change, no rebuild.
Secrets stay in the secret manager. `GET /health/info` proves at runtime which profile is live. Typos
fail at boot with the offending key named.

Hard: two places to look. The boundary needs judgement for genuinely ambiguous settings, and
`magentoApiUrl` already needed an explicit precedence rule — a sign that more such cases will appear.
Changing a profile requires a restart, since it is read once at boot.

Accepted: the profile is read once. Hot reloading is possible later behind the same
`loadConfig` seam, but a mid-request configuration change raises consistency questions that are not
worth answering yet.
