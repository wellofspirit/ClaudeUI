/**
 * @vitest-environment node
 *
 * The GENERIC step-up gate (ADR-054 series 2).
 *
 * ADR-052 could refuse exactly one surface for staleness, so one component owned
 * the cure. ADR-054 made the refusal general — the settings verbs on every tier,
 * and every mutation under `strong` — so the cure moved to the invoke path
 * itself. What this file pins is the behavior that makes that safe to install
 * under ~80 call sites that know nothing about it: one ceremony for however many
 * refusals are in flight, exactly one retry, and the ORIGINAL error on refusal.
 */

import { describe, it, expect, vi } from 'vitest'
import { createStepUpGate } from '../step-up-gate'
import {
  NEEDS_SETTINGS_SESSION_ERROR,
  NEEDS_STEP_UP_ERROR
} from '../../shared/remote-protocol'

/** An attempt that fails with `needs-step-up` the first `failures` times. */
function flaky(failures: number): { attempt: () => Promise<string>; calls: () => number } {
  let calls = 0
  return {
    attempt: async () => {
      calls++
      if (calls <= failures) throw new Error(NEEDS_STEP_UP_ERROR)
      return 'ok'
    },
    calls: () => calls
  }
}

/** Wait a macrotask, so pending promise chains settle. */
const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0))

/** Start an intercept whose outcome this test does not assert on. */
function fireAndForget(p: Promise<unknown>): void {
  void p.catch(() => {})
}

describe('createStepUpGate', () => {
  it('forwards a successful invoke untouched and never opens a demand', async () => {
    const gate = createStepUpGate()
    const seen: unknown[] = []
    gate.subscribe((d) => seen.push(d))
    await expect(gate.intercept('session:send', async () => 'fine')).resolves.toBe('fine')
    expect(seen).toEqual([null])
  })

  it('passes NON-step-up errors straight through', async () => {
    // The gate must not become a catch-all: a permission denial, a validation
    // failure or a timeout is not curable by proving presence, and prompting for
    // a biometric because a git push failed would be nonsense.
    const gate = createStepUpGate()
    let demanded = false
    gate.subscribe((d) => {
      if (d) demanded = true
    })
    await expect(
      gate.intercept('git:commit', async () => {
        throw new Error('Permission denied')
      })
    ).rejects.toThrow('Permission denied')
    expect(demanded).toBe(false)
  })

  it('runs ONE ceremony and retries the original invoke once', async () => {
    const gate = createStepUpGate()
    const { attempt, calls } = flaky(1)
    const demands: (string | null)[] = []
    gate.subscribe((d) => demands.push(d?.channel ?? null))

    const result = gate.intercept('authcfg:apply', attempt)
    await tick()
    expect(demands).toEqual([null, 'authcfg:apply'])
    gate.settle(true)

    await expect(result).resolves.toBe('ok')
    expect(calls()).toBe(2)
    expect(demands.at(-1)).toBeNull()
  })

  it('rethrows the ORIGINAL refusal when the user dismisses', async () => {
    // Not a synthesised "cancelled": call sites that already branch on
    // `needs-step-up` — the terminal panel's own inline prompt — must keep
    // working unchanged when the modal is dismissed.
    const gate = createStepUpGate()
    const { attempt, calls } = flaky(1)
    const result = gate.intercept('terminal:create', attempt)
    await tick()
    gate.settle(false)
    await expect(result).rejects.toThrow(NEEDS_STEP_UP_ERROR)
    expect(calls(), 'a dismissed ceremony must not retry').toBe(1)
  })

  it('does NOT retry a second time when the retry is refused again', async () => {
    // A refusal AFTER a successful ceremony is not a freshness problem — the
    // window was just armed — so looping would hammer something a ceremony
    // cannot fix (a revoked capability, a toggle turned off).
    const gate = createStepUpGate()
    const { attempt, calls } = flaky(99)
    const result = gate.intercept('terminal:create', attempt)
    await tick()
    gate.settle(true)
    await expect(result).rejects.toThrow(NEEDS_STEP_UP_ERROR)
    expect(calls()).toBe(2)
  })

  it('queues concurrent refusals behind ONE ceremony (no prompt storms)', async () => {
    // A phone waking up fires several mutations at once and a lapsed window
    // lapsed for all of them. Beyond the annoyance, concurrent
    // `startAuthentication()` calls race the server's single-use,
    // connection-bound challenge — so the second prompt would likely also fail.
    const gate = createStepUpGate()
    let opened = 0
    gate.subscribe((d) => {
      if (d) opened++
    })
    const a = flaky(1)
    const b = flaky(1)
    const c = flaky(1)
    const all = Promise.all([
      gate.intercept('session:send', a.attempt),
      gate.intercept('git:commit', b.attempt),
      gate.intercept('config:save-settings', c.attempt)
    ])
    await tick()
    expect(opened).toBe(1)

    gate.settle(true)
    await expect(all).resolves.toEqual(['ok', 'ok', 'ok'])
    expect([a.calls(), b.calls(), c.calls()]).toEqual([2, 2, 2])
  })

  it('names the FIRST refusing channel on the demand, and only that one', async () => {
    const gate = createStepUpGate()
    let demand: string | null = null
    gate.subscribe((d) => {
      if (d) demand = d.channel
    })
    fireAndForget(gate.intercept('authcfg:apply', flaky(1).attempt))
    fireAndForget(gate.intercept('session:send', flaky(1).attempt))
    await tick()
    expect(demand).toBe('authcfg:apply')
    gate.settle(false)
  })

  it('opens a FRESH demand after one settles', async () => {
    const gate = createStepUpGate()
    const opened: string[] = []
    gate.subscribe((d) => {
      if (d) opened.push(d.channel)
    })

    const first = gate.intercept('authcfg:apply', flaky(1).attempt)
    await tick()
    gate.settle(true)
    await first

    const second = gate.intercept('terminal:create', flaky(1).attempt)
    await tick()
    expect(opened).toEqual(['authcfg:apply', 'terminal:create'])
    gate.settle(false)
    await expect(second).rejects.toThrow(NEEDS_STEP_UP_ERROR)
  })

  it('`request()` opens a ceremony with no refusal behind it — the keystroke path', async () => {
    // The server drops a stale `term-input` frame SILENTLY (an error would be an
    // oracle for which terminals exist), so the read-only terminal has to ask on
    // the first key itself rather than react to a refusal.
    const gate = createStepUpGate()
    const opened: string[] = []
    gate.subscribe((d) => {
      if (d) opened.push(d.channel)
    })
    const asked = gate.request('terminal:write')
    await tick()
    expect(opened).toEqual(['terminal:write'])
    gate.settle(true)
    await expect(asked).resolves.toBe(true)
  })

  it('`request()` joins the SAME ceremony an invoke refusal opened', async () => {
    const gate = createStepUpGate()
    let opened = 0
    gate.subscribe((d) => {
      if (d) opened++
    })
    const { attempt } = flaky(1)
    const invoked = gate.intercept('terminal:create', attempt)
    await tick()
    const asked = gate.request('terminal:write')
    await tick()
    expect(opened).toBe(1)
    gate.settle(true)
    await expect(asked).resolves.toBe(true)
    await expect(invoked).resolves.toBe('ok')
  })

  it('settle() with nothing pending is a harmless no-op', () => {
    const gate = createStepUpGate()
    const cb = vi.fn()
    gate.subscribe(cb)
    cb.mockClear()
    gate.settle(true)
    gate.settle(false)
    expect(cb).not.toHaveBeenCalled()
  })

  it('publishes the current demand to a LATE subscriber', async () => {
    // The React overlay mounts after the connection exists, so a demand raised
    // by the very first invoke would be invisible to a subscriber that only
    // heard about future changes.
    const gate = createStepUpGate()
    fireAndForget(gate.intercept('authcfg:apply', flaky(1).attempt))
    await tick()
    const seen: (string | null)[] = []
    gate.subscribe((d) => seen.push(d?.channel ?? null))
    expect(seen).toEqual(['authcfg:apply'])
    gate.settle(false)
  })
})

describe('the settings editor is NEVER cured ambiently (ADR-054 §6 amendment)', () => {
  it('passes `needs-settings-session` straight through, opening no ceremony', async () => {
    // THE distinction the amendment turns on. `needs-step-up` means "prove
    // presence and I will retry what you asked for" — which is exactly what the
    // gate does, ambiently. Opening the settings editor must never work that
    // way: a stale pane firing a save would raise a biometric prompt nobody
    // asked for, and a tap would silently re-enter the administering mode the
    // amendment exists to bound.
    const gate = createStepUpGate()
    let demanded = false
    gate.subscribe((d) => {
      if (d) demanded = true
    })
    let calls = 0
    await expect(
      gate.intercept('authcfg:apply', async () => {
        calls++
        throw new Error(NEEDS_SETTINGS_SESSION_ERROR)
      })
    ).rejects.toThrow(NEEDS_SETTINGS_SESSION_ERROR)

    expect(demanded, 'no ceremony may be opened for a locked editor').toBe(false)
    expect(calls, 'and nothing may be retried').toBe(1)
  })

  it('still cures an ordinary `needs-step-up` on the SAME namespace', async () => {
    // The two are not "authcfg is exempt": the class of refusal decides, not the
    // channel. A settings verb refused for staleness of PRESENCE (it cannot be,
    // today — but the gate must not encode that assumption) is still curable.
    const gate = createStepUpGate()
    const { attempt, calls } = flaky(1)
    const result = gate.intercept('authcfg:apply', attempt)
    await tick()
    gate.settle(true)
    await expect(result).resolves.toBe('ok')
    expect(calls()).toBe(2)
  })
})
