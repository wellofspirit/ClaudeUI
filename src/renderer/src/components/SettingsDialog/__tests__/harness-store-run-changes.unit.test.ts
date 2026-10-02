/**
 * Layer 1: `harnessStore.followRunChanges` (ADR-082 §8) — the harness store,
 * which every client surface reads, says which harnesses now run as a
 * different binary, whatever moved the snapshot: a re-read after
 * `harness:changed`, or a selection write's answer. The session store follows
 * it to reload models; here a spy does, so what is guarded is exactly when the
 * store calls.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  HarnessId,
  HarnessStateEntry,
  HarnessStateSnapshot
} from '../../../../../shared/harness-types'
import { harnessStore } from '../harness-store'

function entry(id: HarnessId, revision: string, available = true): HarnessStateEntry {
  return {
    id,
    manifest: { tested: '1.0.0', floor: '1.0.0', ceiling: '9.0.0' },
    selection: { source: 'system' },
    resolved: {
      source: 'system',
      version: available ? '1.0.0' : null,
      path: available ? `/usr/local/bin/${id}` : null,
      available,
      revision
    },
    system: { detectedAt: null, installs: [], choice: { kind: 'fallback', reason: 'none' } },
    managed: [],
    installable: id !== 'claude'
  }
}

function snapshot(
  revisions: Partial<Record<HarnessId, string>> = {},
  missing: HarnessId[] = []
): HarnessStateSnapshot {
  const of = (id: HarnessId): HarnessStateEntry =>
    entry(id, revisions[id] ?? `${id}-r1`, !missing.includes(id))
  return {
    harnesses: { claude: of('claude'), opencode: of('opencode'), pi: of('pi'), codex: of('codex') },
    detection: { running: false },
    installs: [],
    updates: { mode: 'ask', available: [], status: { running: false, results: [] } },
    upgradePrompt: { pending: false, candidates: [] }
  }
}

let state: HarnessStateSnapshot
let follower: ReturnType<typeof vi.fn<(changed: HarnessId[]) => void>>

beforeEach(() => {
  harnessStore.resetForTests()
  state = snapshot()
  ;(window as unknown as { api: Record<string, unknown> }).api = {
    harnessState: async () => state,
    setHarnessSelection: async (id: HarnessId) => state.harnesses[id]
  }
  follower = vi.fn()
  harnessStore.followRunChanges(follower)
})
afterEach(() => {
  harnessStore.followRunChanges(null)
  harnessStore.resetForTests()
})

async function read(next: HarnessStateSnapshot): Promise<void> {
  state = next
  await harnessStore.refresh()
}

describe('harnessStore.followRunChanges', () => {
  it('the first snapshot is no change', async () => {
    await read(snapshot())
    expect(follower).not.toHaveBeenCalled()
  })

  it('a System pi upgraded in place — same path, same stated version — is a change', async () => {
    await read(snapshot())
    await read(snapshot({ pi: 'pi-r2' }))
    expect(state.harnesses.pi.resolved.path).toBe('/usr/local/bin/pi')
    expect(follower).toHaveBeenCalledTimes(1)
    expect(follower).toHaveBeenCalledWith(['pi'])
  })

  it('a re-read that moved nothing (a detection run) is no change', async () => {
    await read(snapshot())
    await read(snapshot())
    await read(snapshot())
    expect(follower).not.toHaveBeenCalled()
  })

  it('an uninstall is a change, and so is the install that brings it back', async () => {
    await read(snapshot())
    await read(snapshot({}, ['opencode']))
    await read(snapshot())
    expect(follower.mock.calls).toEqual([[['opencode']], [['opencode']]])
  })

  it('a selection write whose answer runs another binary is a change, once', async () => {
    await read(snapshot())
    state = snapshot({ opencode: 'opencode-r2' })
    await harnessStore.setSelection('opencode', { source: 'system' })
    // The `harness:changed` re-read that follows the write moves nothing more.
    await harnessStore.refresh()
    expect(follower.mock.calls).toEqual([[['opencode']]])
  })

  it('a change while nobody watched is still one on the next read', async () => {
    const off = harnessStore.subscribe(() => {})
    await read(snapshot())
    off()
    await read(snapshot({ codex: 'codex-r2' }))
    expect(follower).toHaveBeenCalledWith(['codex'])
  })
})
