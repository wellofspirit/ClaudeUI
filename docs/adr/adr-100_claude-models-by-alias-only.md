# ADR-100: Claude models are picked by alias only; ClaudeUI follows the model cli.js resolves

**Status:** Accepted (2026-10-09, owner ruling).
**Amends:** [ADR-074](adr-074_provider-surfaces-v3.md) §8 (Starting effort per model lists one row per
alias, not one per model cli.js offers; "Start new sessions on" offers aliases only).
**Relates to:** [ADR-059](adr-059_no-silent-model-fallback.md) (the stale-model path a saved pick no alias
reaches falls through to), [ADR-082](adr-082_harness-sources-downloads-and-unbundling.md) §3 (floor = tested,
the 2.1.293 bump that surfaced this).

## Context

cli.js's `initialize` reports a model list for the signed-in account: the aliases (`default`, `fable`,
`opus`, `sonnet`, `haiku`), each with the `resolvedModel` it runs today, followed by concrete model ids
(`claude-sonnet-5`, `claude-opus-5`, `claude-fable-5`, `claude-opus-4-8`, `claude-opus-4-7`,
`claude-opus-4-6`, `claude-sonnet-4-6` on 2.1.293). ClaudeUI showed all of them: twelve rows in the
composer picker, in "Start new sessions on" and in "Starting effort per model".

Which model an alias runs is not fixed by the CLI release. cli.js resolves `opus`, `sonnet` and `haiku`
against a model catalog the server serves per account, cached under `~/.claude/cache/model-catalog/`,
and falls back to the catalog baked into the build. Observed on the same 2.1.293 binary and account:
on 2026-10-08, `haiku` resolved to `claude-haiku-4-5-20251001` in both the `initialize` row and a real
turn's `system/init.model`. On 2026-10-09, after the served catalog was refreshed at 09:07, it resolved
to `claude-haiku-5-5`, with a 1M context window, effort support and a tenth of the price. ClaudeUI's
mirror of the baked catalog (`canonicalizeModelValue`, the implicit-1M lists, the effort heuristics,
`pricing.ts`) could not have predicted either answer for a given day.

## Decision

1. **Aliases only.** Every Claude model list in ClaudeUI offers `default`, the family aliases and their
   `[1m]` variants, plus any non-`claude-` value cli.js offers (a gateway's custom model option). Concrete
   Anthropic ids are dropped once, where the catalog is fetched (`queryClaudeModels`), so the composer,
   settings, automations, remote and the headless server all see the same list. Each alias row shows the
   model it resolves to today, as reported by cli.js.
2. **Saved concrete picks move to their alias.** A saved default model, last pick, automation model or
   effort key that names a concrete model is mapped to the family alias that currently resolves to it.
   It is never mapped to `default`, which means "follow the recommendation", a different intent. An id
   no alias reaches is left unchanged and surfaces through ADR-059's stale-model path. Existing
   sessions' stored models and transcripts are not rewritten.
3. **The session follows cli.js.** Once `system/init` reports the resolved model, a session on `default`
   or any family alias takes its context window, capabilities and price from that model, not from
   ClaudeUI's alias table. The built-in mirrors stay as fallbacks for the moments before cli.js answers,
   and they track the baked catalog on each bump (2.1.293: `haiku` → `claude-haiku-5-5`).
4. **ClaudeUI's own one-shot calls use aliases too.** The commit-message generator asks for `haiku`
   instead of a pinned `claude-haiku-4-5-20251001`.

## Consequences

- An alias moving to a new model needs no ClaudeUI release, and the effort keyed on it moves with it
  (ADR-074 §8, 2026-09-30 amendment). The table no longer shows models nobody picks.
- A user can no longer pin an older Anthropic model from the picker. Pinning stays available through
  Claude › Endpoint's model mapping (the `pin` override) and `ANTHROPIC_DEFAULT_*_MODEL`-style overrides,
  which apply before alias resolution.
- The fallback mirrors can still be briefly wrong for a session's first moments, before `system/init`,
  and on a third-party provider whose alias targets differ from first-party. That was already true.

## Alternatives considered

- **Keep every row and fix the mirrors.** This keeps chasing a server-side decision ClaudeUI cannot see.
  Rejected.
- **Leave saved concrete picks stale.** Simpler, but every user with a saved concrete default would have
  to re-pick after an upgrade. Rejected by the owner in favour of mapping.
