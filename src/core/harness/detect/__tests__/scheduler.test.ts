/**
 * @vitest-environment node
 *
 * Background detection (ADR-082 §3): one run at a time, requests during a run
 * coalesced into one follow-up, the resolver's `stale` requests debounced,
 * and the resolver invalidated after every run, failed ones included.
 */
import { describe, it, expect, vi } from 'vitest'
import type { HarnessDetection, HarnessId } from '../../../../shared/harness-types'
import { HARNESS_IDS } from '../../../../shared/harness-types'
import {
  createDetectionScheduler,
  DISABLE_DETECTION_ENV,
  startDetectionScheduler,
  type DetectionSchedulerDeps
} from '../scheduler'

vi.mock('../../../services/logger', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }
}))

interface Pending {
  ids: readonly HarnessId[]
  finish: () => void
  fail: (err: Error) => void
}

/** A scheduler over a controllable `detect`: each run waits until the test finishes it. */
function harness(extra: Partial<DetectionSchedulerDeps> = {}): {
  runs: Pending[]
  saved: HarnessDetection[][]
  invalidated: HarnessId[]
  clock: { ms: number }
  scheduler: ReturnType<typeof createDetectionScheduler>
  next: () => Promise<Pending>
} {
  const runs: Pending[] = []
  const saved: HarnessDetection[][] = []
  const invalidated: HarnessId[] = []
  const clock = { ms: Date.parse('2026-09-30T00:00:00.000Z') }
  let waiter: ((p: Pending) => void) | null = null
  const scheduler = createDetectionScheduler({
    detect: (ids) =>
      new Promise<HarnessDetection[]>((resolve, reject) => {
        const pending: Pending = {
          ids,
          finish: () => resolve(ids.map((id) => ({ id, detectedAt: 'x', installs: [] }))),
          fail: reject
        }
        runs.push(pending)
        waiter?.(pending)
        waiter = null
      }),
    save: (d) => {
      saved.push([...d])
    },
    invalidate: (id) => invalidated.push(id),
    now: () => new Date(clock.ms),
    ...extra
  })
  const next = (): Promise<Pending> =>
    new Promise((resolve) => {
      waiter = resolve
    })
  return { runs, saved, invalidated, clock, scheduler, next }
}

describe('detection scheduler', () => {
  it('runs, saves, invalidates each harness detected, and reports its status', async () => {
    const h = harness()
    expect(h.scheduler.status()).toEqual({ running: false })
    const started = h.next()
    const done = h.scheduler.request(['pi', 'claude'], 'user')
    expect(h.scheduler.status().running).toBe(true)
    // Never on the caller's stack: nothing has been detected synchronously.
    expect(h.runs).toHaveLength(0)
    ;(await started).finish()
    await done
    expect(h.saved.map((d) => d.map((x) => x.id))).toEqual([['pi', 'claude']])
    expect(h.invalidated).toEqual(['pi', 'claude'])
    expect(h.scheduler.status()).toEqual({ running: false, lastRunAt: '2026-09-30T00:00:00.000Z' })
  })

  it('defaults to every harness', async () => {
    const h = harness()
    const started = h.next()
    const done = h.scheduler.request()
    ;(await started).finish()
    await done
    expect(h.runs[0].ids).toEqual(HARNESS_IDS)
  })

  it('coalesces requests during a run into one follow-up for their union', async () => {
    const h = harness()
    const first = h.next()
    const a = h.scheduler.request(['claude'], 'boot')
    const run1 = await first
    const b = h.scheduler.request(['pi'], 'user')
    const c = h.scheduler.request(['opencode', 'pi'], 'user')
    expect(h.runs).toHaveLength(1)

    const second = h.next()
    run1.finish()
    const run2 = await second
    expect([...run2.ids].sort()).toEqual(['opencode', 'pi'])
    run2.finish()
    await Promise.all([a, b, c])
    expect(h.runs).toHaveLength(2)
    expect(h.invalidated).toEqual(['claude', 'pi', 'opencode'])
  })

  it('drops a stale request for a harness in the run in flight or detected recently', async () => {
    const h = harness({ minIntervalMs: 60_000 })
    const first = h.next()
    const done = h.scheduler.request(['pi'], 'user')
    const run = await first
    await h.scheduler.request(['pi'], 'stale')
    run.finish()
    await done
    expect(h.runs).toHaveLength(1)

    // Recently detected: still dropped.
    h.clock.ms += 30_000
    await h.scheduler.request(['pi'], 'stale')
    expect(h.runs).toHaveLength(1)

    // After the interval, a stale request detects again.
    h.clock.ms += 31_000
    const again = h.next()
    const stale = h.scheduler.request(['pi'], 'stale')
    ;(await again).finish()
    await stale
    expect(h.runs).toHaveLength(2)
  })

  it('does not loop when invalidation makes the resolver ask again', async () => {
    let scheduler: ReturnType<typeof createDetectionScheduler> | null = null
    const h = harness({
      // The resolver re-resolves on invalidation and finds the cache still
      // stale (a write that failed): it asks again from inside the run.
      invalidate: (id) => void scheduler?.request([id], 'stale')
    })
    scheduler = h.scheduler
    const first = h.next()
    const done = h.scheduler.request(['claude'], 'boot')
    ;(await first).finish()
    await done
    await new Promise((r) => setTimeout(r, 5))
    expect(h.runs).toHaveLength(1)
  })

  it('never rejects, and still invalidates, when detection or the save fails', async () => {
    const h = harness({
      save: () => {
        throw new Error('disk full')
      }
    })
    const first = h.next()
    const done = h.scheduler.request(['codex'], 'user')
    ;(await first).fail(new Error('boom'))
    await expect(done).resolves.toBeUndefined()
    expect(h.invalidated).toEqual(['codex'])

    const second = h.next()
    const again = h.scheduler.request(['codex'], 'user')
    ;(await second).finish()
    await expect(again).resolves.toBeUndefined()
    expect(h.scheduler.status().running).toBe(false)
  })
})

describe('startDetectionScheduler', () => {
  it('arms nothing when the instance disables detection (as every test run does)', () => {
    expect(process.env[DISABLE_DETECTION_ENV]).toBe('1')
    const timers = vi.spyOn(globalThis, 'setTimeout')
    try {
      const disarm = startDetectionScheduler({ bootDelayMs: 0 })
      expect(timers).not.toHaveBeenCalled()
      disarm()
    } finally {
      timers.mockRestore()
    }
  })
})
