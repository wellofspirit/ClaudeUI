// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { createHolderSources, type LiveHolderDeps } from '../live-holder-sources'
import { collectHolders, holdersOf } from '../worktree-holders'
import type { DispatchTargetRow } from '../dispatch-target-ledger'

const WT = '/repo/.claude/worktrees/a'

function row(over: Partial<DispatchTargetRow>): DispatchTargetRow {
  return {
    id: 's-aaaaaa',
    engine: 'pi',
    harnessRef: 'h',
    parentSessionId: 'p',
    parentEngine: 'claude',
    parentToolUseId: null,
    cwd: WT,
    parentCwd: '/repo',
    model: 'm',
    launchMode: 'default',
    accountKey: null,
    callerRestriction: null,
    name: null,
    description: null,
    handBack: false,
    state: 'idle',
    createdAt: 0,
    lastActiveAt: 0,
    ...over
  }
}

function deps(over: Partial<LiveHolderDeps> = {}): LiveHolderDeps {
  return {
    liveSessions: () => [],
    canonical: () => ({ sessions: {}, directories: [], worktreeInfoMap: {}, customTitles: {} }),
    liveTargets: () => [],
    ledgerRows: () => [],
    terminals: () => [],
    ...over
  }
}

const liveSession = (routingId: string, cwd: string, sessionId: string | null = null) =>
  ({ routingId, engineId: 'claude', cwd, getSessionId: () => sessionId }) as never

describe('createHolderSources', () => {
  it('a live session holds every directory it may work in: spawn cwd, canonical status.cwd and the recorded worktree', () => {
    const sources = createHolderSources(
      deps({
        liveSessions: () => [liveSession('r1', '/repo')],
        canonical: () =>
          ({
            sessions: { r1: { cwd: '/repo', status: { cwd: '/elsewhere' } } },
            directories: [],
            worktreeInfoMap: { r1: { worktreePath: WT } },
            customTitles: { r1: 'My title' }
          }) as never
      })
    )

    const [s] = sources.sessions()

    expect(s).toMatchObject({ id: 'r1', live: true, title: 'My title', engine: 'claude' })
    expect(s.cwds).toEqual(expect.arrayContaining(['/repo', '/elsewhere', WT]))
    // ...and that is what makes it a live holder of the worktree even though its spawn cwd is the repo.
    const held = holdersOf(WT, collectHolders(sources))
    expect(held).toEqual([expect.objectContaining({ kind: 'session', id: 'r1', live: true })])
  })

  it('cold sessions (sidebar listing, canonical without an engine) are holders with live:false and no duplicates of live ones', () => {
    const sources = createHolderSources(
      deps({
        liveSessions: () => [liveSession('r1', '/repo', 'uuid-1')],
        canonical: () =>
          ({
            sessions: { gone: { cwd: WT, status: { cwd: null }, selectedEngineId: 'pi' } },
            directories: [
              {
                cwd: WT,
                projectKey: 'k',
                folderName: 'a',
                sessions: [
                  // The live session's listing row (keyed by its session id): not a second holder.
                  { sessionId: 'uuid-1', cwd: WT, title: 'live listed', engineId: 'claude' },
                  { sessionId: 'cold-1', cwd: WT, title: 'Old chat', engineId: 'opencode' }
                ]
              }
            ],
            worktreeInfoMap: {},
            customTitles: {}
          }) as never
      })
    )

    const all = sources.sessions()

    expect(all.map((s) => s.id).sort()).toEqual(['cold-1', 'gone', 'r1'])
    expect(all.find((s) => s.id === 'cold-1')).toMatchObject({
      live: false,
      title: 'Old chat',
      engine: 'opencode'
    })
    expect(all.find((s) => s.id === 'gone')).toMatchObject({ live: false, engine: 'pi' })
    expect(holdersOf(WT, collectHolders(sources)).filter((h) => h.live)).toEqual([])
  })

  it('a manager session whose engine has exited is a cold holder (live:false), once; absent isEngineLive means live (B1)', () => {
    const withEngine = (routingId: string, engineLive: boolean | undefined) =>
      ({
        routingId,
        engineId: 'claude',
        cwd: WT,
        getSessionId: () => 'uuid-' + routingId,
        ...(engineLive === undefined ? {} : { isEngineLive: () => engineLive })
      }) as never
    const sources = createHolderSources(
      deps({
        liveSessions: () => [
          withEngine('up', true),
          withEngine('closed', false),
          withEngine('plain', undefined)
        ],
        canonical: () =>
          ({
            sessions: {},
            // The closed session's own listing row must not make a second holder.
            directories: [
              {
                cwd: WT,
                projectKey: 'k',
                folderName: 'a',
                sessions: [{ sessionId: 'uuid-closed', cwd: WT, title: 't', engineId: 'claude' }]
              }
            ],
            worktreeInfoMap: {},
            customTitles: {}
          }) as never
      })
    )

    const all = sources.sessions()

    expect(all.map((s) => [s.id, s.live])).toEqual([
      ['up', true],
      ['closed', false],
      ['plain', true]
    ])
    const live = holdersOf(WT, collectHolders(sources)).filter((h) => h.live)
    expect(live.map((h) => h.id).sort()).toEqual(['plain', 'up'])
  })

  it('X-Agents: dispatcher targets are live; ledger rows that are neither live nor stopped are parked (live:false)', () => {
    const sources = createHolderSources(
      deps({
        liveTargets: () => [{ ledgerId: 's-live00', engine: 'pi', cwd: WT }],
        ledgerRows: () => [
          row({ id: 's-live00', name: 'Reviewer', state: 'running' }),
          row({ id: 's-park00', description: 'parked one', state: 'idle' }),
          row({ id: 's-stop00', state: 'stopped' })
        ]
      })
    )

    const agents = sources.xAgents()

    expect(agents).toEqual([
      expect.objectContaining({ id: 's-live00', live: true, label: 'X-Agent Reviewer', cwd: WT }),
      expect.objectContaining({ id: 's-park00', live: false, label: 'X-Agent parked one' })
    ])
  })

  it('terminals pass through', () => {
    const t = [{ id: 't1', cwd: WT }]
    expect(createHolderSources(deps({ terminals: () => t })).terminals()).toEqual(t)
  })
})
