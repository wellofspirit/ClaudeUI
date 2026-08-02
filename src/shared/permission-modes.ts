/**
 * Pure permission-mode cycling logic shared between the renderer's Shift+Tab
 * handler and its tests. No main-process imports — safe to use from either
 * the renderer or a test runner.
 */

import type { AutonomyMode } from './model-capabilities'
import type { EngineId, ModelInfo, PermissionMode } from './types'

export const PERMISSION_MODE_CYCLE = ['default', 'acceptEdits', 'plan', 'auto'] as const

/** Display labels for the mode-pill vocabulary (InputBox View, MobileConfigSheet). */
export const PERMISSION_MODE_LABELS: Record<PermissionMode, string> = {
  default: 'Default',
  acceptEdits: 'Accept Edits',
  plan: 'Plan',
  auto: 'Auto'
}

// ---------------------------------------------------------------------------
// AutonomyMode ↔ PermissionMode
// ---------------------------------------------------------------------------
//
// The Settings dialog speaks AutonomyMode (an outcome-shaped vocabulary shared
// across engines); sessions and `permissions.defaultMode` on disk speak
// PermissionMode. Single source of truth for both directions — the picker, the
// session store's defaultMode hydration, and the mapping test all import these.

export const AUTONOMY_TO_PERMISSION: Record<AutonomyMode, PermissionMode> = {
  plan: 'plan',
  ask: 'default',
  autoEdit: 'acceptEdits',
  full: 'auto'
}

export const PERMISSION_TO_AUTONOMY: Record<string, AutonomyMode> = {
  plan: 'plan',
  default: 'ask',
  acceptEdits: 'autoEdit',
  auto: 'full'
}

export const AUTONOMY_LABELS: Record<AutonomyMode, string> = {
  plan: 'Read-only (Plan)',
  ask: 'Ask (default)',
  autoEdit: 'Auto-edit files',
  full: 'Full auto'
}

/**
 * Coerce a `permissions.defaultMode` string from settings.json into a renderer
 * PermissionMode. Anything ClaudeUI has no session-level equivalent for —
 * absent, `bypassPermissions`, a future upstream mode — reads as 'default',
 * the only mode that is never gated.
 */
export function toPermissionMode(raw: string | undefined | null): PermissionMode {
  return PERMISSION_MODE_CYCLE.includes(raw as (typeof PERMISSION_MODE_CYCLE)[number])
    ? (raw as PermissionMode)
    : 'default'
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
