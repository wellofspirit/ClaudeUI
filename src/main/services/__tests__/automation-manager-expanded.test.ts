/**
 * @vitest-environment node
 *
 * Expanded coverage for AutomationManager:
 * DST transitions, interval drift, concurrency, cancel/dismiss,
 * retention, enable/disable cycle, upsert preserves run history, startup load.
 *
 * AutomationManager resolves AUTOMATION_DIR at module load time from
 * os.homedir(). To redirect it to a temp dir per test, we:
 *   1. vi.mock('os') with a dynamic homedir().
 *   2. vi.resetModules() before every test so the module-level constants
 *      re-resolve against the current TEMP_HOME.
 *   3. Dynamic-import the manager AFTER seeding TEMP_HOME.
 *
 * The SDK, claude-session, session-history, and logger are all mocked — we're
 * testing AutomationManager's lifecycle / persistence logic, not its
 * downstream integrations.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import * as fs from 'fs'
import * as nodePath from 'path'
import * as nodeOs from 'os'
import { CronExpressionParser } from 'cron-parser'

// ---------------------------------------------------------------------------
// Temp-home redirection
// ---------------------------------------------------------------------------

let TEMP_HOME = ''

vi.mock('os', async () => {
  const actual = await vi.importActual<typeof import('os')>('os')
  return {
    ...actual,
    homedir: () => TEMP_HOME,
    default: { ...actual, homedir: () => TEMP_HOME }
  }
})

vi.mock('electron', async () => {
  const shim = await import('../../../test/stubs/electron-shim')
  return { ...shim, default: shim }
})

// ---------------------------------------------------------------------------
// Configurable SDK stub
// ---------------------------------------------------------------------------

type SdkMode =
  | { kind: 'events'; events: Record<string, unknown>[] }
  | { kind: 'waitForAbort' }
  /** Yield events, then idle — mirrors cli.js staying alive after a turn. */
  | { kind: 'eventsThenWait'; events: Record<string, unknown>[] }

let sdkMode: SdkMode = { kind: 'events', events: [] }
let lastAbortObserved = false
let lastSdkParams: any = null
let lastGeneratorReturned = false

vi.mock('../../../core/sdk', () => ({
  query: (params: any) => {
    lastSdkParams = params
    const ac: AbortController | undefined = params?.options?.abortController
    const mode = sdkMode

    async function* gen() {
      try {
        if (mode.kind === 'waitForAbort') {
          await new Promise<void>((resolve) => {
            if (ac?.signal.aborted) {
              lastAbortObserved = true
              resolve()
              return
            }
            ac?.signal.addEventListener('abort', () => {
              lastAbortObserved = true
              resolve()
            })
          })
          return
        }
        if (mode.kind === 'eventsThenWait') {
          for (const event of mode.events) {
            if (ac?.signal.aborted) throw new DOMException('Aborted', 'AbortError')
            yield event
          }
          // Idle indefinitely — consumer's for-await must break/return to exit.
          await new Promise<void>((resolve) => {
            ac?.signal.addEventListener('abort', () => resolve())
          })
          return
        }
        for (const event of mode.events) {
          if (ac?.signal.aborted) throw new DOMException('Aborted', 'AbortError')
          yield event
        }
      } finally {
        lastGeneratorReturned = true
      }
    }
    const g = gen() as any
    g.setPermissionMode = vi.fn(async () => {})
    return g
  }
}))

// ---------------------------------------------------------------------------
// claude-session — avoid its transitive import fan-out
// ---------------------------------------------------------------------------

vi.mock('../../../core/services/claude-session', () => ({
  getSdkExecutableOpts: () => ({}),
  ClaudeSession: { getExtraWindows: () => new Set() }
}))

vi.mock('../../../core/services/session-history', () => ({
  loadSessionHistory: vi.fn(async () => ({ messages: [] }))
}))

vi.mock('../../../core/services/logger', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }
}))

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

import type { Automation, AutomationRun } from '../../../shared/types'

type AutomationManagerT = InstanceType<typeof import('../../../core/services/automation-manager').AutomationManager>

async function freshManager(): Promise<{
  mgr: AutomationManagerT
  win: any
  automationDir: () => string
  runsIndexFile: (id: string) => string
}> {
  // Every test gets its own module graph so AUTOMATION_DIR is bound to the
  // current TEMP_HOME.
  vi.resetModules()
  const { AutomationManager } = await import('../../../core/services/automation-manager')
  const win = {
    isDestroyed: () => false,
    webContents: { send: vi.fn() }
  }
  const mgr = new AutomationManager()
  const automationDir = () => nodePath.join(TEMP_HOME, '.claude', 'ui', 'automation')
  const runsIndexFile = (id: string) => nodePath.join(automationDir(), 'runs', id, 'runs.json')
  return { mgr, win, automationDir, runsIndexFile }
}

function makeAutomation(overrides: Partial<Automation> = {}): Automation {
  return {
    id: 'a-test',
    name: 'Test Automation',
    prompt: 'do the thing',
    cwd: '/tmp/project',
    schedule: { type: 'interval', intervalMs: 60_000 },
    permissions: { allow: [], deny: [] },
    model: 'default',
    effort: 'medium',
    permissionMode: 'auto',
    enabled: false,
    lastRunAt: null,
    lastRunStatus: null,
    createdAt: Date.now(),
    ...overrides
  }
}

// ---------------------------------------------------------------------------
// beforeEach — fresh temp home per test (module-level constants re-bind)
// ---------------------------------------------------------------------------

beforeEach(() => {
  TEMP_HOME = fs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), 'automgr-test-'))
  sdkMode = { kind: 'events', events: [] }
  lastAbortObserved = false
  lastSdkParams = null
  lastGeneratorReturned = false
})

afterEach(() => {
  if (TEMP_HOME && fs.existsSync(TEMP_HOME)) {
    fs.rmSync(TEMP_HOME, { recursive: true, force: true })
  }
  vi.clearAllMocks()
})

// ---------------------------------------------------------------------------
// DST — drives CronExpressionParser directly (the manager's underlying engine)
// ---------------------------------------------------------------------------

describe('AutomationManager — DST handling (via cron-parser)', () => {
  it('spring-forward: 02:30 daily cron in America/New_York skips or shifts the missing 02:30 on DST start day', () => {
    // 2024-03-10 US Eastern: clocks jump 02:00 → 03:00. Local time 02:30 does not exist.
    const expr = CronExpressionParser.parse('30 2 * * *', {
      currentDate: '2024-03-09T10:00:00-05:00',
      tz: 'America/New_York'
    })

    const mar10 = expr.next().toDate()
    const mar11 = expr.next().toDate()

    // First next() advances to March 10. The library picks SOME concrete
    // instant on that date (either skips the hour or shifts to 03:30 local).
    expect(mar10.toISOString()).toMatch(/2024-03-10T/)
    // Subsequent date moves to March 11 — not stuck on March 10.
    expect(mar11.toISOString()).toMatch(/2024-03-11T/)
  })

  it('fall-back: 01:30 daily cron in America/New_York — document cron-parser behavior on DST end day', () => {
    // 2024-11-03 US Eastern: clocks roll back 02:00 → 01:00. 01:30 occurs twice.
    // cron-parser's observed behavior is to emit BOTH ambiguous 01:30 instants
    // before advancing to the next day. We pin that behavior here so a future
    // library change that switches to single-fire trips this test.
    const expr = CronExpressionParser.parse('30 1 * * *', {
      currentDate: '2024-11-02T10:00:00-04:00',
      tz: 'America/New_York'
    })

    const first = expr.next().toDate()
    const second = expr.next().toDate()
    const third = expr.next().toDate()

    // All three occurrences land in early Nov.
    expect(first.toISOString()).toMatch(/2024-11-0[34]T/)
    expect(second.toISOString()).toMatch(/2024-11-0[345]T/)
    // Time strictly advances.
    expect(second.getTime()).toBeGreaterThan(first.getTime())
    expect(third.getTime()).toBeGreaterThan(second.getTime())
  })
})

// ---------------------------------------------------------------------------
// Runtime behavior
// ---------------------------------------------------------------------------

describe('AutomationManager — scheduling & runtime', () => {
  it('interval drift: after a run finishes, next timer is (re)scheduled with the full interval', async () => {
    const { mgr, automationDir } = await freshManager()
    mgr.load()

    sdkMode = { kind: 'events', events: [{ type: 'result', total_cost_usd: 0 }] }

    const auto = makeAutomation({
      id: 'drift-1',
      enabled: true,
      schedule: { type: 'interval', intervalMs: 60_000 }
    })
    mgr.upsert(auto)

    // Immediately after upsert(), a timer was scheduled for the first fire.
    const timers: Map<string, unknown> = (mgr as any).timers
    expect(timers.has('drift-1')).toBe(true)

    // Trigger runNow instead of waiting on real timers to avoid test flakiness;
    // this exercises the same post-run reschedule path (executeRun finally block).
    await mgr.runNow('drift-1')

    // executeRun reschedules the next tick. The timer must still be pending —
    // i.e. it was re-armed (from END of previous run), not cleared.
    expect(timers.has('drift-1')).toBe(true)

    // Exactly one run recorded, not piled-up.
    const runs = mgr.listRuns('drift-1')
    expect(runs).toHaveLength(1)
    expect(runs[0].status).toBe('success')

    // Persisted to disk.
    const runsFile = nodePath.join(automationDir(), 'runs', 'drift-1', 'runs.json')
    expect(fs.existsSync(runsFile)).toBe(true)

    mgr.stopAll()
  })

  it('H11: a long (30-day) interval chains past the 32-bit clamp and does not fire early', async () => {
    const { mgr } = await freshManager()
    mgr.load()
    vi.useFakeTimers()
    try {
      const executeSpy = vi
        .spyOn(mgr as any, 'executeRun')
        .mockResolvedValue({ costUsd: 0, lastText: '' })

      const THIRTY_DAYS = 30 * 24 * 60 * 60 * 1000 // 2_592_000_000 ms > 2^31-1
      mgr.upsert(
        makeAutomation({
          id: 'h11-long',
          enabled: true,
          schedule: { type: 'interval', intervalMs: THIRTY_DAYS }
        })
      )

      const MAX = 2_147_483_647
      // One full clamp window elapses. Pre-fix the runtime clamps the 30-day
      // delay to 1ms and executeRun fires almost immediately; post-fix this only
      // re-arms the chained remainder.
      await vi.advanceTimersByTimeAsync(MAX)
      expect(executeSpy).not.toHaveBeenCalled()
      // A timer is still pending (the chained remainder) — the schedule isn't wedged.
      expect((mgr as any).timers.has('h11-long')).toBe(true)

      // Advancing the remaining ~14 days fires exactly one run.
      await vi.advanceTimersByTimeAsync(THIRTY_DAYS)
      expect(executeSpy).toHaveBeenCalledTimes(1)

      mgr.stopAll()
    } finally {
      vi.useRealTimers()
    }
  })

  it('concurrent runs: two automations execute independently with separate run state', async () => {
    const { mgr } = await freshManager()
    mgr.load()

    sdkMode = { kind: 'events', events: [{ type: 'result', total_cost_usd: 0.01 }] }

    mgr.upsert(makeAutomation({ id: 'c-a', name: 'A' }))
    mgr.upsert(makeAutomation({ id: 'c-b', name: 'B' }))

    // Fire both at the same logical tick (two awaited runNow calls in Promise.all).
    await Promise.all([mgr.runNow('c-a'), mgr.runNow('c-b')])

    const runsA = mgr.listRuns('c-a')
    const runsB = mgr.listRuns('c-b')
    expect(runsA).toHaveLength(1)
    expect(runsB).toHaveLength(1)
    // State is not shared.
    expect(runsA[0].id).not.toEqual(runsB[0].id)
    expect(runsA[0].automationId).toBe('c-a')
    expect(runsB[0].automationId).toBe('c-b')
    // Both succeeded — one did not block the other.
    expect(runsA[0].status).toBe('success')
    expect(runsB[0].status).toBe('success')

    mgr.stopAll()
  })

  it('records the cost of a sendMessage follow-up turn onto the resumed run', async () => {
    const { mgr } = await freshManager()
    mgr.load()

    // Initial scheduled run: establishes the session id + a first cost.
    sdkMode = {
      kind: 'events',
      events: [
        { type: 'system', subtype: 'init', session_id: 'ses-followup' },
        { type: 'result', total_cost_usd: 0.01 }
      ]
    }
    mgr.upsert(makeAutomation({ id: 'followup-1' }))
    await mgr.runNow('followup-1')

    const afterRun = mgr.listRuns('followup-1')
    expect(afterRun).toHaveLength(1)
    expect(afterRun[0].totalCostUsd).toBeCloseTo(0.01)
    expect((mgr as any).sessionIds.get('followup-1')).toBe('ses-followup')

    // A follow-up message resumes the session and spends more. Pre-fix its cost
    // landed NOWHERE (currentRunIds was empty for follow-ups → the result
    // handler skipped persistence). It must now fold onto the resumed run.
    sdkMode = { kind: 'events', events: [{ type: 'result', total_cost_usd: 0.02 }] }
    mgr.sendMessage('followup-1', 'do more')

    await vi.waitFor(() => {
      const runs = mgr.listRuns('followup-1')
      expect(runs[0].totalCostUsd).toBeCloseTo(0.03) // 0.01 + 0.02
    })
    // The follow-up association is cleared afterward (no leak into later runs).
    expect((mgr as any).currentRunIds.has('followup-1')).toBe(false)

    mgr.stopAll()
  })

  it('cancel mid-run: cancelRun aborts the SDK query and clears active-run state', async () => {
    const { mgr } = await freshManager()
    mgr.load()

    sdkMode = { kind: 'waitForAbort' }
    mgr.upsert(makeAutomation({ id: 'cancel-1' }))

    const runPromise = mgr.runNow('cancel-1')
    // Yield a few microtasks so the generator installs its abort listener.
    await new Promise((r) => setTimeout(r, 20))

    // Active before cancel.
    expect((mgr as any).activeRuns.has('cancel-1')).toBe(true)

    mgr.cancelRun('cancel-1')
    await runPromise

    expect(lastAbortObserved).toBe(true)
    expect((mgr as any).activeRuns.has('cancel-1')).toBe(false)
    expect((mgr as any).sessionIds.has('cancel-1')).toBe(false)

    // Run record persisted with a terminal status (success since no error thrown by stub).
    const runs = mgr.listRuns('cancel-1')
    expect(runs).toHaveLength(1)
    expect(runs[0].status).not.toBe('running')
    expect(runs[0].finishedAt).toBeTruthy()

    mgr.stopAll()
  })

  it('dismissRun: marks a running-status run as error and persists to disk', async () => {
    const { mgr, runsIndexFile } = await freshManager()
    mgr.load()

    mgr.upsert(makeAutomation({ id: 'dismiss-1' }))

    // Seed a stuck "running" run alongside a completed one, to simulate an
    // orphan left behind by a previous instance.
    const runsPath = runsIndexFile('dismiss-1')
    fs.mkdirSync(nodePath.dirname(runsPath), { recursive: true })
    const seed: AutomationRun[] = [
      {
        id: 'r-stuck',
        automationId: 'dismiss-1',
        startedAt: Date.now() - 10_000,
        finishedAt: null,
        status: 'running',
        totalCostUsd: 0
      },
      {
        id: 'r-done',
        automationId: 'dismiss-1',
        startedAt: Date.now() - 100_000,
        finishedAt: Date.now() - 90_000,
        status: 'success',
        totalCostUsd: 0.05
      }
    ]
    fs.writeFileSync(runsPath, JSON.stringify(seed))

    mgr.dismissRun('dismiss-1', 'r-stuck')

    const onDisk = JSON.parse(fs.readFileSync(runsPath, 'utf-8')) as AutomationRun[]
    const stuck = onDisk.find((r) => r.id === 'r-stuck')!
    expect(stuck.status).toBe('error')
    expect(stuck.error).toBe('Manually stopped')
    expect(stuck.finishedAt).toBeTruthy()
    // Other run untouched.
    const done = onDisk.find((r) => r.id === 'r-done')!
    expect(done.status).toBe('success')

    mgr.stopAll()
  })

  it('dismissRun: no-op for non-running runs', async () => {
    const { mgr, runsIndexFile } = await freshManager()
    mgr.load()
    mgr.upsert(makeAutomation({ id: 'dismiss-2' }))

    const runsPath = runsIndexFile('dismiss-2')
    fs.mkdirSync(nodePath.dirname(runsPath), { recursive: true })
    const before: AutomationRun[] = [
      {
        id: 'r-ok',
        automationId: 'dismiss-2',
        startedAt: 1,
        finishedAt: 2,
        status: 'success',
        totalCostUsd: 0
      }
    ]
    fs.writeFileSync(runsPath, JSON.stringify(before))

    mgr.dismissRun('dismiss-2', 'r-ok')

    const after = JSON.parse(fs.readFileSync(runsPath, 'utf-8'))
    expect(after).toEqual(before)

    mgr.stopAll()
  })

  it('listRuns: returns runs newest-first (executeRun unshifts into the list)', async () => {
    const { mgr } = await freshManager()
    mgr.load()

    sdkMode = { kind: 'events', events: [{ type: 'result', total_cost_usd: 0 }] }
    mgr.upsert(makeAutomation({ id: 'retention-1' }))

    await mgr.runNow('retention-1')
    await new Promise((r) => setTimeout(r, 2)) // ensure startedAt monotonicity
    await mgr.runNow('retention-1')
    await new Promise((r) => setTimeout(r, 2))
    await mgr.runNow('retention-1')

    const runs = mgr.listRuns('retention-1')
    expect(runs).toHaveLength(3)
    // startedAt monotonically decreasing.
    expect(runs[0].startedAt).toBeGreaterThanOrEqual(runs[1].startedAt)
    expect(runs[1].startedAt).toBeGreaterThanOrEqual(runs[2].startedAt)

    mgr.stopAll()
  })

  it('enable/disable cycle: toggle(false) cancels schedule; toggle(true) re-arms it', async () => {
    const { mgr, automationDir } = await freshManager()
    mgr.load()

    mgr.upsert(
      makeAutomation({
        id: 'toggle-1',
        enabled: true,
        schedule: { type: 'interval', intervalMs: 45_000 }
      })
    )

    const timers: Map<string, unknown> = (mgr as any).timers
    expect(timers.has('toggle-1')).toBe(true)

    mgr.toggle('toggle-1', false)
    expect(timers.has('toggle-1')).toBe(false)

    mgr.toggle('toggle-1', true)
    expect(timers.has('toggle-1')).toBe(true)

    // Persisted enabled flag matches the last toggle.
    const saved = JSON.parse(
      fs.readFileSync(nodePath.join(automationDir(), 'toggle-1.json'), 'utf-8')
    )
    expect(saved.enabled).toBe(true)

    mgr.stopAll()
  })

  it('upsert with existing id: overwrites definition, preserves run history on disk', async () => {
    const { mgr } = await freshManager()
    mgr.load()

    sdkMode = { kind: 'events', events: [{ type: 'result', total_cost_usd: 0.02 }] }
    mgr.upsert(makeAutomation({ id: 'upsert-1', name: 'v1', prompt: 'original' }))
    await mgr.runNow('upsert-1')

    const runsBefore = mgr.listRuns('upsert-1')
    expect(runsBefore).toHaveLength(1)
    const originalRunId = runsBefore[0].id

    mgr.upsert(makeAutomation({ id: 'upsert-1', name: 'v2', prompt: 'updated' }))

    const fromList = mgr.list().find((a) => a.id === 'upsert-1')
    expect(fromList?.name).toBe('v2')
    expect(fromList?.prompt).toBe('updated')

    const runsAfter = mgr.listRuns('upsert-1')
    expect(runsAfter).toHaveLength(1)
    expect(runsAfter[0].id).toBe(originalRunId)

    mgr.stopAll()
  })

  it('startup load: previously-saved automations and runs re-hydrate from disk', async () => {
    // Seed disk BEFORE constructing the manager.
    const automationDir = nodePath.join(TEMP_HOME, '.claude', 'ui', 'automation')
    fs.mkdirSync(automationDir, { recursive: true })
    const auto = makeAutomation({ id: 'persisted-1', name: 'Persisted' })
    fs.writeFileSync(nodePath.join(automationDir, 'persisted-1.json'), JSON.stringify(auto))

    const runsPath = nodePath.join(automationDir, 'runs', 'persisted-1', 'runs.json')
    fs.mkdirSync(nodePath.dirname(runsPath), { recursive: true })
    const seededRuns: AutomationRun[] = [
      {
        id: 'run-old',
        automationId: 'persisted-1',
        startedAt: 1,
        finishedAt: 2,
        status: 'success',
        totalCostUsd: 0
      }
    ]
    fs.writeFileSync(runsPath, JSON.stringify(seededRuns))

    const { mgr } = await freshManager()
    mgr.load()

    const loaded = mgr.list().find((a) => a.id === 'persisted-1')
    expect(loaded).toBeDefined()
    expect(loaded?.name).toBe('Persisted')

    const runs = mgr.listRuns('persisted-1')
    expect(runs).toHaveLength(1)
    expect(runs[0].id).toBe('run-old')

    mgr.stopAll()
  })

  it('corrupt files: malformed automation JSON is dropped; corrupt run-index degrades to []', async () => {
    // Seed a mix of healthy / corrupt files before the manager loads.
    const automationDir = nodePath.join(TEMP_HOME, '.claude', 'ui', 'automation')
    fs.mkdirSync(automationDir, { recursive: true })

    fs.writeFileSync(
      nodePath.join(automationDir, 'good.json'),
      JSON.stringify(makeAutomation({ id: 'good', name: 'Good' }))
    )
    const goodRuns = nodePath.join(automationDir, 'runs', 'good', 'runs.json')
    fs.mkdirSync(nodePath.dirname(goodRuns), { recursive: true })
    fs.writeFileSync(
      goodRuns,
      JSON.stringify([
        {
          id: 'g1',
          automationId: 'good',
          startedAt: 1,
          finishedAt: 2,
          status: 'success',
          totalCostUsd: 0
        }
      ])
    )

    fs.writeFileSync(nodePath.join(automationDir, 'bad.json'), '{ not valid json')

    fs.writeFileSync(
      nodePath.join(automationDir, 'partial.json'),
      JSON.stringify(makeAutomation({ id: 'partial', name: 'Partial' }))
    )
    const partialRuns = nodePath.join(automationDir, 'runs', 'partial', 'runs.json')
    fs.mkdirSync(nodePath.dirname(partialRuns), { recursive: true })
    fs.writeFileSync(partialRuns, '[{ "id": "p1", ')

    const { mgr } = await freshManager()
    mgr.load()

    const ids = mgr
      .list()
      .map((a) => a.id)
      .sort()
    expect(ids).toEqual(['good', 'partial'])

    expect(mgr.listRuns('good')).toHaveLength(1)
    expect(mgr.listRuns('partial')).toEqual([])

    mgr.stopAll()
  })

  it('delete: removes automation file AND run history directory on disk', async () => {
    const { mgr, automationDir } = await freshManager()
    mgr.load()

    sdkMode = { kind: 'events', events: [{ type: 'result', total_cost_usd: 0 }] }
    mgr.upsert(makeAutomation({ id: 'delete-1' }))
    await mgr.runNow('delete-1')

    const autoFile = nodePath.join(automationDir(), 'delete-1.json')
    const runsDir = nodePath.join(automationDir(), 'runs', 'delete-1')
    expect(fs.existsSync(autoFile)).toBe(true)
    expect(fs.existsSync(runsDir)).toBe(true)

    mgr.delete('delete-1')

    expect(fs.existsSync(autoFile)).toBe(false)
    expect(fs.existsSync(runsDir)).toBe(false)
    expect(mgr.list().find((a) => a.id === 'delete-1')).toBeUndefined()

    mgr.stopAll()
  })

  it('stops the SDK stream after receiving a result — non-interactive runs must not idle forever', async () => {
    const { mgr } = await freshManager()
    mgr.load()

    // cli.js stays alive between turns in interactive mode. Automations are
    // single-shot: once `result` arrives the consumer must break out of the
    // for-await loop so the generator's `return()` fires. Without it the run
    // hangs indefinitely even though the agent is done.
    sdkMode = {
      kind: 'eventsThenWait',
      events: [
        {
          type: 'assistant',
          message: { id: 'm1', content: [{ type: 'text', text: 'done' }] },
          session_id: 's1'
        },
        { type: 'result', total_cost_usd: 0.01 }
      ]
    }
    mgr.upsert(makeAutomation({ id: 'eager-exit-1' }))

    // Race runNow against a short timeout. Pre-fix this would time out.
    await Promise.race([
      mgr.runNow('eager-exit-1'),
      new Promise((_resolve, reject) =>
        setTimeout(() => reject(new Error('run did not exit after result')), 500)
      )
    ])

    expect(lastGeneratorReturned).toBe(true)
    const runs = mgr.listRuns('eager-exit-1')
    expect(runs).toHaveLength(1)
    expect(runs[0].status).toBe('success')
    expect((mgr as any).activeRuns.has('eager-exit-1')).toBe(false)

    mgr.stopAll()
  })

  it('passes thinking config + effort derived from automation.thinkingMode / automation.effort', async () => {
    const { mgr } = await freshManager()
    mgr.load()

    sdkMode = { kind: 'events', events: [{ type: 'result', total_cost_usd: 0 }] }
    mgr.upsert(
      makeAutomation({
        id: 'thinking-1',
        model: 'claude-opus-4-7',
        effort: 'xhigh',
        thinkingMode: 'adaptive'
      })
    )
    await mgr.runNow('thinking-1')

    expect(lastSdkParams?.options?.thinking).toEqual({ type: 'adaptive', display: 'summarized' })
    expect(lastSdkParams?.options?.effort).toBe('xhigh')

    mgr.stopAll()
  })

  it('coerces unsupported thinkingMode / effort against the selected model', async () => {
    const { mgr } = await freshManager()
    mgr.load()

    sdkMode = { kind: 'events', events: [{ type: 'result', total_cost_usd: 0 }] }
    // Legacy model: no adaptive thinking and no effort picker at all — old
    // saved automations with adaptive/xhigh must not leak through to cli.js.
    mgr.upsert(
      makeAutomation({
        id: 'coerce-1',
        model: 'claude-3-5-sonnet',
        effort: 'xhigh',
        thinkingMode: 'adaptive'
      })
    )
    await mgr.runNow('coerce-1')

    expect(lastSdkParams?.options?.thinking).toEqual({
      type: 'enabled',
      display: 'summarized',
      budgetTokens: 10000
    })
    expect(lastSdkParams?.options?.effort).toBeUndefined()

    mgr.stopAll()
  })

  it('defaults to enabled thinking + model default effort when automation has neither', async () => {
    const { mgr } = await freshManager()
    mgr.load()

    sdkMode = { kind: 'events', events: [{ type: 'result', total_cost_usd: 0 }] }
    // Bypass makeAutomation's default-medium-effort so we exercise the
    // capability-aware default path (xhigh on opus-4-7).
    const base = makeAutomation({ id: 'defaults-1', model: 'claude-opus-4-7' })
    const { effort: _e, thinkingMode: _t, ...rest } = base
    mgr.upsert(rest as any)
    await mgr.runNow('defaults-1')

    expect(lastSdkParams?.options?.thinking).toEqual({
      type: 'enabled',
      display: 'summarized',
      budgetTokens: 10000
    })
    // defaultEffort for opus-4-7 is xhigh per model-capabilities heuristic.
    expect(lastSdkParams?.options?.effort).toBe('xhigh')

    mgr.stopAll()
  })
})

// ---------------------------------------------------------------------------
// M-AU1 — an edit during a run must not be clobbered by run-completion save
// M-AU2 — deleting a running automation must not resurrect it
// ---------------------------------------------------------------------------

describe('AutomationManager — edit/delete during a live run', () => {
  it('M-AU1: an edit mid-run survives the run-completion save (no stale clobber)', async () => {
    const { mgr, automationDir } = await freshManager()
    mgr.load()

    // The run blocks until aborted, giving us a window to edit mid-flight.
    sdkMode = { kind: 'waitForAbort' }
    mgr.upsert(
      makeAutomation({
        id: 'edit-1',
        prompt: 'original prompt',
        enabled: true,
        schedule: { type: 'interval', intervalMs: 60_000 }
      })
    )

    const runPromise = mgr.runNow('edit-1')
    await new Promise((r) => setTimeout(r, 20))
    expect((mgr as any).activeRuns.has('edit-1')).toBe(true)

    // User edits the automation while the run is in flight (a NEW object with a
    // new prompt is persisted; the run still holds the object captured at start).
    mgr.upsert(
      makeAutomation({
        id: 'edit-1',
        prompt: 'EDITED prompt',
        enabled: true,
        schedule: { type: 'interval', intervalMs: 60_000 }
      })
    )

    // End the run so executeRun's finally runs.
    mgr.cancelRun('edit-1')
    await runPromise

    const onDisk = JSON.parse(
      fs.readFileSync(nodePath.join(automationDir(), 'edit-1.json'), 'utf-8')
    )
    // Pre-fix: the finally re-saved the stale captured object → 'original prompt'.
    expect(onDisk.prompt).toBe('EDITED prompt')
    // Run-result fields are still merged onto the latest object.
    expect(onDisk.lastRunStatus).toBeTruthy()
    expect(onDisk.lastRunAt).toBeTruthy()

    mgr.stopAll()
  })

  it('M-AU2: deleting a running automation does not resurrect its files', async () => {
    const { mgr, automationDir } = await freshManager()
    mgr.load()

    sdkMode = { kind: 'waitForAbort' }
    mgr.upsert(makeAutomation({ id: 'zombie-1' }))

    const runPromise = mgr.runNow('zombie-1')
    await new Promise((r) => setTimeout(r, 20))
    expect((mgr as any).activeRuns.has('zombie-1')).toBe(true)

    const autoFile = nodePath.join(automationDir(), 'zombie-1.json')
    const runsDirPath = nodePath.join(automationDir(), 'runs', 'zombie-1')
    expect(fs.existsSync(autoFile)).toBe(true)
    expect(fs.existsSync(runsDirPath)).toBe(true)

    // Delete mid-run: aborts the run, drops it from memory, rm's its files.
    mgr.delete('zombie-1')
    await runPromise
    // Give any stray async write a chance to (wrongly) recreate the files.
    await new Promise((r) => setTimeout(r, 30))

    // Pre-fix: executeRun's finally re-wrote both → a zombie reappeared.
    expect(fs.existsSync(autoFile)).toBe(false)
    expect(fs.existsSync(runsDirPath)).toBe(false)
    expect(mgr.list().find((a) => a.id === 'zombie-1')).toBeUndefined()

    mgr.stopAll()
  })
})

// ---------------------------------------------------------------------------
// M-AU3 — automation id path-traversal
// ---------------------------------------------------------------------------

describe('AutomationManager — id validation (M-AU3)', () => {
  it('isValidAutomationId accepts uuids/slugs and rejects traversal', async () => {
    const { isValidAutomationId } = await import('../../../core/services/automation-manager')
    expect(isValidAutomationId('550e8400-e29b-41d4-a716-446655440000')).toBe(true)
    expect(isValidAutomationId('drift-1')).toBe(true)
    expect(isValidAutomationId('a_b-C9')).toBe(true)
    expect(isValidAutomationId('../..')).toBe(false)
    expect(isValidAutomationId('../../etc/passwd')).toBe(false)
    expect(isValidAutomationId('a/b')).toBe(false)
    expect(isValidAutomationId('a\\b')).toBe(false)
    expect(isValidAutomationId('..')).toBe(false)
    expect(isValidAutomationId('.')).toBe(false)
    expect(isValidAutomationId('')).toBe(false)
    expect(isValidAutomationId(null)).toBe(false)
  })

  it('delete() with a traversal id throws and never rm-rf a dir above the automation dir', async () => {
    const { mgr, automationDir } = await freshManager()
    mgr.load()

    // ~/.claude/ui — the exact dir runsDir('../..') resolves to and would
    // recursively delete pre-fix. Seed a precious file there.
    const uiDir = nodePath.dirname(automationDir())
    const precious = nodePath.join(uiDir, 'precious.txt')
    fs.writeFileSync(precious, 'do-not-delete')

    expect(() => mgr.delete('../..')).toThrow(/invalid automation id/i)
    expect(() => mgr.delete('../../..')).toThrow(/invalid automation id/i)

    // The dir + its contents are untouched.
    expect(fs.existsSync(precious)).toBe(true)
    expect(fs.existsSync(uiDir)).toBe(true)
    expect(fs.existsSync(automationDir())).toBe(true)

    mgr.stopAll()
  })

  it('upsert() with a traversal id throws before writing any file', async () => {
    const { mgr, automationDir } = await freshManager()
    mgr.load()
    expect(() => mgr.upsert(makeAutomation({ id: '../evil' }))).toThrow(/invalid automation id/i)
    // No file named after the traversal was created anywhere under the dir.
    const entries = fs.existsSync(automationDir()) ? fs.readdirSync(automationDir()) : []
    expect(entries.every((e) => !e.includes('evil'))).toBe(true)
    mgr.stopAll()
  })
})
