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
 * We replicate 1, 3, and 4. Known divergences, accepted as such:
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

const CONTEXT_WINDOW_1M = 1_000_000
const CONTEXT_WINDOW_DEFAULT = 200_000

/**
 * Base models that get a 1M window without a "[1m]" suffix — cli.js `UE()`.
 * Matched by substring, like cli.js's normalizer `eD()` (cli.js@char2252070),
 * so dated ids and provider-prefixed ids (Bedrock) resolve too.
 */
const IMPLICIT_1M_BASE_MODELS = [
  'claude-fable-5',
  'claude-mythos-5',
  'claude-opus-4-7',
  'claude-opus-4-8'
]

/**
 * Picker aliases that cli.js currently resolves to an implicit-1M base model
 * (`U7()`, cli.js@char2255303): "fable" → claude-fable-5, "opus" →
 * claude-opus-4-8 (claude-opus-4-7 on mantle — also 1M). Aliases track the
 * latest model generation, so re-verify this set on claudeCliVersion bumps
 * (docs/protocol/12-maintenance.md).
 */
const IMPLICIT_1M_ALIASES = new Set(['fable', 'opus'])

/** cli.js boolean-env semantics (`__()`, cli.js@char27057). */
function envFlag(value: string | undefined): boolean {
  if (!value) return false
  return ['1', 'true', 'yes', 'on'].includes(value.toLowerCase().trim())
}

/** Returns the context window size in tokens for a model value (alias or full id). */
export function getContextWindowSize(modelValue: string): number {
  if (envFlag(process.env.CLAUDE_CODE_DISABLE_1M_CONTEXT)) return CONTEXT_WINDOW_DEFAULT
  const value = modelValue.toLowerCase().trim()
  if (value.includes('[1m]')) return CONTEXT_WINDOW_1M
  if (IMPLICIT_1M_BASE_MODELS.some((base) => value.includes(base))) return CONTEXT_WINDOW_1M
  if (IMPLICIT_1M_ALIASES.has(value)) return CONTEXT_WINDOW_1M
  return CONTEXT_WINDOW_DEFAULT
}
