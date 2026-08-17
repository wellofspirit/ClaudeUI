/**
 * Context-window resolution for a model value, mirroring cli.js's own logic.
 *
 * cli.js resolves the window in `DR(model, betas)` (cli.js@char3227080,
 * verified against 2.1.114) — full write-up in docs/protocol/13-context-window.md:
 *
 *   1. `/\[1m\]/i` in the model name            → 1M
 *   2. betas include "context-1m-2025-08-07"    → 1M (eligible models only)
 *   3. implicit-1M model (UE(), cli.js@char3226523):
 *      claude-fable-5 | claude-mythos-5 |
 *      claude-opus-4-7 | claude-opus-4-8        → 1M
 *   4. otherwise                                → 200K
 *
 * Steps 1, 3, and 4 are replicated in `resolveContextWindow`
 * (src/shared/model-capabilities.ts) so the renderer can share the exact same
 * logic. This module adds the main-process-only `CLAUDE_CODE_DISABLE_1M_CONTEXT`
 * env override on top. Known divergences, accepted as such:
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

import { resolveContextWindow, CONTEXT_WINDOW_DEFAULT } from '../../shared/model-capabilities'

/** cli.js boolean-env semantics (`__()`, cli.js@char27057). */
function envFlag(value: string | undefined): boolean {
  if (!value) return false
  return ['1', 'true', 'yes', 'on'].includes(value.toLowerCase().trim())
}

/** Returns the context window size in tokens for a model value (alias or full id). */
export function getContextWindowSize(modelValue: string): number {
  if (envFlag(process.env.CLAUDE_CODE_DISABLE_1M_CONTEXT)) return CONTEXT_WINDOW_DEFAULT
  return resolveContextWindow(modelValue)
}
