/**
 * Context-window resolution for a model value, mirroring cli.js's own logic.
 *
 * cli.js resolves the window in `DR(model, betas)` (cli.js@char3227080,
 * verified against 2.1.114) — full write-up in docs/protocol-cc/13-context-window.md:
 *
 *   1. `/\[1m\]/i` in the model name            → 1M
 *   2. betas include "context-1m-2025-08-07"    → 1M (eligible models only)
 *   3. implicit-1M model (UE(), cli.js@char3226523):
 *      claude-fable-5 | claude-mythos-5 |
 *      claude-opus-4-7 | claude-opus-4-8        → 1M
 *   4. a model cli.js recognises               → its catalog window (200K)
 *   5. a model it does not recognise            → 1M (200K before 2.1.323)
 *
 * Steps 1 and 3–5 are replicated in `resolveContextWindow`
 * (src/shared/model-capabilities.ts) so the renderer can share the exact same
 * logic. This module adds the main-process-only env overrides on top:
 * `CLAUDE_CODE_MAX_CONTEXT_TOKENS` for an unrecognised model and
 * `CLAUDE_CODE_DISABLE_1M_CONTEXT`. Known divergences, accepted as such:
 *   - Step 2 (explicit beta header) isn't replicated — ClaudeUI never sends
 *     custom beta headers, so the branch is unreachable for us.
 *   - Step 3 in cli.js is additionally gated on provider (first-party API,
 *     Bedrock, or mantle — not Vertex/Foundry). We don't track the provider
 *     here and assume eligible; a custom-endpoint user may see 1M displayed
 *     where cli.js would compact at 200K.
 *
 * Model values reach us in two shapes and both must resolve:
 *   - picker aliases from `supportedModels` ("fable", "opus", "sonnet[1m]")
 *   - full API ids from JSONL transcripts ("claude-fable-5",
 *     "claude-opus-4-8-20251201", Bedrock arns containing the base id)
 */

import {
  resolveContextWindow,
  isUnrecognisedModel,
  CONTEXT_WINDOW_DEFAULT
} from '../../shared/model-capabilities'

/**
 * cli.js boolean-env semantics (`__()`, cli.js@char27057). Exported so every
 * CLAUDE_CODE_* gate in the app reads a variable the way cli.js does — notably
 * that `0` and `false` are OFF rather than merely "set".
 */
export function envFlag(value: string | undefined): boolean {
  if (!value) return false
  return ['1', 'true', 'yes', 'on'].includes(value.toLowerCase().trim())
}

/**
 * Returns the context window size in tokens for a model value (alias or full id). Order as in
 * cli.js 2.1.326 (`rR`): a model it does not recognise takes `CLAUDE_CODE_MAX_CONTEXT_TOKENS`
 * when that is a positive number (since 2.1.325, whatever the id looks like), before
 * `CLAUDE_CODE_DISABLE_1M_CONTEXT` caps everything else at 200K.
 */
export function getContextWindowSize(modelValue: string): number {
  if (isUnrecognisedModel(modelValue)) {
    const max = Number.parseInt(process.env.CLAUDE_CODE_MAX_CONTEXT_TOKENS ?? '', 10)
    if (Number.isFinite(max) && max > 0) return max
  }
  if (envFlag(process.env.CLAUDE_CODE_DISABLE_1M_CONTEXT)) return CONTEXT_WINDOW_DEFAULT
  return resolveContextWindow(modelValue)
}
