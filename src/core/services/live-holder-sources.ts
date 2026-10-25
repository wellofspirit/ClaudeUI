/**
 * The real {@link HolderSources} for the worktree manager (ADR-112): who is working in a
 * directory right now, read from the live app.
 *
 *  - sessions: every session the manager holds, with ALL the directories it may work in — its
 *    spawn cwd, canonical `status.cwd` / `cwd`, and the worktree `worktreeInfoMap` says it
 *    entered. Live only while its engine is up (the manager never drops a closed session);
 *    plus every cold session canonical state knows (the sidebar listing and sessions that ended
 *    but kept their row), which only warn.
 *  - X-Agents: the dispatcher's live targets (live) plus ledger rows that are neither stopped
 *    nor live (parked: a warning).
 *  - terminals: the pty manager's live shells.
 *
 * Every source is a getter handed in, so the unit test needs no running app; the IPC
 * declaration (`config-commands.ts`) binds the real ones. Path matching is `worktree-holders.ts`'s business.
 */

import type { ISession } from '../providers/ISession'
import type { CanonicalState } from '../shared/sync/state'
import type { EngineId } from '../../shared/types'
import type { DispatchTargetRow } from './dispatch-target-ledger'
import type {
  HolderSources,
  SessionHolderSource,
  TerminalHolderSource,
  XAgentHolderSource
} from './worktree-holders'

export interface LiveHolderDeps {
  /**
   * Every session the manager still holds (`SessionManager.forEach`). The manager never drops
   * one, so a closed session is in here too: `isEngineLive()` tells which are really running.
   */
  liveSessions(): Array<
    Pick<ISession, 'routingId' | 'engineId' | 'cwd' | 'getSessionId' | 'isEngineLive'>
  >
  canonical(): Pick<CanonicalState, 'sessions' | 'directories' | 'worktreeInfoMap' | 'customTitles'>
  /** The dispatcher's live targets. */
  liveTargets(): Array<{ ledgerId: string; engine: EngineId; cwd: string }>
  /** Ledger rows that were not ended on purpose. */
  ledgerRows(): DispatchTargetRow[]
  terminals(): TerminalHolderSource[]
}

function xAgentLabel(row: DispatchTargetRow | undefined, fallbackId: string): string {
  const named = row?.name?.trim() || row?.description?.trim()
  return `X-Agent ${named ? named : fallbackId}`
}

export function createHolderSources(deps: LiveHolderDeps): HolderSources {
  return {
    sessions(): SessionHolderSource[] {
      const state = deps.canonical()
      const titleOf = (id: string, listed?: string): string | undefined =>
        state.customTitles[id]?.trim() || listed?.trim() || undefined
      const out: SessionHolderSource[] = []
      const seen = new Set<string>()
      const listedSessions = state.directories.flatMap((g) => g.sessions)
      for (const s of deps.liveSessions()) {
        const id = s.routingId
        const held = state.sessions[id]
        const sessionId = s.getSessionId()
        seen.add(id)
        if (sessionId) seen.add(sessionId)
        const listed = listedSessions.find(
          (info) => info.sessionId === id || info.sessionId === sessionId
        )
        out.push({
          id,
          engine: s.engineId,
          title: titleOf(id, listed?.title),
          // A session whose engine has exited is still in the manager: it only warns (absent = live).
          live: s.isEngineLive?.() ?? true,
          cwds: [
            s.cwd,
            held?.status.cwd ?? '',
            held?.cwd ?? '',
            state.worktreeInfoMap[id]?.worktreePath ?? ''
          ].filter(Boolean)
        })
      }
      // Cold: the sidebar listing, then canonical sessions without a live engine.
      for (const group of state.directories) {
        for (const info of group.sessions) {
          if (seen.has(info.sessionId)) continue
          seen.add(info.sessionId)
          out.push({
            id: info.sessionId,
            engine: info.engineId ?? 'claude',
            title: titleOf(info.sessionId, info.title),
            live: false,
            cwds: [
              info.cwd,
              state.sessions[info.sessionId]?.status.cwd ?? '',
              state.worktreeInfoMap[info.sessionId]?.worktreePath ?? ''
            ].filter(Boolean)
          })
        }
      }
      for (const [id, held] of Object.entries(state.sessions)) {
        if (seen.has(id)) continue
        seen.add(id)
        out.push({
          id,
          engine: held.selectedEngineId,
          title: titleOf(id),
          live: false,
          cwds: [
            held.status.cwd ?? '',
            held.cwd,
            state.worktreeInfoMap[id]?.worktreePath ?? ''
          ].filter(Boolean)
        })
      }
      return out
    },

    xAgents(): XAgentHolderSource[] {
      const rows = new Map(deps.ledgerRows().map((r) => [r.id, r]))
      const out: XAgentHolderSource[] = []
      const liveIds = new Set<string>()
      for (const t of deps.liveTargets()) {
        liveIds.add(t.ledgerId)
        out.push({
          id: t.ledgerId,
          engine: t.engine,
          label: xAgentLabel(rows.get(t.ledgerId), t.ledgerId),
          cwd: t.cwd,
          live: true
        })
      }
      for (const row of rows.values()) {
        if (liveIds.has(row.id) || row.state === 'stopped') continue
        out.push({
          id: row.id,
          engine: row.engine,
          label: xAgentLabel(row, row.id),
          cwd: row.cwd,
          live: false
        })
      }
      return out
    },

    terminals: () => deps.terminals()
  }
}
