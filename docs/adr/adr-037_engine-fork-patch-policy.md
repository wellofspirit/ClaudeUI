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
   and pinned like the binary itself. The auto-mode judge spawn keeps
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
