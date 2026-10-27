// @vitest-environment node
import { describe, expect, it, vi } from 'vitest'
import {
  QUIT_PATHS_MAX,
  createQuitRemovalDeps,
  removeWorktreesAfterTeardown,
  sanitiseQuitPaths,
  type QuitRemovalWiring
} from '../quit-worktree-removal'
import type { WorktreeRemoveResult } from '../../../shared/types'
import type { WorktreeRemoveOptions } from '../../../core/services/worktree'

const result = (
  id: string,
  outcome: WorktreeRemoveResult['outcome'],
  extra: Partial<WorktreeRemoveResult> = {}
): WorktreeRemoveResult => ({ id, outcome, ...extra })

function setup(remove: (p: string) => Promise<WorktreeRemoveResult>) {
  const order: string[] = []
  const debugs: string[] = []
  const warns: string[] = []
  const sleeps: number[] = []
  const deps = {
    stopHolders: vi.fn(() => order.push('stop')),
    remove: vi.fn(async (p: string) => {
      order.push(`remove:${p}`)
      return remove(p)
    }),
    // The real ladder (0.75 / 2 / 5 s) with a clock that only records.
    sleep: async (ms: number) => {
      sleeps.push(ms)
    },
    debug: (m: string) => debugs.push(m),
    warn: (m: string) => warns.push(m)
  }
  return { deps, order, debugs, warns, sleeps }
}

describe('removeWorktreesAfterTeardown (quit-time removal, C-S1)', () => {
  it('stops the holders BEFORE the first delete', async () => {
    const { deps, order } = setup(async (p) => result(p, 'removed'))
    await removeWorktreesAfterTeardown(['/r/.claude/worktrees/a'], deps)
    expect(order).toEqual(['stop', 'remove:/r/.claude/worktrees/a'])
  })

  it('does nothing (not even stopping holders) for an empty list', async () => {
    const { deps } = setup(async (p) => result(p, 'removed'))
    await removeWorktreesAfterTeardown([], deps)
    expect(deps.stopHolders).not.toHaveBeenCalled()
    expect(deps.remove).not.toHaveBeenCalled()
  })

  it('removes a nested worktree before its container and each path once', async () => {
    const { deps, order } = setup(async (p) => result(p, 'removed'))
    await removeWorktreesAfterTeardown(['/r/outer', '/r/outer/inner', '/r/outer'], deps)
    expect(order.slice(1)).toEqual(['remove:/r/outer/inner', 'remove:/r/outer'])
  })

  it('retries a partial result up the ladder (0.75 / 2 / 5 s) after the 0.75 s settle, and logs the final outcome', async () => {
    let calls = 0
    const { deps, debugs, sleeps } = setup(async (p) => {
      calls++
      return calls < 4
        ? result(p, 'partial', { failures: [{ path: `${p}/x`, code: 'EBUSY' }] })
        : result(p, 'removed')
    })
    await removeWorktreesAfterTeardown(['/r/a'], deps)
    expect(deps.remove).toHaveBeenCalledTimes(4)
    expect(sleeps).toEqual([750, 750, 2000, 5000])
    expect(debugs).toHaveLength(1)
    expect(debugs[0]).toContain('removed')
  })

  it('gives up after the last rung and reports what is left', async () => {
    const { deps, debugs, sleeps } = setup(async (p) =>
      result(p, 'partial', { failures: [{ path: `${p}/x`, code: 'EBUSY' }] })
    )
    await removeWorktreesAfterTeardown(['/r/a'], deps)
    expect(deps.remove).toHaveBeenCalledTimes(4) // the first attempt + one per rung
    expect(sleeps).toEqual([750, 750, 2000, 5000])
    expect(debugs[0]).toContain('partial')
    expect(debugs[0]).toContain('1 path(s) left')
  })

  it('a failed result is retried the same way, and stops climbing once it succeeds', async () => {
    let calls = 0
    const { deps, sleeps } = setup(async (p) =>
      ++calls === 1 ? result(p, 'failed', { reason: 'git busy' }) : result(p, 'removed')
    )
    await removeWorktreesAfterTeardown(['/r/a'], deps)
    expect(deps.remove).toHaveBeenCalledTimes(2)
    expect(sleeps).toEqual([750, 750])
  })

  it('keeps going when one removal throws, and never throws itself', async () => {
    const { deps, warns, debugs } = setup(async (p) => {
      if (p === '/r/bad') throw new Error('boom')
      return result(p, 'removed')
    })
    await expect(
      removeWorktreesAfterTeardown(['/r/bad', '/r/good-longer-path'], deps)
    ).resolves.toBeUndefined()
    expect(warns.some((w) => w.includes('/r/bad') && w.includes('boom'))).toBe(true)
    expect(debugs.some((i) => i.includes('/r/good-longer-path'))).toBe(true)
  })

  it('survives stopHolders throwing', async () => {
    const { deps } = setup(async (p) => result(p, 'removed'))
    deps.stopHolders.mockImplementation(() => {
      throw new Error('already gone')
    })
    await removeWorktreesAfterTeardown(['/r/a'], deps)
    expect(deps.remove).toHaveBeenCalledOnce()
  })

  it('does not retry a refusal', async () => {
    const { deps, sleeps } = setup(async (p) => result(p, 'refused', { reason: 'not-found' }))
    await removeWorktreesAfterTeardown(['/r/a'], deps)
    expect(deps.remove).toHaveBeenCalledOnce()
    expect(sleeps).toEqual([750]) // the settle only
  })

  it('logs each outcome once at debug, never at warn or info: the removal itself already logs at info (N3)', async () => {
    const { deps, debugs, warns } = setup(async (p) =>
      result(p, 'partial', { failures: [{ path: `${p}/x`, code: 'EBUSY' }] })
    )
    await removeWorktreesAfterTeardown(['/r/a', '/r/b'], deps)
    expect(debugs).toHaveLength(2)
    expect(warns).toEqual([])
    // No `info` channel exists on the deps any more.
    expect('info' in deps).toBe(false)
  })
})

describe('sanitiseQuitPaths (the app:quit-confirm argument)', () => {
  it('keeps non-empty strings, drops everything else, and is capped', () => {
    expect(sanitiseQuitPaths(['/a', '', 3, null, '/b'])).toEqual(['/a', '/b'])
    expect(sanitiseQuitPaths('/a')).toEqual([])
    expect(sanitiseQuitPaths(undefined)).toEqual([])
    const many = Array.from({ length: QUIT_PATHS_MAX + 40 }, (_, i) => `/r/${i}`)
    expect(sanitiseQuitPaths(many)).toHaveLength(QUIT_PATHS_MAX)
  })
})

describe('createQuitRemovalDeps (what main/index.ts wires)', () => {
  function wiring(over: Partial<QuitRemovalWiring> = {}) {
    const calls: string[] = []
    const removeAtPath = vi.fn(async (_p: string, _o: WorktreeRemoveOptions, _root?: string) =>
      result('id', 'removed')
    )
    const w: QuitRemovalWiring = {
      forEachSession: (visit) => {
        for (const id of ['s1', 's2']) {
          visit({ routingId: id, cancel: () => calls.push(`cancel:${id}`) })
        }
      },
      killTerminals: () => calls.push('terminals'),
      releaseDispatchTargets: () => calls.push('xagents'),
      removeAtPath,
      beforeWalk: vi.fn(),
      forgetEntries: vi.fn(),
      createdOnly: vi.fn(() => true),
      debug: vi.fn(),
      warn: vi.fn(),
      ...over
    }
    return { w, calls, removeAtPath }
  }

  it('stops every holder kind: sessions, X-Agents (background included) and terminals', () => {
    const { w, calls } = wiring()
    createQuitRemovalDeps(w).stopHolders()
    expect(calls).toEqual(['cancel:s1', 'cancel:s2', 'xagents', 'terminals'])
  })

  it('one failing holder stop does not skip the others', () => {
    const calls: string[] = []
    const { w } = wiring({
      forEachSession: (visit) => {
        visit({
          routingId: 'bad',
          cancel: () => {
            throw new Error('server already gone')
          }
        })
        visit({ routingId: 'ok', cancel: () => calls.push('cancel:ok') })
      },
      releaseDispatchTargets: () => {
        throw new Error('dispatcher down')
      },
      killTerminals: () => calls.push('terminals')
    })
    createQuitRemovalDeps(w).stopHolders()
    expect(calls).toEqual(['cancel:ok', 'terminals'])
    expect(w.warn).toHaveBeenCalledWith(expect.stringContaining('dispatcher down'))
  })

  it('removes by path with holders NOT enforced, created-only, the watcher hook and FORGET-ONLY bookkeeping', async () => {
    const { w, removeAtPath } = wiring()
    const deps = createQuitRemovalDeps(w)

    const res = await deps.remove('/r/.claude/worktrees/a')

    expect(res.outcome).toBe('removed')
    const [target, opts] = removeAtPath.mock.calls[0]
    expect(target).toBe('/r/.claude/worktrees/a')
    expect(opts).toEqual({
      enforceHolders: false,
      beforeWalk: w.beforeWalk,
      forgetEntries: w.forgetEntries, // the very hook handed in: no directories refresh bolted on
      createdOnly: w.createdOnly
    })
  })

  it('hands the recorded repo root to the removal, so a vanished out-of-repo worktree can be found (RC-1)', async () => {
    const { w, removeAtPath } = wiring({
      recordedGitRoot: (p) => (p === '/r/gone' ? '/r/repo' : undefined)
    })
    const deps = createQuitRemovalDeps(w)

    await deps.remove('/r/gone')
    await deps.remove('/r/other')

    expect(removeAtPath.mock.calls[0][2]).toBe('/r/repo')
    expect(removeAtPath.mock.calls[1][2]).toBeUndefined()
  })

  it('the retry ladder keeps working after a partial: createdOnly must still pass (R-1)', async () => {
    // The wiring's two hooks share one record, as the real ones share `worktreeInfoMap`. The fake
    // core follows the contract of `removeWorktrees`: createdOnly gates every attempt, and only a
    // fully REMOVED path is forgotten (forgetting a partial one made the retry refuse).
    const recorded = new Set(['/r/a'])
    const outcomes: string[] = []
    let attempts = 0
    const removeAtPath = vi.fn(async (p: string, o: WorktreeRemoveOptions) => {
      const res: WorktreeRemoveResult = !o.createdOnly?.(p)
        ? result(p, 'refused', { reason: 'invalid: not a worktree ClaudeUI created' })
        : ++attempts < 3
          ? result(p, 'partial', { failures: [{ path: `${p}/x`, code: 'EBUSY' }] })
          : result(p, 'removed')
      if (res.outcome === 'removed') o.forgetEntries?.([p])
      outcomes.push(res.outcome)
      return res
    })
    const { w } = wiring({
      removeAtPath,
      forgetEntries: (paths) => paths.forEach((p) => recorded.delete(p)),
      createdOnly: (p) => recorded.has(p)
    })
    const deps = { ...createQuitRemovalDeps(w), sleep: async () => {} }

    await removeWorktreesAfterTeardown(['/r/a'], deps)

    expect(outcomes).toEqual(['partial', 'partial', 'removed'])
    expect(recorded.size).toBe(0)
  })

  it('a path the core refuses by throwing is logged by the loop and does not stop the others', async () => {
    const { w, removeAtPath } = wiring()
    removeAtPath.mockImplementation(async (p: string) => {
      if (p.endsWith('/bad')) throw new Error('Refusing to remove worktree outside the managed dir')
      return result('id', 'removed')
    })
    const deps = { ...createQuitRemovalDeps(w), sleep: async () => {} }

    await removeWorktreesAfterTeardown(['/r/bad', '/r/good-path-longer'], deps)

    expect(removeAtPath).toHaveBeenCalledTimes(2)
    expect(w.warn).toHaveBeenCalledWith(expect.stringContaining('/r/bad'))
  })
})
