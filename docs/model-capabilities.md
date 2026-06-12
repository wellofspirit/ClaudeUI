# Model Capabilities Reference

This document is the source of truth for which thinking modes and effort levels each Claude model supports in ClaudeUI. The same matrix is implemented in `src/shared/model-capabilities.ts` and consumed by both the renderer (UI gating) and main process (request building).

**Capabilities are read from the SDK first, heuristics second.** The agent SDK's `supportedModels()` returns each model's `supportsEffort`, `supportedEffortLevels`, and `supportsAdaptiveThinking` directly. ClaudeUI model values are user-facing **aliases** like `default`, `sonnet`, `sonnet[1m]`, `haiku` — not canonical ids like `claude-opus-4-7-...` — so id-pattern matching cannot answer capability questions reliably. The id-based heuristics documented below are a fallback for models where the SDK omits the fields (e.g. `haiku` in the current SDK version) and for forward-compatibility with future models.

When a new Claude model is released, the SDK will typically carry the right flags and ClaudeUI will just work. Update this doc and `model-capabilities.ts` only when the SDK omits or changes the capability fields — the appendix describes how to re-verify against the bundled cli.js.

## Thinking modes

Three modes, surfaced in the InputBox picker:

| Mode         | What it does                                                                                                                                                                                    | When the API rejects it                                                                                  |
| ------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| **adaptive** | Claude decides when and how much to think. Required on Opus 4.7.                                                                                                                                | Models that don't support adaptive (see below). The UI greys out this option for them.                   |
| **enabled**  | Fixed budget thinking. Budget is omitted in the request — the SDK fills `Fgq(model) = upperLimit - 1` (e.g. 127999 for Opus 4.7-class models, 63999 for Sonnet 4.5, 8191 for older Sonnet 3.5). | Opus 4.7 returns 400 — we never send `enabled` to it because `adaptive` is auto-resolved when supported. |
| **disabled** | No extended thinking.                                                                                                                                                                           | Universally accepted.                                                                                    |

ClaudeUI **always** sends `display: "summarized"` alongside non-disabled thinking. This is what makes Opus 4.7 emit `thinking_delta` events with the model's reasoning summary; without it, Opus 4.7 streams an empty thinking block (only a `signature_delta`) and the user sees no chain-of-thought.

`display` is a no-op on models that don't honour it, so it's safe to include unconditionally.

### Default thinking mode

Picked per-model when a session is created:

- Model supports adaptive → `adaptive`
- Otherwise → `enabled`

Switching the model during a session auto-coerces the current thinking mode if the new model doesn't support it (e.g. switching from Opus 4.7 with `adaptive` to Sonnet 4.5 will snap to `enabled`).

## Effort levels

The effort dropdown sets `output_config.effort` in the API request. It controls thinking depth and overall token spend. Five levels:

| Level      | Notes                                                                                                |
| ---------- | ---------------------------------------------------------------------------------------------------- |
| **low**    | Minimal thinking, fastest responses. Useful for subagents and simple tasks.                          |
| **medium** | Moderate thinking.                                                                                   |
| **high**   | Default for most modern models.                                                                      |
| **xhigh**  | Deeper than high. **Opus 4.7 only.** Default in Claude Code on Opus 4.7.                             |
| **max**    | Maximum effort. Available on Opus 4.6, Opus 4.7, and Sonnet 4.6. **Not** on Haiku or pre-4.6 models. |

If the user is on a model without effort support, the dropdown is hidden entirely. If they're on a model that supports effort but not a particular level (e.g. `xhigh` on Sonnet 4.6), that row in the dropdown is greyed out with a tooltip.

### Default effort per model

| Model                            | Default |
| -------------------------------- | ------- |
| Opus 4.7                         | `xhigh` |
| Opus 4.6 / Sonnet 4.6            | `high`  |
| Older models with effort support | `high`  |

## Capability matrix

Status as of SDK version `2.1.112` (April 2026).

Real `supportedModels()` output for a Max-plan user:

```json
[
  {
    "value": "default",
    "displayName": "Default (recommended)",
    "description": "Opus 4.7 with 1M context · Most capable for complex work",
    "supportsEffort": true,
    "supportedEffortLevels": ["low", "medium", "high", "xhigh", "max"],
    "supportsAdaptiveThinking": true
  },
  {
    "value": "sonnet",
    "displayName": "Sonnet",
    "description": "Sonnet 4.6 · Best for everyday tasks",
    "supportsEffort": true,
    "supportedEffortLevels": ["low", "medium", "high", "max"],
    "supportsAdaptiveThinking": true
  },
  {
    "value": "sonnet[1m]",
    "displayName": "Sonnet (1M context)",
    "description": "Sonnet 4.6 with 1M context · Billed as extra usage",
    "supportsEffort": true,
    "supportedEffortLevels": ["low", "medium", "high", "max"],
    "supportsAdaptiveThinking": true
  },
  {
    "value": "haiku",
    "displayName": "Haiku",
    "description": "Haiku 4.5 · Fastest for quick answers"
  }
]
```

`haiku` ships without capability fields; ClaudeUI's id heuristic recognises the `haiku` substring and correctly reports no effort / no adaptive.

The id-based table below applies to canonical model ids and to heuristic fallback when the SDK omits fields for a new model.

| Model                   | Adaptive thinking  |       Effort       | xhigh | max |
| ----------------------- | :----------------: | :----------------: | :---: | :-: |
| **claude-opus-4-7**     |         ✅         |         ✅         |  ✅   | ✅  |
| **claude-opus-4-6**     |         ✅         |         ✅         |  ❌   | ✅  |
| **claude-sonnet-4-6**   |         ✅         |         ✅         |  ❌   | ✅  |
| claude-opus-4-5         |         ❌         |         ❌         |  ❌   | ❌  |
| claude-opus-4-1         |         ❌         |         ❌         |  ❌   | ❌  |
| claude-opus-4 / -4-0    |         ❌         |         ❌         |  ❌   | ❌  |
| claude-sonnet-4-5       |         ❌         |         ❌         |  ❌   | ❌  |
| claude-sonnet-4 / -4-0  |         ❌         |         ❌         |  ❌   | ❌  |
| claude-3-7-sonnet       |         ❌         |         ❌         |  ❌   | ❌  |
| claude-3-5-sonnet       |         ❌         |         ❌         |  ❌   | ❌  |
| claude-3-opus / -sonnet |         ❌         |         ❌         |  ❌   | ❌  |
| All `*-haiku-*`         |         ❌         |         ❌         |  ❌   | ❌  |
| Unknown / future        | ✅ (assume modern) | ✅ (assume modern) |  ❌   | ✅  |

### Rules

- **Adaptive thinking** is gated by an explicit allowlist (Opus 4.7, Opus 4.6, Sonnet 4.6). All other named families return false. Unknown families default to true on the assumption that future models support adaptive — re-verify when a new model ships.
- **Effort support** uses the same allowlist as adaptive thinking.
- **xhigh** is Opus 4.7 only.
- **max** is denied for haiku and for an explicit legacy set: opus-4-5, opus-4-1, opus-4-0, opus-4, sonnet-4-5, sonnet-4-0, sonnet-4, 3-7-sonnet, 3-5-sonnet, 3-sonnet, 3-opus.

The model identifier is normalised before lookup: lowercased, date suffixes (`-20260101`) and version suffixes (`-v1`, `-v1:0`) stripped.

## Streaming behaviour

When thinking is non-disabled, the SDK emits `content_block_start` for a thinking block followed by deltas:

- `signature_delta` — always present. Carries the encrypted signature that lets Claude continue reasoning across turns. No human-readable content.
- `thinking_delta` — only emitted when `display: "summarized"` is honoured and the model has reasoning to surface. ClaudeUI accumulates these into the session's `streamingThinking` and renders them in the `ThinkingBlock` component.

On Opus 4.7 specifically, **summarised is the only way to receive any reasoning text**. The full chain-of-thought is no longer exposed to API consumers — only the encrypted signature comes through if `display` is `omitted`. This is a silent change from Opus 4.6.

## Adding a new model

When a new Claude model lands, update both this doc and `src/shared/model-capabilities.ts`:

1. Decide which families the new model belongs to (opus / sonnet / haiku) and its rough generation.
2. If it supports adaptive thinking, add it to the substring check in `supportsAdaptiveThinking()` (and `supportsEffort()`, which mirrors the same set).
3. If it has a new top effort tier (the next thing after `xhigh` / `max`), extend `EFFORT_LEVELS`, add a `supportsXxxEffort()` predicate, and update `supportedEffortLevels()`.
4. If it should be excluded from `max`, add its normalised id to the `NO_MAX_EFFORT` set.
5. Update `defaultEffort()` if the model has a non-`high` default.
6. Update the capability matrix table above and bump the SDK version note.
7. Add a row to `src/shared/__tests__/model-capabilities.test.ts` covering the new model's supported levels.

---

## Appendix — re-deriving the matrix from cli.js

The capability rules are mirrored from logic inside the bundled SDK (`node_modules/@anthropic-ai/claude-agent-sdk/cli.js`). Function names there are minified and change between SDK versions, so this section gives **string-literal anchors** that survive minification.

Use the `bundle-analyzer` skill to navigate (`/bundle-analyzer`). For each rule:

| Rule                         | Find via search for                                                                                                        | What you'll see                                                                                                                                                               |
| ---------------------------- | -------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Adaptive support set         | `"adaptive_thinking"` (settings key) — anchor function uses `"opus-4-7"` / `"opus-4-6"` / `"sonnet-4-6"` substring checks. | A short helper that returns true if any of those substrings is in the normalised model id.                                                                                    |
| Effort support set           | `"effort"` (settings key, same shape as above) or `"CLAUDE_CODE_ALWAYS_ENABLE_EFFORT"`.                                    | Mirrors the adaptive set today. Re-check on every SDK bump in case they diverge.                                                                                              |
| xhigh predicate              | `"xhigh_effort"` (settings key). The function returns true only when the model id contains `"opus-4-7"`.                   | Confirm whether new models join the xhigh tier.                                                                                                                               |
| max predicate                | `"max_effort"` (settings key) and the literal `"haiku"` substring check.                                                   | A second check builds a `Set` of legacy model ids — search for `"claude-3-opus"` or `"claude-opus-4-5"` to find the set initialiser; copy the full list into `NO_MAX_EFFORT`. |
| Default effort               | Search for the literal `"xhigh"` near a function returning `"high"` / `"medium"`.                                          | Branches on `"opus-4-7"` substring (returns `"xhigh"`), then `"opus-4-6"`. Update `defaultEffort()` if branches change.                                                       |
| Default budget for `enabled` | Search for the literal `upperLimit` or numeric tables `64000` / `128000`.                                                  | Per-model upper limits. The default budget the SDK fills in when `budgetTokens` is omitted is `upperLimit - 1`.                                                               |
| Thinking display gating      | Search for the CLI flag literal `"--thinking-display <display>"` (declared once in commander setup).                       | The choices array `["summarized","omitted"]` and the line that conditionally sets `MY.display = H.thinkingDisplay`.                                                           |
| Streaming delta types        | Search for the literal `"thinking_delta"`.                                                                                 | The async generator that mutates `p8.thinking += o8.thinking`. Confirms that summarised reasoning still arrives via the same delta type.                                      |

### Verification recipe when bumping the SDK

```bash
# 1. Confirm the adaptive set hasn't changed.
bundle-analyzer find node_modules/@anthropic-ai/claude-agent-sdk/cli.js '"adaptive_thinking"'
# Open the enclosing function and read which model substrings it checks.

# 2. Confirm xhigh is still opus-4-7-only.
bundle-analyzer find node_modules/@anthropic-ai/claude-agent-sdk/cli.js '"xhigh_effort"'

# 3. Confirm the no-max legacy set.
bundle-analyzer find node_modules/@anthropic-ai/claude-agent-sdk/cli.js '"claude-opus-4-5"'
# The Set initialiser containing this string is the legacy list.

# 4. Confirm the public SDK API hasn't changed.
grep -n 'ThinkingAdaptive\|EffortLevel' node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts
```

If any of these change, update the matrix in this doc, the predicates in `model-capabilities.ts`, and the tests in `model-capabilities.test.ts` together — the three files are designed to drift in lockstep.
