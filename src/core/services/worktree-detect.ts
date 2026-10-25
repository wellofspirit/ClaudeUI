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

import * as fs from 'fs'
import * as path from 'path'
import type { WorktreeInfo } from '../../shared/types'
import { loadSessionConfig, saveSessionConfig } from './ui-config'
import { logger } from './logger'
import { isCreatedWorktree } from '../../shared/linked-worktree'
import {
  linkedWorktreeOfUncached,
  normaliseWorktreePath,
  resolveRepoRoot,
  samePath
} from './worktree-root'

const LOG = 'worktree-detect'

/**
 * Built-in tool names whose result text is trusted to declare an entered
 * worktree. Gating on an EXACT name (not a `/worktree/i` substring over every
 * tool) closes the injection funnel behind audit C2: a third-party MCP tool
 * named e.g. `mcp__evil__worktree_helper` can no longer plant a `worktreePath`
 * that later flows into `worktree:remove`. `EnterWorktree` is the only cli.js
 * built-in that emits "<Created|Entered|Reused|Resumed> worktree at “<path>” …".
 */
export const WORKTREE_ENTER_TOOL_NAMES = new Set(['EnterWorktree'])

/** The matching built-in that leaves the worktree again (result: "Exited worktree…"). */
export const WORKTREE_EXIT_TOOL_NAMES = new Set(['ExitWorktree'])

// Groups: 1-3 path (curly, straight, bare); 4 path flagged inexact; 5-7 branch (same three
// spellings); 8 branch flagged inexact. The lookahead ends a bare name at the sentence's full stop.
const NATURAL_RESULT =
  /worktree at\s+(?:\u201C([^\u201D]*)\u201D|"([^"]*)"|(\S.*?))(\s\(not its exact spelling\))?(?:\s+on branch\s+(?:\u201C([^\u201D]*)\u201D|"([^"]*)"|([^\s"\u201C]+?))(\s\(not its exact spelling\))?)?(?=\.(?:\s|$)|$)/

/** What the text of an `EnterWorktree` result declares. */
export interface EnteredWorktreeText {
  worktreePath: string
  /** '' when the text names none (a detached worktree) or the spelling was inexact. */
  worktreeBranch: string
  /** False when cli.js flagged the path as "not its exact spelling": never use it as a path. */
  pathExact: boolean
}

/**
 * Parse an `EnterWorktree` tool result. Returns null when the text declares no path.
 *
 * cli.js 2.1.308: `<Created|Entered|Reused|Resumed> worktree at “<path>”[ on branch “<branch>”].`
 * followed by sentences of its own (Reused/Resumed add one after the branch). The quotes are
 * curly (`EU()`), and either name may carry ` (not its exact spelling)`. Straight quotes and no
 * quotes (the pre-2.1.306 shape) stay accepted, as do the `worktreePath:` line and JSON field
 * shapes. The branch is optional: a detached worktree has none.
 */
export function detectEnteredWorktree(result: string): EnteredWorktreeText | null {
  const m = result.match(NATURAL_RESULT)
  if (m) {
    const worktreePath = (m[1] ?? m[2] ?? m[3] ?? '').trim()
    if (worktreePath) {
      const branch = (m[5] ?? m[6] ?? m[7] ?? '').trim()
      return {
        worktreePath,
        worktreeBranch: m[8] === undefined ? branch : '',
        pathExact: m[4] === undefined
      }
    }
  }
  // Also try structured formats: worktreePath: <path> or JSON "worktreePath": "<path>"
  const pathMatch =
    result.match(/worktreePath:\s*(.+?)(?:\n|$)/i)?.[1] ||
    result.match(/"worktreePath"\s*:\s*"([^"]+)"/i)?.[1]
  if (!pathMatch) return null
  const branchMatch =
    result.match(/worktreeBranch:\s*(.+?)(?:\n|$)/i)?.[1] ||
    result.match(/"worktreeBranch"\s*:\s*"([^"]+)"/i)?.[1]
  return {
    worktreePath: pathMatch.trim(),
    worktreeBranch: branchMatch?.trim() ?? '',
    pathExact: true
  }
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
 * Idempotent for the SAME worktree: an entry already recorded for this path is left alone, which
 * is what makes a replay of the same tool result harmless. A DIFFERENT path overwrites (the model
 * switched worktrees, e.g. `EnterWorktree` with `path`), keeping the first `originalCwd`. A
 * DETECTED write never replaces a `created` entry (the one ClaudeUI made and may offer to remove).
 * Returns false only for that refusal.
 */
export function recordWorktreeEntry(
  routingId: string,
  info: WorktreeInfo,
  emit: (channel: string, args: unknown[]) => void
): boolean {
  const config = loadSessionConfig()
  const worktreeInfoMap = { ...(config.worktreeInfoMap ?? {}) }
  const prior = worktreeInfoMap[routingId]
  if (prior) {
    if (info.origin === 'detected' && isCreatedWorktree(prior)) return false
    if (normaliseWorktreePath(prior.worktreePath) === normaliseWorktreePath(info.worktreePath))
      return true
    info = { ...info, originalCwd: prior.originalCwd }
  }
  worktreeInfoMap[routingId] = info
  const next = { ...config, worktreeInfoMap }
  saveSessionConfig(next)
  emit('config:sessions-changed', [next])
  return true
}

/**
 * Drop one session's recorded worktree entry (a successful `ExitWorktree`, an opencode
 * `session.moved` back out). Saves and emits once, and only when there was an entry. Returns
 * whether one was dropped. A `created` entry is never dropped here: detection forgets what it
 * detected, and only the removal path ({@link forgetWorktreeEntries}) retires what ClaudeUI made.
 */
export function forgetSessionWorktree(
  routingId: string,
  emit: (channel: string, args: unknown[]) => void
): boolean {
  const config = loadSessionConfig()
  const prior = config.worktreeInfoMap?.[routingId]
  if (!prior || isCreatedWorktree(prior)) return false
  const worktreeInfoMap = { ...config.worktreeInfoMap }
  delete worktreeInfoMap[routingId]
  const next = { ...config, worktreeInfoMap }
  saveSessionConfig(next)
  emit('config:sessions-changed', [next])
  return true
}

/** A worktree resolved from engine output and cleared for recording. */
export interface DetectedWorktree {
  worktreePath: string
  worktreeBranch: string
  worktreeName: string
  gitRoot: string
}

/** Why a detected worktree was not recorded (debug-logged once per miss). */
type DetectionMiss = string

function isDirectory(p: string): boolean {
  try {
    return fs.statSync(p).isDirectory()
  } catch {
    return false
  }
}

/**
 * Clear a destination an engine says the session is working in for recording (C-B4).
 * `worktreeInfoMap` is a permission input (`session-tools.ts` allowedRoots), so a detected write
 * must name a LINKED worktree of the SAME repository as the session's spawn cwd: anything else —
 * a directory outside any repo, a submodule, another repo's worktree, a path the model made up —
 * is skipped. `branch` is the engine's own statement when it gave one, else the worktree's HEAD.
 */
export function vetDetectedWorktree(
  dest: string,
  spawnCwd: string,
  branch = ''
): DetectedWorktree | DetectionMiss {
  if (!dest || !isDirectory(dest)) return `${dest || '(empty)'} is not an existing directory`
  const linked = linkedWorktreeOfUncached(dest)
  if (!linked) return `${dest} is not a linked git worktree`
  const sessionRoot = resolveRepoRoot(spawnCwd)
  if (!sessionRoot) return `the session's cwd ${spawnCwd} is not inside a git repository`
  if (!samePath(linked.repoRoot, sessionRoot))
    return `${linked.worktreePath} belongs to ${linked.repoRoot}, not to the session's repository ${sessionRoot}`
  return {
    worktreePath: linked.worktreePath,
    worktreeBranch: branch || linked.branch,
    worktreeName: linked.name || deriveWorktreeName(linked.worktreePath, branch),
    gitRoot: linked.repoRoot
  }
}

/** The worktree directories an `EnterWorktree` call itself names, strongest first. */
function inputCandidates(
  toolInput: Record<string, unknown> | undefined,
  spawnCwd: string,
  pathBase: string
): string[] {
  const out: string[] = []
  const pathInput = toolInput?.path
  if (typeof pathInput === 'string' && pathInput.trim()) {
    out.push(path.resolve(pathBase, pathInput.trim()))
  }
  const nameInput = toolInput?.name
  const root = resolveRepoRoot(spawnCwd)
  if (typeof nameInput === 'string' && nameInput.trim() && root) {
    out.push(path.join(root, '.claude', 'worktrees', nameInput.trim().replace(/\//g, '+')))
  }
  return out
}

/**
 * Resolve an `EnterWorktree` tool result (plus the call's input) into a worktree to record, or a
 * reason it cannot be. The text's path is used only when it is exact and an existing directory;
 * otherwise the call's own `path` / `name` stand in. Both must then pass {@link vetDetectedWorktree}.
 * A relative `path` is relative to where the session works: `currentWorktree` (the worktree
 * already recorded for it) when there is one, else the spawn cwd.
 */
export function resolveEnteredWorktree(
  result: string,
  toolInput: Record<string, unknown> | undefined,
  spawnCwd: string,
  currentWorktree?: string
): DetectedWorktree | DetectionMiss {
  const text = detectEnteredWorktree(result)
  const candidates: string[] = []
  if (text?.pathExact && isDirectory(text.worktreePath)) candidates.push(text.worktreePath)
  candidates.push(...inputCandidates(toolInput, spawnCwd, currentWorktree || spawnCwd))
  if (candidates.length === 0)
    return text
      ? 'the result names no usable directory and the call gave none'
      : 'no worktree in the result'
  let miss: DetectionMiss = ''
  for (const dest of candidates) {
    const vetted = vetDetectedWorktree(dest, spawnCwd, text?.worktreeBranch)
    if (typeof vetted !== 'string') return vetted
    miss ||= vetted
  }
  return miss
}

/** The `WorktreeInfo` a detected worktree is recorded as (never offered for removal: `origin: 'detected'`). */
export function detectedWorktreeInfo(detected: DetectedWorktree, spawnCwd: string): WorktreeInfo {
  return {
    worktreePath: detected.worktreePath,
    worktreeBranch: detected.worktreeBranch,
    worktreeName: detected.worktreeName,
    originalCwd: spawnCwd,
    gitRoot: detected.gitRoot,
    originalHeadCommit: '',
    createdAt: Date.now(),
    origin: 'detected'
  }
}

/**
 * Record a worktree an engine declared the session is working in (3a text or input fallback, 3d
 * opencode `session.moved`). Returns whether it was recorded; a miss logs once at debug.
 */
export function recordDetectedWorktree(
  routingId: string,
  vetted: DetectedWorktree | DetectionMiss,
  spawnCwd: string,
  emit: (channel: string, args: unknown[]) => void
): boolean {
  if (typeof vetted === 'string') {
    logger.debug(LOG, `no worktree recorded for ${routingId}: ${vetted}`)
    return false
  }
  return recordWorktreeEntry(routingId, detectedWorktreeInfo(vetted, spawnCwd), emit)
}

/**
 * Does a recorded `created` entry (ClaudeUI made this worktree, see {@link isCreatedWorktree})
 * exist for this directory? The server-side half of C-S11: the legacy `worktree:remove` and the
 * quit removal only ever act on worktrees ClaudeUI created, whatever the renderer sends.
 */
export function isCreatedWorktreePath(worktreePath: string): boolean {
  return createdWorktreeInfo(worktreePath) !== undefined
}

/**
 * The repository root recorded for a worktree ClaudeUI created at this directory, if any: where
 * to look for its repo when the folder is already gone and the path leads nowhere.
 */
export function createdWorktreeGitRoot(worktreePath: string): string | undefined {
  return createdWorktreeInfo(worktreePath)?.gitRoot || undefined
}

function createdWorktreeInfo(worktreePath: string): WorktreeInfo | undefined {
  const map = loadSessionConfig().worktreeInfoMap ?? {}
  return Object.values(map).find(
    (info) => isCreatedWorktree(info) && samePath(info.worktreePath, worktreePath)
  )
}

/**
 * Drop every recorded worktree entry whose `worktreePath` is one of `worktreePaths` (compared
 * normalised: separators, trailing slash and, on Windows, case). Called by the SERVER after it
 * removes a worktree, so a stale entry cannot outlive the directory: the renderer saves the
 * whole map and would resurrect anything the server forgot only on the client. Saves and emits
 * `config:sessions-changed` once, and only when something was dropped. Returns the routing ids
 * dropped.
 */
export function forgetWorktreeEntries(
  worktreePaths: string[],
  emit: (channel: string, args: unknown[]) => void
): string[] {
  if (worktreePaths.length === 0) return []
  const gone = new Set(worktreePaths.map((p) => normaliseWorktreePath(p)))
  const config = loadSessionConfig()
  const worktreeInfoMap = { ...(config.worktreeInfoMap ?? {}) }
  const dropped: string[] = []
  for (const [routingId, info] of Object.entries(worktreeInfoMap)) {
    if (gone.has(normaliseWorktreePath(info.worktreePath))) {
      delete worktreeInfoMap[routingId]
      dropped.push(routingId)
    }
  }
  if (dropped.length === 0) return dropped
  const next = { ...config, worktreeInfoMap }
  saveSessionConfig(next)
  emit('config:sessions-changed', [next])
  return dropped
}

/**
 * An opencode session moved to `dest` (`session.moved`, 3d). Into a linked worktree of the
 * session's repository: record it like any detected worktree (the spawn cwd stays the session's
 * `cwd`: permissions, terminal and git pill keep it). Back to the spawn cwd, to a plain directory
 * or anywhere the C-B4 gate refuses: the session is no longer in the worktree it was recorded
 * for, so forget the entry.
 */
export function applySessionMoved(
  routingId: string,
  dest: string,
  spawnCwd: string,
  emit: (channel: string, args: unknown[]) => void
): 'recorded' | 'forgot' | 'unchanged' {
  if (!samePath(dest, spawnCwd)) {
    const vetted = vetDetectedWorktree(dest, spawnCwd)
    if (typeof vetted !== 'string') {
      return recordWorktreeEntry(routingId, detectedWorktreeInfo(vetted, spawnCwd), emit)
        ? 'recorded'
        : 'unchanged'
    }
    logger.debug(LOG, `session.moved of ${routingId} is not a worktree move: ${vetted}`)
  }
  return forgetSessionWorktree(routingId, emit) ? 'forgot' : 'unchanged'
}
