/**
 * Worktree-entry detection — moved OUT of the renderer by SyncCore phase 4c.
 *
 * `useClaudeEvents` used to parse an `EnterWorktree` tool result and write the
 * result into `worktreeInfoMap`, which is precisely the pattern
 * `docs/architecture/sync-channels.md` §"Client-written state" flagged as the last
 * surviving violation of sync-core.md's client-computation rule: a CLIENT derived
 * state from a tool result and stored it. Two clients watching the same session
 * each did the parse; a client that resynced afterwards saw whatever
 * `sessions.json` happened to hold; and a client that was not connected when the
 * tool ran never learned about the worktree at all.
 *
 * Now the main process parses it once and persists through the ordinary
 * `config:sessions-changed` save path, so every replica learns about it from the
 * same event and a reconnecting client gets it in its snapshot.
 *
 * Deliberately NOT part of the funnel module: `emit` and the config reader are
 * injected, so this file imports neither `sync-host` (which would be circular) nor
 * Electron.
 */

import type { WorktreeInfo } from '../../shared/types'
import { loadSessionConfig, saveSessionConfig } from './ui-config'

/**
 * Built-in tool names whose result text is trusted to declare an entered
 * worktree. Gating on an EXACT name (not a `/worktree/i` substring over every
 * tool) closes the injection funnel behind audit C2: a third-party MCP tool
 * named e.g. `mcp__evil__worktree_helper` can no longer plant a `worktreePath`
 * that later flows into `worktree:remove`. `EnterWorktree` is the only cli.js
 * built-in that emits "Created worktree at: <path> on branch: <branch>".
 */
export const WORKTREE_ENTER_TOOL_NAMES = new Set(['EnterWorktree'])

/**
 * Parse an `EnterWorktree` tool result. Returns null when the text does not
 * declare both a path and a branch.
 *
 * Three accepted shapes, kept verbatim from the renderer parser this replaces:
 * cli.js's natural-language sentence, a `worktreePath:` line, and a JSON field.
 */
export function detectEnteredWorktree(
  result: string
): { worktreePath: string; worktreeBranch: string } | null {
  // SDK result format: "Created worktree at <path> on branch <branch>. ..."
  const naturalMatch = result.match(/worktree at (.+?) on branch ([\w-]+)/)
  // Also try structured formats: worktreePath: <path> or JSON "worktreePath": "<path>"
  const pathMatch =
    naturalMatch?.[1] ||
    result.match(/worktreePath:\s*(.+?)(?:\n|$)/i)?.[1] ||
    result.match(/"worktreePath"\s*:\s*"([^"]+)"/i)?.[1]
  const branchMatch =
    naturalMatch?.[2] ||
    result.match(/worktreeBranch:\s*(.+?)(?:\n|$)/i)?.[1] ||
    result.match(/"worktreeBranch"\s*:\s*"([^"]+)"/i)?.[1]
  if (!pathMatch || !branchMatch) return null
  return { worktreePath: pathMatch.trim(), worktreeBranch: branchMatch.trim() }
}

/**
 * Display name for an entered worktree: the path's last segment, falling back to
 * the branch with its `worktree-` prefix stripped.
 *
 * Splits on BOTH separators — a Windows worktree path (`D:\wt\feature-x`) has no
 * `/`, so a `/`-only split yielded the ENTIRE path as the display name (RN11).
 */
export function deriveWorktreeName(worktreePath: string, worktreeBranch: string): string {
  return worktreePath.split(/[\\/]/).pop() || worktreeBranch.replace(/^worktree-/, '')
}

/**
 * Persist a detected worktree and broadcast it.
 *
 * Uses the ORDINARY save path — read `sessions.json`, merge one key, write it back,
 * emit `config:sessions-changed` — so the write is indistinguishable from a user
 * pinning a session, and every client (including the desktop, since 4c echoes to
 * the saver) applies it through the reducer.
 *
 * Idempotent: an already-recorded routingId is left alone, which is what makes a
 * catchup replay of the same tool result harmless.
 */
export function recordWorktreeEntry(
  routingId: string,
  info: WorktreeInfo,
  emit: (channel: string, args: unknown[]) => void
): void {
  const config = loadSessionConfig()
  const worktreeInfoMap = { ...(config.worktreeInfoMap ?? {}) }
  if (worktreeInfoMap[routingId]) return
  worktreeInfoMap[routingId] = info
  const next = { ...config, worktreeInfoMap }
  saveSessionConfig(next)
  emit('config:sessions-changed', [next])
}
