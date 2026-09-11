# 13 — Context window resolution

How cli.js decides a model's context window size, and how ClaudeUI mirrors it.
This is not a wire-protocol concern (nothing crosses stdio), but it lives here
because it's reverse-engineered cli.js behavior that drifts with
`claudeCliVersion` and ClaudeUI replicates it independently.

Verified against cli.js **2.1.268**. The 2.1.268 catalog is byte-identical to
2.1.261's except for `effort_cost_index` on fable-5-1/mythos-5-1 (which we do
not mirror) and a new `CLAUDE_CODE_MODEL_CAPABILITIES` env override — same 30
models, same context/pricing/capability records.

---

## 13.1 cli.js resolution chain

Since 2.1.261 (chunked bundle) the per-model facts live in a **baked model
catalog** — a hand-maintained literal object (search
`"Hand-maintained baked-in model catalog"`) with one record per model carrying
`context:{window, native_1m, native_1m_3p, supports_1m_beta, supports_1m_suffix}`,
`max_output_tokens`, `pricing`, `capabilities`, `default_effort` and the alias
tables. The resolver consults it in this order (first match wins; behavior of
the pre-2.1.261 `DR(model, betas)` chain, now catalog-driven):

| #   | Condition                                                                              | Window       |
| --- | -------------------------------------------------------------------------------------- | ------------ |
| 0   | `DISABLE_COMPACT` set **and** `CLAUDE_CODE_MAX_CONTEXT_TOKENS` parses to > 0           | env value    |
| 1   | `/\[1m\]/i.test(modelName)`                                                            | 1,000,000    |
| 2   | request betas include `context-1m-2025-08-07` **and** catalog `supports_1m_beta`       | 1,000,000    |
| 3   | catalog `context.native_1m` (see 13.2)                                                 | 1,000,000    |
| 4   | `claude-sonnet-4-6` + remote config `clientDataCache.kelp_forest_sonnet` parses to > 0 | remote value |
| 5   | fallback                                                                               | 200,000      |

All 1M paths (1–3) are killed by `CLAUDE_CODE_DISABLE_1M_CONTEXT` (truthy per
boolean-env semantics: `1`/`true`/`yes`/`on`, case-insensitive). All three
gates re-verified present in 2.1.261 (`CLAUDE_CODE_DISABLE_1M_CONTEXT`,
`kelp_forest_sonnet`, `context-1m-2025-08-07`).

## 13.2 Implicit-1M models — catalog `native_1m`

Models whose catalog record says `context:{window:1e6,native_1m:!0}` get 1M
**without** `[1m]` in the name. In 2.1.261:

```
claude-fable-5    claude-fable-5-1    claude-mythos-5    claude-mythos-5-1
claude-opus-4-7   claude-opus-4-8     claude-opus-5      claude-sonnet-5
```

Provider gating moved into the catalog: `native_1m_3p:{bedrock,vertex,foundry}`
per model (in 2.1.261 only `claude-sonnet-5` grants all three; the opus/fable
records carry `supports_1m_beta` / `supports_1m_suffix` instead).

Model names are still normalized to base ids by lowercase **substring** match,
so dated ids (`claude-fable-5-20260315`) and provider-prefixed ids (Bedrock
`us.anthropic.claude-opus-4-8-…`) resolve to their base model. Point releases
resolve most-specific-first (`claude-fable-5-1` before `claude-fable-5`).

## 13.3 Alias resolution — catalog `aliases`

Picker aliases resolve to concrete models via the catalog's `aliases` table
(`default` + `per_provider` overrides) before the window resolver ever sees
them. In 2.1.261:

| Alias         | Resolves to (first-party default)                                                                                  | Window |
| ------------- | ------------------------------------------------------------------------------------------------------------------ | ------ |
| `fable`       | `claude-fable-5-1` (gateway: `claude-fable-5`)                                                                     | 1M     |
| `opus`        | `claude-opus-5` (foundry: `claude-opus-4-6`, gateway: `claude-opus-4-7`)                                           | 1M     |
| `sonnet`      | `claude-sonnet-5` (bedrock/vertex/foundry/mantle: `claude-sonnet-4-5`, anthropic_aws/gateway: `claude-sonnet-4-6`) | 1M¹    |
| `haiku`       | `claude-haiku-4-5`                                                                                                 | 200K   |
| `<alias>[1m]` | resolved model + `[1m]` suffix                                                                                     | 1M     |

¹ first-party; the per-provider sonnet targets are 200K models (row 4's
kelp_forest override may apply to sonnet-4-6).

## 13.4 ClaudeUI's mirror

Core resolver: `resolveContextWindow(modelValue)` in
`src/shared/model-capabilities.ts`. It replicates rows 1, 3, 5 and resolves the
`fable`/`opus` aliases itself. `getContextWindowSize()` in
`src/core/services/context-window.ts` wraps it, layering on the
`CLAUDE_CODE_DISABLE_1M_CONTEXT` kill switch, which is read host-process-side
only (the renderer has no access to that env var, so it calls the shared
resolver directly).

The window is computed **once, in the main process**, and the resulting
`usedPercentage` / `remainingPercentage` ride along in `StatusLineData`:

- **Live** — `claude-session.ts` `buildStatusLineFromAccumulators()` /
  reconciliation via `computeTokenMetrics`. `setModel` re-emits the status line
  on a model switch, so the percentage stays reactive.
- **History** — `session-history.ts` `computeTokenMetrics`.

The renderer's `StatusLine` (`InputBox/View.tsx`) just renders the
main-computed value — it no longer recomputes the window. A prior renderer-side
recompute was the source of two bugs (see history below).

**`default` and other server-resolved aliases.** We store the picker alias, not
the resolved id, so `default` alone can't be sized (it could be Opus → 1M or
Sonnet → 200K depending on account/config). The resolved canonical id is
recovered from the wire instead:

- Live: the `model` field on `system/init` (4.2) → `claude-session.ts`
  `resolvedModelId`, used by the `contextWindowSize` getter when `this.model`
  is `default`.
- History: the `message.model` on the latest main-chain assistant line in the
  transcript → `computeTokenMetrics` `transcriptModel`, which takes precedence
  over the caller-supplied alias (the transcript records the resolved id).

Known divergences (accepted):

- **No provider gate** (13.2): we assume 1M-eligible. A custom-endpoint user
  may see 1M displayed where cli.js compacts at 200K.
- **No beta header path** (13.1 row 2): ClaudeUI never sends custom betas.
- **No remote-config override** (13.1 row 4): sonnet-4-6 stays 200K for us
  even if the server-side experiment raises it.
- **No `CLAUDE_CODE_MAX_CONTEXT_TOKENS` override** (13.1 row 0).

History: before 2026-06 the renderer did its own `/1m/i` test against the model
picker _description_, which (a) missed every implicit-1M model (Fable 5 / Opus
4.8 carry no "1m" marker) so they were capped at 200K, and (b) clobbered the
correct main-computed value for loaded historical sessions, sizing them off the
store's `selectedModel` (often `default`) rather than the model that actually
ran. Both fixed by deleting the renderer recompute and resolving `default` from
the init / transcript model id.

## 13.5 Drift check on version bump

When `claudeCliVersion` bumps:

1. Locate the baked catalog: search cli.js for
   `"Hand-maintained baked-in model catalog"`. Every per-model fact (window,
   native_1m, pricing tier, capabilities, aliases) is in that literal.
2. Diff the `context:{window:1e6,native_1m:!0}` model set against
   `IMPLICIT_1M_BASE_MODELS` in `src/shared/model-capabilities.ts` (remember
   substring matching — a point release like `claude-fable-5-1` is already
   covered by its `claude-fable-5` prefix; a new family/major like
   `claude-opus-5` is NOT).
3. Re-check the catalog's `aliases` table (`fable`/`opus`/`sonnet`/`haiku`
   defaults) against `IMPLICIT_1M_ALIASES` and `canonicalizeModelValue`.
4. Also diff `pricing_tiers` + per-model `pricing` against
   `src/shared/pricing.ts`, and `capabilities`/`default_effort`/
   `max_output_tokens` against the id-heuristics in `model-capabilities.ts`
   (supportsEffort / supportsXhighEffort / supportsAdaptiveThinking /
   defaultEffort / maxOutputTokens).
5. Verify the env/beta/remote gates still exist (grep
   `CLAUDE_CODE_DISABLE_1M_CONTEXT`, `kelp_forest_sonnet`,
   `context-1m-2025-08-07`) and update the version banner above.
