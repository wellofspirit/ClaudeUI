# 13 — Context window resolution

How cli.js decides a model's context window size, and how ClaudeUI mirrors it.
This is not a wire-protocol concern (nothing crosses stdio), but it lives here
because it's reverse-engineered cli.js behavior that drifts with
`claudeCliVersion` and ClaudeUI replicates it independently.

Verified against cli.js **2.1.114**.

---

## 13.1 cli.js resolution chain

Resolver: `DR(model, betas)` — cli.js@char3227080. First match wins:

| # | Condition | Window | Anchor |
|---|---|---|---|
| 0 | `DISABLE_COMPACT` set **and** `CLAUDE_CODE_MAX_CONTEXT_TOKENS` parses to > 0 | env value | cli.js@char3227080 |
| 1 | `/\[1m\]/i.test(modelName)` (`_J()`) | 1,000,000 | cli.js@char3226450 |
| 2 | request betas include `context-1m-2025-08-07` **and** model is 1M-eligible (`bU()`) | 1,000,000 | cli.js@char3226880 |
| 3 | implicit-1M model (`UE()`, see 13.2) | 1,000,000 | cli.js@char3226523 |
| 4 | model is `claude-sonnet-4-6` and remote config `clientDataCache.kelp_forest_sonnet` parses to > 0 (`a56()`) | remote value | cli.js@char3227310 |
| 5 | fallback (`AP_`) | 200,000 | cli.js@char3228870 |

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

| Alias | Resolves to | Window |
|---|---|---|
| `fable` | `claude-fable-5` (or `ANTHROPIC_DEFAULT_FABLE_MODEL`) | 1M |
| `opus` | `claude-opus-4-8` first-party, `claude-opus-4-7` on mantle (or `ANTHROPIC_DEFAULT_OPUS_MODEL`) | 1M |
| `sonnet`, `opusplan` | `claude-sonnet-4-6` | 200K¹ |
| `haiku` | `claude-haiku-4-5` | 200K |
| `<alias>[1m]` | resolved model + `[1m]` suffix | 1M |

¹ unless the kelp_forest remote-config override (13.1 row 4) applies.

## 13.4 ClaudeUI's mirror

`getContextWindowSize()` in `src/main/services/context-window.ts`. Consumers:
`claude-session.ts` (status line) and `session-history.ts`
(`computeTokenMetrics`). It replicates rows 1, 3, 5 plus the
`CLAUDE_CODE_DISABLE_1M_CONTEXT` kill switch, and resolves the `fable`/`opus`
aliases itself (we store the picker alias, not the resolved id).

Known divergences (accepted):

- **No provider gate** (13.2): we assume 1M-eligible. A custom-endpoint user
  may see 1M displayed where cli.js compacts at 200K.
- **No beta header path** (13.1 row 2): ClaudeUI never sends custom betas.
- **No remote-config override** (13.1 row 4): sonnet-4-6 stays 200K for us
  even if the server-side experiment raises it.
- **No `CLAUDE_CODE_MAX_CONTEXT_TOKENS` override** (13.1 row 0).

History: before 2026-06 this was a `/1m/i` test against the model picker
*description*, which missed every implicit-1M model (Fable 5's description
contains no "1m") and would also miss `sonnet[1m]` for account types whose
description reads "Sonnet 4.6 for long sessions".

## 13.5 Drift check on version bump

When `claudeCliVersion` bumps:

1. Re-locate `DR()`: `bundle-analyzer find vendor/claude-cli/cli.js "CLAUDE_CODE_MAX_CONTEXT_TOKENS"` — the enclosing function is the resolver.
2. Diff the `UE()` base-model list against `IMPLICIT_1M_BASE_MODELS` in `context-window.ts`.
3. Re-check what `fable`/`opus` resolve to in `U7()` (search `case"fable"`) against `IMPLICIT_1M_ALIASES`.
4. Update anchors and the version banner above.
