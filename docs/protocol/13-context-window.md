# 13 — Context window resolution

How cli.js decides a model's context window size, and how ClaudeUI mirrors it.
This is not a wire-protocol concern (nothing crosses stdio), but it lives here
because it's reverse-engineered cli.js behavior that drifts with
`claudeCliVersion` and ClaudeUI replicates it independently.

Verified against cli.js **2.1.114**.

---

## 13.1 cli.js resolution chain

Resolver: `DR(model, betas)` — cli.js@char3227080. First match wins:

| #   | Condition                                                                                                   | Window       | Anchor             |
| --- | ----------------------------------------------------------------------------------------------------------- | ------------ | ------------------ |
| 0   | `DISABLE_COMPACT` set **and** `CLAUDE_CODE_MAX_CONTEXT_TOKENS` parses to > 0                                | env value    | cli.js@char3227080 |
| 1   | `/\[1m\]/i.test(modelName)` (`_J()`)                                                                        | 1,000,000    | cli.js@char3226450 |
| 2   | request betas include `context-1m-2025-08-07` **and** model is 1M-eligible (`bU()`)                         | 1,000,000    | cli.js@char3226880 |
| 3   | implicit-1M model (`UE()`, see 13.2)                                                                        | 1,000,000    | cli.js@char3226523 |
| 4   | model is `claude-sonnet-4-6` and remote config `clientDataCache.kelp_forest_sonnet` parses to > 0 (`a56()`) | remote value | cli.js@char3227310 |
| 5   | fallback (`AP_`)                                                                                            | 200,000      | cli.js@char3228870 |

All 1M paths (1–3) are killed by `CLAUDE_CODE_DISABLE_1M_CONTEXT` (truthy per
`__()` boolean-env semantics: `1`/`true`/`yes`/`on`, case-insensitive —
cli.js@char27057).

## 13.2 Implicit-1M models — `UE()`

These models get 1M **without** `[1m]` in the name:

```
claude-fable-5    claude-mythos-5    claude-opus-4-7    claude-opus-4-8
```

Gated on provider (`Rj()`): first-party (`ANTHROPIC_BASE_URL` unset or
`api.anthropic.com` — `F5()`, cli.js@char2106853), Bedrock (`anthropicAws`),
or `mantle`. **Not** Vertex or Foundry.

Model names are normalized before comparison by `W9()`/`eD()`
(cli.js@char2252070): lowercase **substring** match against the base-model
list, so dated ids (`claude-fable-5-20260315`) and provider-prefixed ids
(Bedrock `us.anthropic.claude-opus-4-8-…`) resolve to their base model.

## 13.3 Alias resolution — `U7()`

Picker aliases resolve to concrete models (cli.js@char2255303) before `DR()`
ever sees them:

| Alias                | Resolves to                                                                                    | Window |
| -------------------- | ---------------------------------------------------------------------------------------------- | ------ |
| `fable`              | `claude-fable-5` (or `ANTHROPIC_DEFAULT_FABLE_MODEL`)                                          | 1M     |
| `opus`               | `claude-opus-4-8` first-party, `claude-opus-4-7` on mantle (or `ANTHROPIC_DEFAULT_OPUS_MODEL`) | 1M     |
| `sonnet`, `opusplan` | `claude-sonnet-4-6`                                                                            | 200K¹  |
| `haiku`              | `claude-haiku-4-5`                                                                             | 200K   |
| `<alias>[1m]`        | resolved model + `[1m]` suffix                                                                 | 1M     |

¹ unless the kelp_forest remote-config override (13.1 row 4) applies.

## 13.4 ClaudeUI's mirror

Core resolver: `resolveContextWindow(modelValue)` in
`src/shared/model-capabilities.ts`. It replicates rows 1, 3, 5 and resolves the
`fable`/`opus` aliases itself. `getContextWindowSize()` in
`src/main/services/context-window.ts` wraps it, layering on the
main-process-only `CLAUDE_CODE_DISABLE_1M_CONTEXT` kill switch (the renderer has
no access to that env var, so it calls the shared resolver directly).

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

1. Re-locate `DR()`: `bundle-analyzer find vendor/claude-cli/cli.js "CLAUDE_CODE_MAX_CONTEXT_TOKENS"` — the enclosing function is the resolver.
2. Diff the `UE()` base-model list against `IMPLICIT_1M_BASE_MODELS` in `context-window.ts`.
3. Re-check what `fable`/`opus` resolve to in `U7()` (search `case"fable"`) against `IMPLICIT_1M_ALIASES`.
4. Update anchors and the version banner above.
