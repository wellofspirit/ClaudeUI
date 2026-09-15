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

  /**
   * The plan is a CACHE READ now (db v17). It used to sweep every codex
   * `session_meta` id the fork registry did not name, on every plan including
   * the confirmation's — it had to, because a root never earned a registry row,
   * so the candidate set never shrank. The scan fills the cache instead, and a
   * plan that turns out to be wrong is repaired by the walk's one rescan.
   */
  it('reads the lineage cache, and asks the binary nothing', () => {
    db.listCodexForks.mockReturnValueOnce([{ threadId: 'fork-a', forkedFromId: 'root' }])
    expect(codexDeletePlan('root', cold).order).toEqual(['fork-a', 'root'])
    expect(db.listCodexForks).toHaveBeenCalledTimes(1)
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

  it('asks the binary ONCE for a node it just stopped — no stop-then-wait', async () => {
    // Before ADR-069 the stop killed a PROCESS and the walk had to outwait its
    // writer lock (3 s, 500 ms apart). A session is a thread on a shared host
    // now: stopping it detaches, the thread stays loaded on that host, and the
    // delete is issued THERE, where the holder may delete its own thread (probe
    // P5). So a refusal is a real refusal, reported immediately.
    const { service, attempts } = fakeService({ root: 'Codex transport: rpc-error--32600' })
    const plan = buildCodexDeletePlan('root', [], () => ({ title: null, live: true }))
    await expect(deleteCodexSubtree(plan, hooks().hooks, { service })).rejects.toThrow(
      /Codex refused to delete root/
    )
    expect(attempts).toEqual(['root'])
  })

  it('does not retry a node nothing of ours was holding', async () => {
    const { service, attempts } = fakeService({ root: 'Codex transport: rpc-error--32600' })
    await expect(
      deleteCodexSubtree(buildCodexDeletePlan('root', [], cold), hooks().hooks, { service })
    ).rejects.toThrow(/Codex refused to delete root/)
    expect(attempts).toEqual(['root'])
  })

  // -------------------------------------------------------------------------
  // The one rescan. A refusal is always the same `-32600`, so the walk cannot
  // ask WHY; the one cause it can repair is a branch the lineage cache never
  // learned about (another client's fork, or one from a build that predates the
  // cache), which makes the binary refuse the node that branch still
  // references.
  // -------------------------------------------------------------------------

  it('rescans once on a refusal and CONTINUES when that finds a hidden branch', async () => {
    // `root` is refused because `hidden-fork`, which no plan knew about, still
    // references its history. The rescan learns it; the rebuilt plan puts it
    // before the root, where leaf-first order needs it.
    const attempts: string[] = []
    let hidden = true
    const service = {
      deleteThread: vi.fn(async (threadId: string) => {
        attempts.push(threadId)
        if (threadId === 'hidden-fork') {
          hidden = false
          return
        }
        if (threadId === 'root' && hidden) throw new Error('Codex transport: rpc-error--32600')
      }),
      dispose: vi.fn()
    } as unknown as CodexService
    const h = hooks()
    const replan = vi.fn(async () =>
      buildCodexDeletePlan('root', [{ threadId: 'hidden-fork', forkedFromId: 'root' }], cold)
    )
    await deleteCodexSubtree(buildCodexDeletePlan('root', [], cold), h.hooks, { service, replan })
    expect(replan).toHaveBeenCalledTimes(1)
    expect(attempts).toEqual(['root', 'hidden-fork', 'root'])
    expect(db.deleteSessionMeta.mock.calls.map((call) => call[0])).toEqual(['hidden-fork', 'root'])
  })

  it('does not redo the part of the plan that already landed', async () => {
    const { service, deleted, attempts } = fakeService({
      root: 'Codex transport: rpc-error--32600'
    })
    const plan = buildCodexDeletePlan('root', [{ threadId: 'fork-a', forkedFromId: 'root' }], cold)
    const replan = vi.fn(async () =>
      buildCodexDeletePlan(
        'root',
        [
          { threadId: 'fork-a', forkedFromId: 'root' },
          { threadId: 'hidden-fork', forkedFromId: 'root' }
        ],
        cold
      )
    )
    await expect(deleteCodexSubtree(plan, hooks().hooks, { service, replan })).rejects.toThrow(
      /Codex refused to delete root/
    )
    // `fork-a` went in the first pass and is NOT asked for again — a second
    // delete of a deleted thread is refused as "no such thread", which reads
    // exactly like a real refusal.
    expect(deleted).toEqual(['fork-a', 'hidden-fork'])
    expect(attempts).toEqual(['fork-a', 'root', 'hidden-fork', 'root'])
  })

  it('fails as before when the rescan changes nothing', async () => {
    const { service, attempts } = fakeService({ root: 'Codex transport: rpc-error--32600' })
    const replan = vi.fn(async () => buildCodexDeletePlan('root', [], cold))
    await expect(
      deleteCodexSubtree(buildCodexDeletePlan('root', [], cold), hooks().hooks, { service, replan })
    ).rejects.toThrow(/Codex refused to delete root/)
    expect(replan).toHaveBeenCalledTimes(1)
    // One attempt per pass and no third one: an unchanged plan is not retried.
    expect(attempts).toEqual(['root'])
  })

  it('rescans at most once per walk', async () => {
    const { service } = fakeService({ root: 'Codex transport: rpc-error--32600' })
    let generation = 0
    const replan = vi.fn(async () =>
      buildCodexDeletePlan(
        'root',
        [{ threadId: `discovered-${++generation}`, forkedFromId: 'root' }],
        cold
      )
    )
    await expect(
      deleteCodexSubtree(buildCodexDeletePlan('root', [], cold), hooks().hooks, { service, replan })
    ).rejects.toThrow(/Codex refused to delete root/)
    expect(replan).toHaveBeenCalledTimes(1)
  })

  it('throws the original refusal when the rescan itself fails', async () => {
    const { service } = fakeService({ root: 'Codex transport: rpc-error--32600' })
    const replan = vi.fn(async () => {
      throw new Error('Codex transport: disposed')
    })
    await expect(
      deleteCodexSubtree(buildCodexDeletePlan('root', [], cold), hooks().hooks, { service, replan })
    ).rejects.toThrow(/Codex refused to delete root/)
  })
})
