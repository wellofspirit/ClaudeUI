/**
 * Merge the per-engine session listings into ONE sidebar directory tree.
 *
 * Pure, dependency-free, and shared: it lives here rather than in the Sidebar
 * because the MAIN process owns the merge now (`services/sync-seed.ts`). It used
 * to run in every client, over three separate queries, and write the result into
 * the client's own `directories` — which made canonical's copy a strict SUBSET
 * (Claude only) that every `sync-full` force-projected over the merged list, so a
 * reconnecting client's opencode/pi rows vanished until its next 30 s poll. One
 * merge, main-side, on the canonical listing, closes that by construction.
 *
 * Both functions are REPLACE-not-accumulate: each drops the entries of its own
 * engine before inserting the fresh ones, so re-running on every refresh cannot
 * pile up stale rows.
 */

import type { DirectoryGroup, SessionInfo } from './types'

/**
 * Merge opencode SessionInfo[] into an existing DirectoryGroup[] (Claude sessions).
 * opencode sessions are grouped by cwd: if a group for that cwd already exists
 * (from Claude), the opencode sessions are appended (avoiding duplicates by sessionId).
 * If no group exists for that cwd, a new group is created.
 *
 * Called on each poll; produces a new array without mutating the input.
 */
export function mergeOpencodeIntoDirectories(
  current: DirectoryGroup[],
  opencodeInfos: SessionInfo[]
): DirectoryGroup[] {
  // Build a mutable copy indexed by cwd (forward-slash normalized for comparison).
  const byProjectKey = new Map<string, DirectoryGroup>()
  const order: string[] = []
  for (const g of current) {
    byProjectKey.set(g.projectKey, { ...g, sessions: [...g.sessions] })
    order.push(g.projectKey)
  }

  // Remove all existing opencode sessions first (so we replace on every poll
  // rather than accumulating stale entries). They're identified by engineId.
  for (const [key, group] of byProjectKey) {
    const filtered = group.sessions.filter((s) => s.engineId !== 'opencode')
    byProjectKey.set(key, { ...group, sessions: filtered })
  }

  // Insert opencode sessions grouped by cwd
  for (const info of opencodeInfos) {
    const projectKey = info.projectKey
    let group = byProjectKey.get(projectKey)
    if (!group) {
      const folderName = info.cwd.split(/[\\/]/).pop() || info.cwd
      group = { cwd: info.cwd, projectKey, folderName, sessions: [] }
      byProjectKey.set(projectKey, group)
      order.push(projectKey)
    }
    group.sessions.push(info)
  }

  // Re-sort each group's sessions newest-first
  for (const group of byProjectKey.values()) {
    group.sessions.sort((a, b) => b.lastActivityAt - a.lastActivityAt)
  }

  // Re-assemble in original order, skip groups that ended up empty
  const result: DirectoryGroup[] = []
  const seen = new Set<string>()
  for (const key of order) {
    if (seen.has(key)) continue
    seen.add(key)
    const group = byProjectKey.get(key)
    if (group && group.sessions.length > 0) result.push(group)
  }

  // Sort groups by most recent activity (mirror listDirectories sort)
  result.sort((a, b) => {
    const aMax = a.sessions[0]?.lastActivityAt ?? 0
    const bMax = b.sessions[0]?.lastActivityAt ?? 0
    return bMax - aMax
  })

  return result
}

/**
 * Merge pi SessionInfo[] into an existing DirectoryGroup[]. Structurally
 * identical to mergeOpencodeIntoDirectories (own function rather than a
 * parameterized shared helper, so opencode's behavior stays byte-for-byte
 * unchanged — see the M1 kickoff spec's "additive edits only" constraint) —
 * filters out stale 'pi' entries first (replace-not-accumulate on every poll),
 * then groups the fresh ones by projectKey, creating a new group when no
 * Claude/opencode group already covers that cwd.
 */
export function mergePiIntoDirectories(
  current: DirectoryGroup[],
  piInfos: SessionInfo[]
): DirectoryGroup[] {
  const byProjectKey = new Map<string, DirectoryGroup>()
  const order: string[] = []
  for (const g of current) {
    byProjectKey.set(g.projectKey, { ...g, sessions: [...g.sessions] })
    order.push(g.projectKey)
  }

  for (const [key, group] of byProjectKey) {
    const filtered = group.sessions.filter((s) => s.engineId !== 'pi')
    byProjectKey.set(key, { ...group, sessions: filtered })
  }

  for (const info of piInfos) {
    const projectKey = info.projectKey
    let group = byProjectKey.get(projectKey)
    if (!group) {
      const folderName = info.cwd.split(/[\\/]/).pop() || info.cwd
      group = { cwd: info.cwd, projectKey, folderName, sessions: [] }
      byProjectKey.set(projectKey, group)
      order.push(projectKey)
    }
    group.sessions.push(info)
  }

  for (const group of byProjectKey.values()) {
    group.sessions.sort((a, b) => b.lastActivityAt - a.lastActivityAt)
  }

  const result: DirectoryGroup[] = []
  const seen = new Set<string>()
  for (const key of order) {
    if (seen.has(key)) continue
    seen.add(key)
    const group = byProjectKey.get(key)
    if (group && group.sessions.length > 0) result.push(group)
  }

  result.sort((a, b) => {
    const aMax = a.sessions[0]?.lastActivityAt ?? 0
    const bMax = b.sessions[0]?.lastActivityAt ?? 0
    return bMax - aMax
  })

  return result
}
