/**
 * Context pressure (session tools, slice 4, spec §6.6): the user picks thresholds and a
 * mode; when a session's context crosses one, ClaudeUI either asks (a banner above the
 * composer on every client) or acts (tells the session to wrap up and hand off).
 *
 * Pure and import-free of anything but types, so the core watcher, the Settings
 * section and the banner agree on the setting's rules, the percentage and the words.
 */
import type { EngineId } from './types'
import { SESSION_TOOLS_SERVER_NAME } from './session-tools-description'

export type ContextPressureMode = 'off' | 'ask' | 'auto'

export interface ContextPressureSetting {
  mode: ContextPressureMode
  /** Percent of the window, each 10-95, at most {@link MAX_THRESHOLDS}, ascending, no duplicates. */
  thresholds: number[]
}

export const THRESHOLD_MIN = 10
export const THRESHOLD_MAX = 95
export const MAX_THRESHOLDS = 4

export const DEFAULT_CONTEXT_PRESSURE: ContextPressureSetting = { mode: 'off', thresholds: [70] }

const MODES: readonly ContextPressureMode[] = ['off', 'ask', 'auto']

/**
 * The setting as the watcher and the Settings section use it. Anything that is not a
 * valid value falls back to the default for that part (a hand-edited file, an older
 * or hostile client): an unknown mode is `off`, thresholds are whole numbers in range,
 * deduped, sorted, and the lowest four survive (the first to fire matters most). An
 * empty or absent list means the default list, so a mode that is on always has one.
 */
export function normalizeContextPressure(raw: unknown): ContextPressureSetting {
  const value = typeof raw === 'object' && raw !== null ? (raw as Record<string, unknown>) : {}
  const mode = MODES.includes(value.mode as ContextPressureMode)
    ? (value.mode as ContextPressureMode)
    : DEFAULT_CONTEXT_PRESSURE.mode
  const given = Array.isArray(value.thresholds) ? value.thresholds : []
  const clean = [
    ...new Set(
      given
        .filter((t): t is number => typeof t === 'number' && Number.isFinite(t))
        .map((t) => Math.round(t))
        .filter((t) => t >= THRESHOLD_MIN && t <= THRESHOLD_MAX)
    )
  ]
    .sort((a, b) => a - b)
    .slice(0, MAX_THRESHOLDS)
  return { mode, thresholds: clean.length > 0 ? clean : [...DEFAULT_CONTEXT_PRESSURE.thresholds] }
}

/**
 * How full the context is, in percent, or null when it cannot be known: `size 0` is an
 * engine/model with no known window, never a zero-sized one, and never arms.
 */
export function contextPercent(
  window: { used: number; size: number } | null | undefined
): number | null {
  if (!window || !(window.size > 0) || !Number.isFinite(window.used) || window.used < 0) return null
  return Math.min(100, (window.used / window.size) * 100)
}

/** What Claude Code reserves below the window for itself: auto-compact fires at window - 33k (P6). */
export const CLAUDE_AUTOCOMPACT_RESERVE_TOKENS = 33_000

/**
 * The percentage at which the engine compacts by itself, where ClaudeUI knows it. Only
 * Claude's is known (200k window: 83 %; 1M: 97 %); the other engines return null and
 * a threshold is never called unreachable for them.
 */
export function effectiveCeilingPercent(engine: EngineId, windowSize: number): number | null {
  if (engine !== 'claude' || !(windowSize > CLAUDE_AUTOCOMPACT_RESERVE_TOKENS)) return null
  return ((windowSize - CLAUDE_AUTOCOMPACT_RESERVE_TOKENS) / windowSize) * 100
}

/** A threshold the engine's own compaction gets to first: `true` means "never reached". */
export function thresholdAboveCeiling(threshold: number, ceilingPercent: number | null): boolean {
  return ceilingPercent !== null && threshold > ceilingPercent
}

/** One engine/model in use and what is known of where it compacts. */
export interface CeilingRow {
  engine: EngineId
  model: string
  windowSize: number
  /** Percent of the window, or null when unknown for this engine. */
  ceilingPercent: number | null
}

/** The distinct engine/model/window combinations among sessions in use, in first-seen order. */
export function ceilingRows(
  sessions: ReadonlyArray<{ engine: EngineId; model: string; windowSize: number }>
): CeilingRow[] {
  const seen = new Map<string, CeilingRow>()
  for (const s of sessions) {
    if (!(s.windowSize > 0)) continue
    const key = `${s.engine}\u0000${s.model}\u0000${s.windowSize}`
    if (!seen.has(key)) {
      seen.set(key, {
        engine: s.engine,
        model: s.model,
        windowSize: s.windowSize,
        ceilingPercent: effectiveCeilingPercent(s.engine, s.windowSize)
      })
    }
  }
  return [...seen.values()]
}

/**
 * What the banner above the composer shows, replicated per session. `ask` is the
 * mode's question; `failed` means ClaudeUI asked the session to hand off and it did
 * not, and is shown whatever the mode is.
 */
export interface ContextPressureBanner {
  kind: 'ask' | 'failed'
  /** Context used when the threshold was crossed, whole percent. */
  percent: number
}

/**
 * A session in plan mode cannot call `session_hand_off` (acting tools are refused there), so
 * ClaudeUI neither asks it to nor lets the banner's Hand off through until the mode changes.
 */
export const PLAN_MODE_HANDOFF_REASON = 'Switch out of plan mode to hand off.'

export function handOffBlockedReason(permissionMode: string | null | undefined): string | null {
  return permissionMode === 'plan' ? PLAN_MODE_HANDOFF_REASON : null
}

export type ContextPressureAnswer = 'handoff' | 'dismiss'

export function isContextPressureAnswer(value: unknown): value is ContextPressureAnswer {
  return value === 'handoff' || value === 'dismiss'
}

/** A banner payload from the wire, or null for anything that is not one. */
export function parseContextPressureBanner(raw: unknown): ContextPressureBanner | null {
  if (typeof raw !== 'object' || raw === null) return null
  const { kind, percent } = raw as Record<string, unknown>
  if ((kind !== 'ask' && kind !== 'failed') || typeof percent !== 'number') return null
  if (!Number.isFinite(percent)) return null
  return { kind, percent: Math.max(0, Math.min(100, Math.round(percent))) }
}

export function contextPressureBannerText(banner: ContextPressureBanner): string {
  return banner.kind === 'failed'
    ? "ClaudeUI asked this session to hand off but it didn't."
    : `Context is at ${banner.percent} % — continue in a new session?`
}

/** The session_hand_off tool as each engine's model sees it. */
export function handOffToolName(engine: EngineId): string {
  switch (engine) {
    case 'claude':
      return `mcp__${SESSION_TOOLS_SERVER_NAME}__session_hand_off`
    case 'opencode':
      return 'claudeui_session_hand_off'
    default:
      return 'session_hand_off'
  }
}

/** The host-instruction delivered to a session that should hand off (spec §6.6). */
export function handOffInstruction(percent: number, engine: EngineId): string {
  return (
    `Your context is at ${percent} %. Finish or park the current step, then call ` +
    `${handOffToolName(engine)} with a complete handoff (goal, state, decisions, remaining ` +
    `plan, files touched, how to verify). Don't start new work here.`
  )
}
