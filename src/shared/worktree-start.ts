/**
 * "Start new sessions in a worktree": the global default (`startInWorktree`, absent = off) and a
 * per-project override (`worktreeByProject[projectKey]`, absent = use the default). The project
 * key is the sidebar group's (`cwdToProjectKey`).
 */

export type WorktreeProjectChoice = 'always' | 'never'

export interface StartInWorktreeSettings {
  startInWorktree?: boolean
  worktreeByProject?: Record<string, WorktreeProjectChoice>
}

/** Whether a new session in `projectKey` should get its own worktree. */
export function effectiveStartInWorktree(
  settings: StartInWorktreeSettings,
  projectKey: string
): boolean {
  const choice = settings.worktreeByProject?.[projectKey]
  if (choice === 'always') return true
  if (choice === 'never') return false
  return settings.startInWorktree === true
}

/** `worktreeByProject` with `projectKey` set to `choice`, or removed for `null` (use default). Undefined once empty. */
export function withProjectChoice(
  map: Record<string, WorktreeProjectChoice> | undefined,
  projectKey: string,
  choice: WorktreeProjectChoice | null
): Record<string, WorktreeProjectChoice> | undefined {
  const next = { ...map }
  if (choice) next[projectKey] = choice
  else delete next[projectKey]
  return Object.keys(next).length > 0 ? next : undefined
}

/**
 * A session that has not spawned, and whether the first send should make it a worktree. Lives on
 * the session's view state (per client, not persisted); cleared once the worktree exists.
 */
export interface PendingWorktree {
  enabled: boolean
  name: string
  /** The user typed the name (so a collision is theirs to fix); an auto-generated one is re-rolled. */
  nameTouched?: boolean
  /** `creating` while the first send makes it; `failed` holds `error` and the message stays unsent. */
  phase: 'idle' | 'creating' | 'failed'
  error?: string
}

const ADJECTIVES = [
  'swift',
  'calm',
  'bold',
  'keen',
  'warm',
  'cool',
  'wild',
  'soft',
  'fair',
  'deep',
  'pure',
  'dark',
  'safe',
  'firm',
  'vast'
]
const NOUNS = [
  'river',
  'stone',
  'cloud',
  'flame',
  'frost',
  'ridge',
  'creek',
  'grove',
  'bloom',
  'cedar',
  'maple',
  'cliff',
  'brook',
  'trail',
  'haven'
]

export function generateWorktreeName(): string {
  const adj = ADJECTIVES[Math.floor(Math.random() * ADJECTIVES.length)]
  const noun = NOUNS[Math.floor(Math.random() * NOUNS.length)]
  return `${adj}-${noun}`
}

export function sanitizeWorktreeName(val: string): string {
  return val
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, '')
    .slice(0, 30)
}

/** Whether `cwd` is inside a `.claude/worktrees/` directory (a worktree is never made from one). */
export function isManagedWorktreePath(cwd: string): boolean {
  return /[\\/]\.claude[\\/]worktrees[\\/]/.test(cwd)
}
