# ADR-037: Engine customization policy — fork+patch opencode, extend pi, no upstreaming

**Status:** Accepted (2026-08-01)
**Supersedes:** the "do not fork; do not vendor a pi plugin" decision in
`docs/automode-rework-plan.md` §2 (amended in place).
**Related:** ADR-023 (+2026-08-01 amendment), ADR-035 (pi integration), ADR-036 (auth vault).

## Context

The auto-mode rework left capabilities on the table that the engines' public
surfaces cannot provide: enforced `max_tokens`/`stop_sequences`/prompt caching
on judge calls (the standing ADR-023 deviation), a root fix for the
instance-global `approved`-list piercing of judge deny-all rulesets (plan §7
Q5), and matched-rule provenance on `permission.asked`. We already run a
fork+patch pipeline against minified cli.js with re-derivation READMEs and
behavioral bump verification; opencode is vendored as pinned TypeScript
source, making source-level patches strictly cheaper than the cli.js practice.

Upstreaming was considered and rejected: opencode is commercializing its own
desktop product. Our patches serve ClaudeUI's needs, which do not necessarily
align with upstream's goals, and we do not want involvement in a potentially
paid upstream. Consequence accepted: upstream divergence will accelerate, and
patches must be narrow and re-verified per bump.

## Decision

1. **opencode: fork + patch, never upstream.** Patches are built into the
   vendored binary via the existing ensure/update pipeline. Initial inventory:
   - **P1 — tool-less judge/completion endpoint**: `{model, system, user,
maxTokens, stopSequences, cacheHint}` → text; bypasses the session/tool/
     permission machinery entirely. Resolves the ADR-023 deviation AND Q5 (no
     tool layer → nothing to pierce); deliberately avoids the in-rewrite
     permission layer (v2 schema already staged in 1.17.14) so it survives it.
   - **P2 — session-scoped `approved` list** (defense in depth once P1 moves
     the judge off sessions).
   - Provenance on `permission.asked` only if a later need justifies it; the
     tested `wildcard.ts` port stands meanwhile.
2. **pi: extend, don't patch.** pi was chosen for flexibility; new
   capabilities ride its extension API (the `-e` bridge precedent), vendored
   and pinned like the binary itself. pi's source is public
   (github.com/earendil-works/pi), so this is a policy choice with fork held
   in reserve as a last resort — the escalation ladder is extension hooks →
   spawn flags / ephemeral processes → upstream feature request → fork, and
   nothing in phases 1–4 got past the second rung. The auto-mode judge spawn keeps
   `--no-tools --no-extensions --no-context-files` — our own extensions must
   never load into the security judge.
3. **Maintenance protocol per version bump** (mirrors the cli.js discipline):
   re-apply patches, run the behavioral patch test harnesses (apply-success ≠
   correct), and **check the upstream license** — a license change freezes us
   on the last acceptable pinned version until decided otherwise.

## Consequences

Phase 5 of the auto-mode plan changes shape: the default judge transport can
become the patched opencode endpoint (opencode remains the API client, so no
new auth surface and no vendor-ToS question for opencode-routed providers);
the dedicated-classifier-key direct transport becomes unnecessary for opencode
and remains an option only if ever needed elsewhere. ADR-036's
Anthropic-tokens-vend-to-Claude-Code-only constraint is unaffected.

## P1 status — SHIPPED 2026-08-01

Fork: `wellofspirit/opencode`, branch `claudeui` off `v1.18.9` (MIT at tag),
commits `98a12dd` + `1d58883` (Codex fix: the backend rejects non-streaming
calls — route uses `streamText`; `max_output_tokens` stripped and codex
headers replicated from the built-in plugins WITHOUT running user plugins on
the judge path). Live-verified against gpt-5.6-luna and qwen3.8-max-preview;
`maxTokens` genuinely enforced where the provider accepts it (openai's
Responses API drops both knobs — recorded in the route's /doc). ClaudeUI:
`judge-transport.ts` prefers the endpoint with a GET /doc probe — NEVER a
speculative POST: an unpatched opencode proxies unknown routes to
app.opencode.ai, which would exfiltrate the judge transcript — and falls back
to the tool-denied session transport. `ensure-opencode` builds from the fork
by default (release download behind --from-release). Q5 is mooted for judge
calls on the endpoint path; the ADR-023 advisory-fields deviation is resolved
there.

## Bump to v1.18.10 + P2 status — SHIPPED 2026-08-01

First bump under the §3 protocol: license still MIT (gate passed), permission
v1 path intact, zero upstream drift in our patched files; 29 conflicts, all
mechanical version strings. Fork @ `27a23b8cc`.

P2 reshaped per user decision (global "always" matches Claude semantics and
stays): a `permissionHermetic` PATCH flag SEALS a throwaway session — its
evaluate skips the instance `approved` list, and its own "always" replies are
never added to it (sink, not source). Unpatched binaries strip unknown PATCH
fields (measured: Effect Schema is non-strict), so ClaudeUI sends the flag
unconditionally for its three sealed-session sites (judge fallback, /btw,
agent-generate). Piercing reproduction lives in the fork's own test suite
(needs a real Permission.ask). Re-derivation guide: `patch/opencode-fork/README.md`.

## P3 status (judge prompt caching) — SHIPPED 2026-08-01

Fork @ `163b5762`. The judge's ~24 KB system prompt is now cached: an explicit
`cache_control` breakpoint on the system message for providers that take one
(gate + marker set extracted from `ProviderTransform.applyCaching` and shared,
not copied), and for automatic-prefix-cache providers nothing but the
guarantee that nothing varying is sent ahead of the user turn — which cost one
fix, the per-call random `session-id` header, now a hash of the system prompt
(also used as `promptCacheKey`). Only the system part is marked; the user turn
is a different transcript every call. Request payload unchanged (capability-
and content-driven, so nothing for a caller to opt into); the response gains an
optional `usage` carrying `cacheReadInputTokens`, the only in-band proof it
works. Measured: 3840/4958 input tokens cached from call 2 on gpt-5.6-luna,
4224/5131 on qwen3.8-max-preview, zero under the varying-system control
(`patch/opencode-fork/live-judge-cache.py`). ClaudeUI needed no code change —
`buildPolicyPrompt` was already deterministic — but the byte-stability it now
depends on is pinned by tests rather than assumed. The one known in-session
prefix break is deliberate: `repoVisibility` is absent until a command triggers
its capture, so the document has two forms per session, not one.
