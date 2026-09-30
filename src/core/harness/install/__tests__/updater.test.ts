/**
 * @vitest-environment node
 *
 * Harness updates (ADR-082 §6): what counts as an update (`computeUpdates`),
 * and the updater service: the boot check and the six-hour timer, Automatically
 * installing each update and recording failures, Ask me installing nothing,
 * `onChanged` only on a change, one run at a time, and the disable switch.
 * Upstream, the installer, the selections and the store are injected; nothing
 * here reaches the network.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import type {
  HarnessId,
  HarnessInstallResult,
  HarnessSelection,
  HarnessUpdateMode
} from '../../../../shared/harness-types'
import { DISABLE_DETECTION_ENV } from '../../detect/scheduler'
import {
  UPDATE_CHECK_INTERVAL_MS,
  USER_CHECK_MAX_AGE_MS,
  computeUpdates,
  createHarnessUpdater,
  startHarnessUpdater,
  type HarnessUpdaterDeps,
  type UpdateInputs
} from '../updater'

vi.mock('../../../services/logger', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }
}))

// ── computeUpdates ────────────────────────────────────────────────────────────

const TESTED: UpdateInputs['tested'] = {
  claude: '2.1.280',
  opencode: '1.18.32',
  pi: '0.87.4',
  codex: '0.156.0'
}

function inputs(patch: Partial<UpdateInputs>): UpdateInputs {
  return { selections: {}, installed: {}, tested: TESTED, latest: {}, ...patch }
}

const managed = (version: string): HarnessSelection => ({ source: 'managed', version })

describe('computeUpdates', () => {
  it.each([
    ['latest newer than the newest installed', '1.18.41', ['1.18.40'], ['1.18.40', '1.18.41']],
    ['latest equal to the newest installed', '1.18.40', ['1.18.40'], null],
    ['latest older than the newest installed', '1.18.39', ['1.18.40'], null],
    [
      'the newest installed, whatever the order',
      '1.18.41',
      ['1.18.35', '1.18.40', '1.18.2'],
      ['1.18.40', '1.18.41']
    ],
    ['latest not known yet', null, ['1.18.40'], null]
  ])('Latest: %s', (_label, latest, installed, expected) => {
    const updates = computeUpdates(
      inputs({
        selections: { opencode: managed('latest') },
        installed: { opencode: installed },
        latest: { opencode: latest }
      })
    )
    expect(updates).toEqual(
      expected ? [{ id: 'opencode', from: expected[0], to: expected[1], choice: 'latest' }] : []
    )
  })

  it('Tested: the manifest moved past the newest installed (a ClaudeUI update)', () => {
    expect(
      computeUpdates(
        inputs({ selections: { pi: managed('tested') }, installed: { pi: ['0.87.1'] } })
      )
    ).toEqual([{ id: 'pi', from: '0.87.1', to: '0.87.4', choice: 'tested' }])
    // A selection without a version is Tested.
    expect(
      computeUpdates(
        inputs({ selections: { pi: { source: 'managed' } }, installed: { pi: ['0.87.1'] } })
      )
    ).toEqual([{ id: 'pi', from: '0.87.1', to: '0.87.4', choice: 'tested' }])
    // Already there, or something newer is installed: nothing.
    expect(
      computeUpdates(
        inputs({ selections: { pi: managed('tested') }, installed: { pi: ['0.87.4'] } })
      )
    ).toEqual([])
    expect(
      computeUpdates(
        inputs({ selections: { pi: managed('tested') }, installed: { pi: ['0.88.0'] } })
      )
    ).toEqual([])
  })

  it('an exact version never updates', () => {
    expect(
      computeUpdates(
        inputs({
          selections: { opencode: managed('1.18.35') },
          installed: { opencode: ['1.18.35'] },
          latest: { opencode: '1.18.41' }
        })
      )
    ).toEqual([])
  })

  it('a System selection never counts, even with a ClaudeUI version kept for switching back', () => {
    expect(
      computeUpdates(
        inputs({
          selections: {
            opencode: { source: 'system', version: 'latest' },
            pi: { source: 'system', version: 'tested' }
          },
          installed: { opencode: ['1.18.35'], pi: ['0.87.1'] },
          latest: { opencode: '1.18.41' }
        })
      )
    ).toEqual([])
  })

  it('Codex counts for Tested, its one choice: a release that moves the pin offers it', () => {
    const codex = (installed: string[], selection = managed('tested')) =>
      computeUpdates(inputs({ selections: { codex: selection }, installed: { codex: installed } }))
    expect(codex(['0.150.0'])).toEqual([
      { id: 'codex', from: '0.150.0', to: '0.156.0', choice: 'tested' }
    ])
    // A selection without a version is Tested.
    expect(codex(['0.150.0'], { source: 'managed' })).toEqual([
      { id: 'codex', from: '0.150.0', to: '0.156.0', choice: 'tested' }
    ])
    expect(codex(['0.150.0', '0.156.0'])).toEqual([])
    // Nothing installed is a first install, not an update; System updates itself.
    expect(codex([])).toEqual([])
    expect(codex(['0.150.0'], { source: 'system', version: 'tested' })).toEqual([])
  })

  it('Codex never follows Latest, even saved as Latest', () => {
    expect(
      computeUpdates(
        inputs({
          selections: { codex: managed('latest') },
          installed: { codex: ['0.150.0'] },
          latest: { codex: '0.160.0' }
        })
      )
    ).toEqual([])
  })

  it('Claude Code never counts: its bundled copy moves with ClaudeUI releases', () => {
    expect(
      computeUpdates(
        inputs({
          selections: { claude: managed('tested') },
          installed: { claude: ['2.1.270'] },
          latest: { claude: '2.1.290' }
        })
      )
    ).toEqual([])
  })

  it('nothing installed is not an update: a first install is not', () => {
    expect(
      computeUpdates(
        inputs({
          selections: { opencode: managed('latest'), pi: managed('tested') },
          installed: { opencode: [], pi: [] },
          latest: { opencode: '1.18.41' }
        })
      )
    ).toEqual([])
  })

  it('ignores an upstream answer that is not a version', () => {
    expect(
      computeUpdates(
        inputs({
          selections: { opencode: managed('latest') },
          installed: { opencode: ['1.18.40'] },
          latest: { opencode: '../../evil' }
        })
      )
    ).toEqual([])
  })
})

// ── The service ───────────────────────────────────────────────────────────────

interface World {
  selections: Partial<Record<HarnessId, HarnessSelection>>
  store: Partial<Record<HarnessId, string[]>>
  latest: Partial<Record<HarnessId, string | null>>
  mode: HarnessUpdateMode
}

/** An updater over a small in-memory world; `install` adds the version to the store. */
function setup(world: Partial<World> = {}, extra: Partial<HarnessUpdaterDeps> = {}) {
  const w: World = {
    selections: { opencode: managed('latest'), pi: managed('tested') },
    store: { opencode: ['1.18.40'], pi: ['0.87.1'] },
    latest: { opencode: '1.18.41' },
    mode: 'ask',
    ...world
  }
  const latestVersion = vi.fn(
    async (id: HarnessId, _opts?: { maxAgeMs?: number }) => w.latest[id] ?? null
  )
  const install = vi.fn(async (id: HarnessId, version: string): Promise<HarnessInstallResult> => {
    w.store[id] = [...(w.store[id] ?? []), version]
    return { status: 'installed', id, version, verified: 'publisher' }
  })
  const changes: HarnessId[][] = []
  let clock = Date.parse('2026-09-30T00:00:00.000Z')
  const updater = createHarnessUpdater({
    latestVersion,
    install,
    selection: (id) => w.selections[id] ?? { source: 'managed', version: 'tested' },
    installed: (id) => [...(w.store[id] ?? [])],
    tested: (id) => TESTED[id]!,
    mode: () => w.mode,
    now: () => new Date((clock += 1000)),
    ...extra
  })
  updater.onChanged((ids) => changes.push(ids))
  return { w, updater, latestVersion, install, changes }
}

afterEach(() => {
  vi.useRealTimers()
})

describe('the check', () => {
  it('asks upstream only for harnesses on Latest with something installed', async () => {
    const { updater, latestVersion } = setup({
      selections: {
        opencode: managed('latest'),
        pi: managed('latest'),
        // Codex has no Latest: upstream is never asked for it.
        codex: managed('latest')
      },
      store: { opencode: ['1.18.40'], pi: [], codex: ['0.156.0'] }
    })
    await updater.check('boot')
    expect(latestVersion.mock.calls.map(([id]) => id)).toEqual(['opencode'])
    // A background check takes the usual cache; "Check now" a younger answer.
    expect(latestVersion.mock.calls[0][1]).toBeUndefined()
    await updater.check('user')
    expect(latestVersion).toHaveBeenLastCalledWith('opencode', { maxAgeMs: USER_CHECK_MAX_AGE_MS })
  })

  it('finds the updates, stamps lastCheckedAt, and computes the set from memory on every read', async () => {
    const { w, updater, latestVersion } = setup()
    expect(updater.status().lastCheckedAt).toBeUndefined()
    // Before a check, Latest knows no upstream version; Tested needs none.
    expect(updater.available()).toEqual([
      { id: 'pi', from: '0.87.1', to: '0.87.4', choice: 'tested' }
    ])
    await updater.check('boot')
    expect(updater.available()).toEqual([
      { id: 'opencode', from: '1.18.40', to: '1.18.41', choice: 'latest' },
      { id: 'pi', from: '0.87.1', to: '0.87.4', choice: 'tested' }
    ])
    expect(updater.status().lastCheckedAt).toBeDefined()
    // An install elsewhere (the Installed page) moves the set without a check.
    const calls = latestVersion.mock.calls.length
    w.store.opencode!.push('1.18.41')
    expect(updater.view()).toMatchObject({
      mode: 'ask',
      available: [{ id: 'pi' }],
      status: { running: false, results: [] }
    })
    expect(latestVersion.mock.calls.length).toBe(calls)
  })

  it('keeps the last good upstream answer when a check fails', async () => {
    const { w, updater } = setup()
    await updater.check('boot')
    w.latest.opencode = null
    await updater.check('timer')
    expect(updater.available().map((u) => u.to)).toContain('1.18.41')
  })

  it('emits harness ids only when their update entry changed', async () => {
    const { w, updater, changes } = setup({
      selections: { opencode: managed('latest') },
      store: { opencode: ['1.18.40'] }
    })
    await updater.check('boot')
    expect(changes).toEqual([['opencode']])
    await updater.check('timer')
    expect(changes).toEqual([['opencode']])
    w.latest.opencode = '1.18.42'
    await updater.check('timer')
    expect(changes).toEqual([['opencode'], ['opencode']])
  })

  it('never rejects', async () => {
    const { updater } = setup(
      {},
      {
        latestVersion: async () => {
          throw new Error('offline')
        }
      }
    )
    await expect(updater.check('user')).resolves.toBeUndefined()
  })
})

describe('Ask me', () => {
  it('a check installs nothing', async () => {
    const { updater, install } = setup({ mode: 'ask' })
    await updater.check('boot')
    await updater.idle()
    expect(install).not.toHaveBeenCalled()
    expect(updater.status().running).toBe(false)
  })

  it('updateAll installs every available update, one at a time, and records the outcome', async () => {
    const { updater, install, changes } = setup()
    await updater.check('boot')
    changes.length = 0
    let active = 0
    let most = 0
    install.mockImplementation(async (id, version) => {
      active++
      most = Math.max(most, active)
      await new Promise((r) => setTimeout(r, 1))
      active--
      return { status: 'installed', id, version, verified: 'publisher' }
    })
    const results = await updater.updateAll()
    expect(install.mock.calls).toEqual([
      ['opencode', '1.18.41'],
      ['pi', '0.87.4']
    ])
    expect(most).toBe(1)
    expect(results).toEqual([
      { id: 'opencode', from: '1.18.40', to: '1.18.41', status: 'installed' },
      { id: 'pi', from: '0.87.1', to: '0.87.4', status: 'installed' }
    ])
    // Start and end of the run.
    expect(changes).toEqual([
      ['opencode', 'pi'],
      ['opencode', 'pi']
    ])
    expect(updater.status()).toMatchObject({ running: false, results })
    expect(updater.status().lastRunAt).toBeDefined()
  })

  it('updateAll during a run joins it rather than installing twice', async () => {
    const { updater, install } = setup()
    let release!: () => void
    install.mockImplementationOnce(
      (id, version) =>
        new Promise((resolve) => {
          release = () => resolve({ status: 'installed', id, version, verified: 'publisher' })
        })
    )
    const first = updater.updateAll()
    await Promise.resolve()
    await Promise.resolve()
    expect(updater.status().running).toBe(true)
    const second = updater.updateAll()
    release()
    expect(await second).toEqual(await first)
    expect(install).toHaveBeenCalledTimes(1)
  })

  it('updateAll with nothing available installs nothing', async () => {
    const { updater, install } = setup({ store: { opencode: [], pi: ['0.87.4'] } })
    await expect(updater.updateAll()).resolves.toEqual([])
    expect(install).not.toHaveBeenCalled()
  })
})

describe('Automatically', () => {
  it('a check installs each update and records a failure without stopping the rest', async () => {
    const { updater, install } = setup({ mode: 'auto' })
    install.mockImplementation(async (id, version) =>
      id === 'opencode'
        ? { status: 'failed', id, version, reason: 'checksum mismatch' }
        : { status: 'installed', id, version, verified: 'reviewed' }
    )
    await updater.check('boot')
    await updater.idle()
    expect(install.mock.calls.map(([id]) => id)).toEqual(['opencode', 'pi'])
    expect(updater.status().results).toEqual([
      {
        id: 'opencode',
        from: '1.18.40',
        to: '1.18.41',
        status: 'failed',
        reason: 'checksum mismatch'
      },
      { id: 'pi', from: '0.87.1', to: '0.87.4', status: 'installed' }
    ])
  })

  it('an installer that throws is a failure, not a crash', async () => {
    const { updater, install } = setup({ mode: 'auto', selections: { pi: managed('tested') } })
    install.mockImplementation(() => {
      throw new Error('boom')
    })
    await updater.check('boot')
    await updater.idle()
    expect(updater.status()).toMatchObject({
      running: false,
      results: [{ id: 'pi', status: 'failed', reason: 'boom' }]
    })
  })

  it('a failure stays until the next run, and goes once that version is installed some other way', async () => {
    const { w, updater, install } = setup({ mode: 'auto', selections: { pi: managed('tested') } })
    install.mockResolvedValueOnce({
      status: 'failed',
      id: 'pi',
      version: '0.87.4',
      reason: 'offline'
    })
    await updater.check('boot')
    await updater.idle()
    expect(updater.status().results).toHaveLength(1)
    w.store.pi!.push('0.87.4')
    expect(updater.status().results).toEqual([])
  })

  it('switching to Automatically installs what is available now', async () => {
    const { w, updater, install, changes } = setup({
      mode: 'ask',
      selections: { pi: managed('tested') }
    })
    w.mode = 'auto'
    updater.modeChanged()
    await updater.idle()
    expect(install).toHaveBeenCalledWith('pi', '0.87.4')
    // Every updatable harness is nudged for the mode itself.
    expect(changes[0]).toEqual(['opencode', 'pi', 'codex'])
  })
})

describe('the schedule', () => {
  it('checks at start and every six hours, on an unref-able timer', async () => {
    vi.useFakeTimers()
    const { updater, latestVersion } = setup()
    const stop = updater.start()
    await vi.advanceTimersByTimeAsync(0)
    expect(latestVersion).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(UPDATE_CHECK_INTERVAL_MS - 1)
    expect(latestVersion).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(latestVersion).toHaveBeenCalledTimes(2)
    stop()
    await vi.advanceTimersByTimeAsync(UPDATE_CHECK_INTERVAL_MS * 2)
    expect(latestVersion).toHaveBeenCalledTimes(2)
  })

  it('startHarnessUpdater arms nothing under the disable switch', () => {
    expect(process.env[DISABLE_DETECTION_ENV]).toBe('1')
    vi.useFakeTimers()
    const stop = startHarnessUpdater()
    expect(vi.getTimerCount()).toBe(0)
    stop()
  })

  it('startHarnessUpdater arms the six-hour timer without the switch', () => {
    const saved = process.env[DISABLE_DETECTION_ENV]
    delete process.env[DISABLE_DETECTION_ENV]
    vi.useFakeTimers()
    try {
      const stop = startHarnessUpdater()
      expect(vi.getTimerCount()).toBe(1)
      stop()
      expect(vi.getTimerCount()).toBe(0)
    } finally {
      process.env[DISABLE_DETECTION_ENV] = saved
    }
  })
})
