/**
 * @vitest-environment node
 *
 * The Codex delete plan and the walk that executes it (ADR-066 slice G).
 *
 * What the binary enforces is pinned against the real thing by
 * `src/integration/codex/codex-delete.integration.test.ts`; this file is about
 * the two decisions ClaudeUI makes on top of it — which threads a delete must
 * take with it, in what order, and what happens to the rest of the plan when
 * one of them is refused. The native service is a stub: the ONE thing these
 * tests must not depend on is a real app-server's timing.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'

const db = vi.hoisted(() => ({
  listCodexForks: vi.fn(() => [] as Array<{ threadId: string; forkedFromId: string | null }>),
  deleteCodexFork: vi.fn(),
  deleteCodexSessionOverrides: vi.fn(),
  deleteSessionMeta: vi.fn()
}))
vi.mock('../../services/db', () => db)
vi.mock('../codex-locate', () => ({ locateCodexBinary: () => '/fixture/codex' }))
/**
 * The sweep the plan runs for branches the registry has forgotten. Its own
 * behaviour (which ids it probes, how a refusal is confirmed) is pinned in
 * `codex-discovery-history.test.ts`; here it is the seam the plan reads through.
 */
const history = vi.hoisted(() => ({
  discoverCodexForks: vi.fn(
    async () => [] as Array<{ threadId: string; forkedFromId: string | null }>
  )
}))
vi.mock('../history', () => history)

import {
  buildCodexDeletePlan,
  codexDeletePlan,
  deleteCodexSubtree,
  type CodexNodeFacts
} from '../delete'
import type { CodexService } from '../CodexService'

const cold = (): CodexNodeFacts => ({ title: null, live: false })

/** A stub `CodexService` whose `deleteThread` is scripted per thread id. */
function fakeService(refuse: Record<string, string> = {}): {
  service: CodexService
  deleted: string[]
  attempts: string[]
} {
  const deleted: string[] = []
  const attempts: string[] = []
  const service = {
    deleteThread: vi.fn(async (threadId: string) => {
      attempts.push(threadId)
      if (refuse[threadId]) throw new Error(refuse[threadId])
      deleted.push(threadId)
    }),
    dispose: vi.fn()
  } as unknown as CodexService
  return { service, deleted, attempts }
}

function hooks(): {
  hooks: Parameters<typeof deleteCodexSubtree>[1]
  order: string[]
} {
  const order: string[] = []
  return {
    order,
    hooks: {
      unwatch: (id) => order.push(`unwatch:${id}`),
      stop: (id) => order.push(`stop:${id}`),
      removeSession: (id) => order.push(`remove:${id}`)
    }
  }
}

describe('buildCodexDeletePlan', () => {
  it('walks forks of forks and orders them leaf-first', () => {
    const plan = buildCodexDeletePlan(
      'root',
      [
        { threadId: 'fork-a', forkedFromId: 'root' },
        { threadId: 'fork-b', forkedFromId: 'root' },
        { threadId: 'fork-a1', forkedFromId: 'fork-a' },
        { threadId: 'elsewhere', forkedFromId: 'another-root' }
      ],
      cold
    )
    // The deepest branch first and the clicked thread last: the binary refuses
    // to delete a thread while a fork still references its history, so any
    // other order stops on the first node.
    expect(plan.order).toEqual(['fork-a1', 'fork-a', 'fork-b', 'root'])
    expect(plan.nodes.map((node) => [node.threadId, node.depth])).toEqual([
      ['root', 0],
      ['fork-a', 1],
      ['fork-b', 1],
      ['fork-a1', 2]
    ])
    // A branch of a DIFFERENT root is not this delete's business.
    expect(plan.order).not.toContain('elsewhere')
  })

  it('marks the live node and carries each title', () => {
    const plan = buildCodexDeletePlan(
      'root',
      [{ threadId: 'fork-a', forkedFromId: 'root' }],
      (id) => ({ title: id === 'fork-a' ? 'The branch' : 'The root', live: id === 'fork-a' })
    )
    expect(plan.nodes).toEqual([
      { threadId: 'root', title: 'The root', live: false, depth: 0 },
      { threadId: 'fork-a', title: 'The branch', live: true, depth: 1 }
    ])
  })

  it('is a single node for an unbranched session', () => {
    expect(buildCodexDeletePlan('root', [], cold).order).toEqual(['root'])
  })

  it('cannot loop on a cyclic registry', () => {
    const plan = buildCodexDeletePlan(
      'root',
      [
        { threadId: 'a', forkedFromId: 'root' },
        { threadId: 'root', forkedFromId: 'a' }
      ],
      cold
    )
    expect(plan.order).toEqual(['a', 'root'])
  })

  it('includes a branch only the session_meta sweep knows about', async () => {
    // THE BUG THIS EXISTS FOR: the registry held nothing but the adoption
    // marker, so the plan was the root alone and the native delete refused it
    // — the two branches were still there, referencing its history.
    history.discoverCodexForks.mockResolvedValueOnce([
      { threadId: 'swept-fork', forkedFromId: 'root' }
    ])
    expect((await codexDeletePlan('root', cold)).order).toEqual(['swept-fork', 'root'])
  })

  it('falls back to the registry when the sweep itself fails', async () => {
    // A sweep that cannot run is not a reason to refuse a delete: the registry
    // alone is what every plan used before, and it is right unless a branch was
    // lost.
    history.discoverCodexForks.mockRejectedValueOnce(new Error('Codex transport: disposed'))
    db.listCodexForks.mockReturnValueOnce([{ threadId: 'fork-a', forkedFromId: 'root' }])
    expect((await codexDeletePlan('root', cold)).order).toEqual(['fork-a', 'root'])
  })

  it('reads the registry through codexDeletePlan', async () => {
    history.discoverCodexForks.mockResolvedValueOnce([{ threadId: 'fork-a', forkedFromId: 'root' }])
    expect((await codexDeletePlan('root', cold)).order).toEqual(['fork-a', 'root'])
  })
})

describe('deleteCodexSubtree', () => {
  beforeEach(() => vi.clearAllMocks())

  it('deletes leaf-first, unwatching and replicating each removal', async () => {
    const { service, deleted } = fakeService()
    const h = hooks()
    const plan = buildCodexDeletePlan('root', [{ threadId: 'fork-a', forkedFromId: 'root' }], cold)
    await deleteCodexSubtree(plan, h.hooks, { service })
    expect(deleted).toEqual(['fork-a', 'root'])
    // Per node: unwatch before the transcript can vanish, then replicate.
    expect(h.order).toEqual(['unwatch:fork-a', 'remove:fork-a', 'unwatch:root', 'remove:root'])
    // Rows are forgotten only for threads the binary confirmed.
    expect(db.deleteCodexFork.mock.calls.map((call) => call[0])).toEqual(['fork-a', 'root'])
    expect(db.deleteSessionMeta.mock.calls.map((call) => call[0])).toEqual(['fork-a', 'root'])
  })

  it('stops a live node before deleting it', async () => {
    const { service } = fakeService()
    const h = hooks()
    const plan = buildCodexDeletePlan(
      'root',
      [{ threadId: 'fork-a', forkedFromId: 'root' }],
      (id) => (id === 'fork-a' ? { title: null, live: true } : cold())
    )
    await deleteCodexSubtree(plan, h.hooks, { service })
    expect(h.order[0]).toBe('unwatch:fork-a')
    expect(h.order[1]).toBe('stop:fork-a')
    // The root was never live, so nothing tried to stop it.
    expect(h.order).not.toContain('stop:root')
  })

  it('stops at the FIRST refusal, leaving everything after it untouched', async () => {
    const { service, deleted, attempts } = fakeService({
      'fork-a': 'Codex transport: rpc-error--32600'
    })
    const h = hooks()
    const plan = buildCodexDeletePlan(
      'root',
      [
        { threadId: 'fork-a', forkedFromId: 'root' },
        { threadId: 'fork-a1', forkedFromId: 'fork-a' }
      ],
      (id) => ({ title: id === 'fork-a' ? 'Refused branch' : null, live: false })
    )
    await expect(deleteCodexSubtree(plan, h.hooks, { service })).rejects.toThrow(
      /Codex refused to delete "Refused branch".*1 of 3 threads were deleted; 2 remain/s
    )
    // The leaf below it is gone; the root above it was never asked.
    expect(deleted).toEqual(['fork-a1'])
    expect(attempts).toEqual(['fork-a1', 'fork-a'])
    expect(h.order).not.toContain('unwatch:root')
    // The refused node keeps its rows, so the sidebar can show it again.
    expect(db.deleteCodexFork.mock.calls.map((call) => call[0])).toEqual(['fork-a1'])
  })

  it('retries a node it just stopped, because the writer lock outlives the stop', async () => {
    // The native delete is refused while the holding PROCESS is still alive, and
    // `cancel()` only starts its teardown (SIGTERM, SIGKILL a second later).
    let refusals = 2
    const service = {
      deleteThread: vi.fn(async () => {
        if (refusals-- > 0) throw new Error('Codex transport: rpc-error--32600')
      }),
      dispose: vi.fn()
    } as unknown as CodexService
    const slept: number[] = []
    const plan = buildCodexDeletePlan('root', [], () => ({ title: null, live: true }))
    await deleteCodexSubtree(plan, hooks().hooks, {
      service,
      sleep: async (ms) => void slept.push(ms),
      retryWindowMs: 3000,
      retryIntervalMs: 10
    })
    expect(service.deleteThread).toHaveBeenCalledTimes(3)
    expect(slept).toEqual([10, 10])
  })

  it('does not retry a node nothing of ours was holding', async () => {
    const { service, attempts } = fakeService({ root: 'Codex transport: rpc-error--32600' })
    const sleep = vi.fn(async () => {})
    await expect(
      deleteCodexSubtree(buildCodexDeletePlan('root', [], cold), hooks().hooks, { service, sleep })
    ).rejects.toThrow(/Codex refused to delete root/)
    expect(attempts).toEqual(['root'])
    expect(sleep).not.toHaveBeenCalled()
  })

  it('gives up on a stopped node once the retry window closes', async () => {
    const { service } = fakeService({ root: 'Codex transport: rpc-error--32600' })
    const plan = buildCodexDeletePlan('root', [], () => ({ title: null, live: true }))
    await expect(
      deleteCodexSubtree(plan, hooks().hooks, {
        service,
        sleep: async () => {},
        retryWindowMs: 0,
        retryIntervalMs: 0
      })
    ).rejects.toThrow(/Codex refused to delete root/)
  })
})
