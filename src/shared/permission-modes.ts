/**
 * Pure permission-mode cycling logic shared between the renderer's Shift+Tab
 * handler and its tests. No main-process imports — safe to use from either
 * the renderer or a test runner.
 */

import type { EngineId, ModelInfo, PermissionMode } from './types'

export const PERMISSION_MODE_CYCLE = ['default', 'acceptEdits', 'plan', 'auto'] as const

/** Display labels for the mode-pill vocabulary (InputBox View, MobileConfigSheet). */
export const PERMISSION_MODE_LABELS: Record<PermissionMode, string> = {
  default: 'Default',
  acceptEdits: 'Accept Edits',
  plan: 'Plan',
  auto: 'Auto'
}

/**
 * Advance one step through PERMISSION_MODE_CYCLE, wrapping around. Modes
 * gated off by `gates` are skipped over (kept advancing) rather than landed
 * on. Bounded by the cycle length so that even with every gate closed the
 * loop always terminates on an allowed mode (worst case: 'default', which is
 * never gated).
 */
export function nextPermissionMode(
  current: PermissionMode,
  gates: { canPlan: boolean; autoAvailable: boolean }
): PermissionMode {
  const cycle = PERMISSION_MODE_CYCLE
  let index = cycle.indexOf(current as (typeof cycle)[number])
  // Unknown/legacy current mode — treat as 'default'.
  if (index === -1) index = cycle.indexOf('default')

  for (let step = 0; step < cycle.length; step++) {
    index = (index + 1) % cycle.length
    const candidate = cycle[index]
    if (candidate === 'plan' && !gates.canPlan) continue
    if (candidate === 'auto' && !gates.autoAvailable) continue
    return candidate
  }
  return 'default'
}

/**
 * Whether Claude's 'auto' permission mode is usable given the currently
 * known model list. Default-available posture: auto mode ships enabled by
 * default on subscription accounts, so this is a NEGATIVE gate only — it
 * returns false only when the launch-time model fetch affirmatively says no
 * Claude model supports it. Empty lists, not-yet-loaded models, and absent
 * flags (older CLIs that don't report `supportsAutoMode`) all read as
 * available. This is fed by the launch-time master-session model fetch
 * (`fetchModels()` in session.ipc.ts); the main-process init-sync broadcast
 * and the live `setPermissionMode('auto')` rejection fallback remain the
 * authoritative safety net if this pre-spawn signal turns out to be wrong.
 */
export function claudeAutoModeAvailable(
  models: Pick<ModelInfo, 'engineId' | 'supportsAutoMode'>[]
): boolean {
  const claudeModels = models.filter((m) => (m.engineId ?? 'claude') === 'claude')
  if (claudeModels.length === 0) return true
  return !claudeModels.every((m) => m.supportsAutoMode === false)
}

/**
 * Whether 'auto' permission mode is usable for the given engine. Non-Claude
 * engines' 'auto' is a local full-autonomy mode with no account gate, so it's
 * always available there; Claude delegates to `claudeAutoModeAvailable`'s
 * model-fetch-derived gate.
 */
export function autoModeAvailableForEngine(
  engineId: EngineId | undefined,
  models: Pick<ModelInfo, 'engineId' | 'supportsAutoMode'>[]
): boolean {
  return (engineId ?? 'claude') === 'claude' ? claudeAutoModeAvailable(models) : true
}
