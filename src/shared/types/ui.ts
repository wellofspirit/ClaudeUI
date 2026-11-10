import type { EngineId, ModelRef } from './engine'
import type { WorktreeInfo } from './worktree'

// ---------------------------------------------------------------------------
// UI session config
// ---------------------------------------------------------------------------

export interface UISessionConfig {
  recentSessions?: string[]
  pinnedSessions?: string[]
  customTitles?: Record<string, string>
  worktreeInfoMap?: Record<string, WorktreeInfo>
  /** Session IDs the user has chosen to hide from the sidebar */
  hiddenSessions?: string[]
  /** Project keys the user has chosen to hide from the sidebar */
  hiddenProjects?: string[]
  /**
   * Engine + model per session. Maps sessionId → { engineId, model? }.
   * Absent keys are treated as claude. The entry is written at session-creation
   * time, updated whenever the user switches model, and carried over on rekey.
   * On reopen, the optional `model` field seeds `selectedModel` so the last
   * model choice is restored (Phase 1 behavior addition).
   */
  sessionEngines?: Record<string, { engineId: EngineId; model?: ModelRef }>
}

export interface SlashCommandInfo {
  name: string
  description?: string
}

// ---------------------------------------------------------------------------
// View switching
// ---------------------------------------------------------------------------

export type ActiveView =
  | { type: 'chat' }
  | { type: 'usage' }
  | { type: 'automations' }
  | { type: 'plugin'; pluginId: string }
