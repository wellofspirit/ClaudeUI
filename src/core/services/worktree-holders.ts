/**
 * Who is using a worktree directory — the input to "refuse removal while it is live".
 *
 * Decided by PATH CONTAINMENT against the working directories of everything that could be
 * running there, never through `worktreeInfoMap` alone (that map misses worktrees ClaudeUI did
 * not create or detect). The sources are injected: the IPC layer passes the real session
 * manager, dispatcher, pty manager and canonical state, the unit tests pass literals.
 */

import type { EngineId, WorktreeHolder } from '../../shared/types'
import { pathEqualOrInside, realOrResolved } from './worktree-root'

export interface SessionHolderSource {
  id: string
  engine: EngineId
  /** The session's title when it has one. */
  title?: string
  /** A running engine process. false = a cold session (history only): a warning, not a refusal. */
  live: boolean
  /** Every directory the session may work in: its spawn cwd, canonical `status.cwd`, its recorded worktree. */
  cwds: string[]
}

export interface XAgentHolderSource {
  id: string
  engine: EngineId
  label: string
  cwd: string
  /** A live target. false = parked (neither stopped nor live). */
  live: boolean
}

export interface TerminalHolderSource {
  id: string
  /** The pty's spawn cwd. */
  cwd: string
}

export interface HolderSources {
  sessions(): SessionHolderSource[]
  /** Live targets and the ledger rows that are neither stopped nor live. */
  xAgents(): XAgentHolderSource[]
  /** Live ptys. */
  terminals(): TerminalHolderSource[]
}

/** One working directory with the thing that works there. */
export interface HolderCwd extends WorktreeHolder {
  cwd: string
}

export function collectHolders(sources: HolderSources): HolderCwd[] {
  const out: HolderCwd[] = []
  for (const s of sources.sessions()) {
    const label = s.title?.trim() || `${s.engine} ${s.id.slice(0, 8)}`
    for (const cwd of s.cwds) {
      if (cwd) out.push({ kind: 'session', id: s.id, label, live: s.live, engine: s.engine, cwd })
    }
  }
  for (const a of sources.xAgents()) {
    if (a.cwd) {
      out.push({
        kind: 'x-agent',
        id: a.id,
        label: a.label,
        live: a.live,
        engine: a.engine,
        cwd: a.cwd
      })
    }
  }
  for (const t of sources.terminals()) {
    if (t.cwd) out.push({ kind: 'terminal', id: t.id, label: 'terminal', live: true, cwd: t.cwd })
  }
  return out
}

/**
 * A matcher over one snapshot of holders: each holder directory is resolved to its canonical
 * spelling at most once however many worktrees are asked about (`realpath.native` is a sync call
 * on the main thread; entries x holders of them add up). `real` is injectable for tests.
 */
export function createHolderMatcher(
  holders: readonly HolderCwd[],
  real: (p: string) => string = realOrResolved
): (worktreePath: string) => WorktreeHolder[] {
  const realCache = new Map<string, string>()
  const realOf = (cwd: string): string => {
    let r = realCache.get(cwd)
    if (r === undefined) {
      r = real(cwd)
      realCache.set(cwd, r)
    }
    return r
  }
  return (worktreePath) => {
    const realRoot = real(worktreePath)
    const byKey = new Map<string, WorktreeHolder>()
    for (const h of holders) {
      if (!pathEqualOrInside(worktreePath, h.cwd) && !pathEqualOrInside(realRoot, realOf(h.cwd)))
        continue
      const key = `${h.kind}\u0000${h.id}`
      const prior = byKey.get(key)
      if (prior) prior.live = prior.live || h.live
      else
        byKey.set(key, { kind: h.kind, id: h.id, label: h.label, live: h.live, engine: h.engine })
    }
    return [...byKey.values()]
  }
}

/**
 * The holders that sit at or inside `worktreePath`, one per (kind, id) — live when any of its
 * directories is held live. A directory counts when the lexical spelling OR the canonical one
 * (`realpath.native`, both sides) is at or inside: a junction into the worktree, an 8.3 name or
 * a differently cased drive letter must not hide a live session.
 */
export function holdersOf(worktreePath: string, holders: readonly HolderCwd[]): WorktreeHolder[] {
  return createHolderMatcher(holders)(worktreePath)
}
