/** @vitest-environment node */
import { describe, expect, it, vi } from 'vitest'
import type { HarnessId } from '../../../shared/harness-types'
import { watchHarnessArrivals } from '../arrivals'

function resolver(initial: Partial<Record<HarnessId, boolean>>) {
  const runs = { ...initial }
  let listener: ((id: HarnessId) => void) | null = null
  const unsubscribe = vi.fn()
  return {
    runs,
    deps: {
      runs: (id: HarnessId) => runs[id] === true,
      subscribe: (fn: (id: HarnessId) => void) => {
        listener = fn
        return unsubscribe
      }
    },
    change: (id: HarnessId) => listener?.(id),
    unsubscribe
  }
}

describe('watchHarnessArrivals (ADR-082 §8, S7d)', () => {
  it('fires only on a real not-running → running transition of a watched harness', () => {
    const r = resolver({ pi: false, opencode: true })
    const arrived = vi.fn()
    const stop = watchHarnessArrivals(['pi', 'opencode'], arrived, r.deps)

    r.change('pi') // still not running
    r.change('opencode') // already ran at subscribe time
    expect(arrived).not.toHaveBeenCalled()

    r.runs.pi = true
    r.change('pi')
    r.change('pi') // an invalidation with no change
    expect(arrived).toHaveBeenCalledTimes(1)
    expect(arrived).toHaveBeenCalledWith('pi')

    // Leaving and coming back is a second arrival.
    r.runs.opencode = false
    r.change('opencode')
    r.runs.opencode = true
    r.change('opencode')
    expect(arrived).toHaveBeenLastCalledWith('opencode')
    expect(arrived).toHaveBeenCalledTimes(2)

    stop()
    expect(r.unsubscribe).toHaveBeenCalled()
  })

  it('ignores a harness it does not watch', () => {
    const r = resolver({ codex: false })
    const arrived = vi.fn()
    watchHarnessArrivals(['pi'], arrived, r.deps)
    r.runs.codex = true
    r.change('codex')
    expect(arrived).not.toHaveBeenCalled()
  })
})
