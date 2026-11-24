/**
 * Layer 1: the Updates panel's pure reading of the host's state — which
 * ClaudeUI row shows and what it offers, the harness rows, the footer
 * button's state (mockup tabs A–E), and "Later".
 */
import { describe, expect, it } from 'vitest'
import type { HarnessInstallProgress } from '../../../../../shared/harness-types'
import {
  appLaterKey,
  appSection,
  buildLine,
  checkedAgo,
  formatElapsed,
  harnessUpdateRows,
  impactLines,
  isLater,
  otherInstallRows,
  rebuildLaterKey,
  shortVersion,
  treeLabel,
  updatesButtonModel,
  type HarnessRowsInput
} from '../utils'
import {
  CHECKED,
  TREES,
  appView,
  buildingView,
  harnessView,
  localView,
  stagedView
} from './fixtures'

const NO_LATER = {}

describe('versions', () => {
  it('shortens a pre-release sharing its base with the running version', () => {
    expect(shortVersion('3.9.1-pre.14', '3.9.1-pre.13')).toBe('pre.14')
    expect(shortVersion('3.9.1-pre.14', '3.9.1')).toBe('pre.14')
    expect(shortVersion('3.9.2-pre.1', '3.9.1')).toBe('3.9.2-pre.1')
    expect(shortVersion('3.9.2', '3.9.1')).toBe('3.9.2')
    expect(shortVersion('3.9.2-pre.1', null)).toBe('3.9.2-pre.1')
  })

  it('reads the running build as one line', () => {
    expect(buildLine(appView().current)).toBe('3.9.1-pre.13')
    expect(buildLine(localView().current)).toBe('Local build · e4f1a2c · uncommitted changes')
    expect(buildLine({ kind: 'dev', version: null, comparisonVersion: null })).toBe(
      'Development run'
    )
  })

  it('formats elapsed times and the last check', () => {
    expect(formatElapsed(102_000)).toBe('1:42')
    expect(formatElapsed(3_729_000)).toBe('1:02:09')
    const now = Date.parse(CHECKED)
    expect(checkedAgo(CHECKED, now + 20_000)).toBe('Checked just now')
    expect(checkedAgo(CHECKED, now + 2 * 60_000)).toBe('Checked 2 min ago')
    expect(checkedAgo(CHECKED, now + 3 * 3_600_000)).toBe('Checked 3 h ago')
    expect(checkedAgo(null, now)).toBe('Not checked yet')
  })

  it('labels a tree by worktree or main checkout, with its uncommitted count', () => {
    expect(TREES.map(treeLabel)).toEqual([
      'Worktree: auto-update · 3 uncommitted',
      'Main checkout: pre-release'
    ])
  })
})

describe('appSection', () => {
  it('nothing on offer, nothing running: no row; an unsupported host never has one', () => {
    expect(appSection(appView({ available: undefined }), { later: NO_LATER })).toBeNull()
    expect(appSection(appView({ supported: false }), { later: NO_LATER })).toBeNull()
    expect(appSection(null, { later: NO_LATER })).toBeNull()
  })

  it('A: a staged release offers Restart to update, with a pre-release chip and a short skip', () => {
    const app = appSection(stagedView(), { later: NO_LATER })
    expect(app).toMatchObject({
      kind: 'release',
      from: '3.9.1-pre.13',
      skipLabel: 'pre.14',
      release: {
        version: '3.9.1-pre.14',
        pre: true,
        claudeCodeVersion: '2.1.341',
        status: { kind: 'staged' }
      }
    })
  })

  it('follows the download: ready, downloading with bytes, failed with the reason', () => {
    const status = (patch: Parameters<typeof appView>[0]): unknown => {
      const app = appSection(appView(patch), { later: NO_LATER })
      return app?.kind === 'release' ? app.release.status : null
    }
    expect(status({})).toEqual({ kind: 'ready' })
    expect(
      status({
        download: { phase: 'downloading', version: '3.9.1-pre.14', received: 10, total: 100 }
      })
    ).toEqual({ kind: 'downloading', received: 10, total: 100 })
    expect(
      status({ download: { phase: 'failed', version: '3.9.1-pre.14', error: 'sha256 mismatch' } })
    ).toEqual({ kind: 'failed', reason: 'sha256 mismatch' })
  })

  it('an ineligible install says why before any download', () => {
    const app = appSection(
      appView({ eligibility: { ok: false, reason: "Can't update here: download manually" } }),
      { later: NO_LATER }
    )
    expect(app).toMatchObject({
      kind: 'release',
      release: { status: { kind: 'ineligible', reason: "Can't update here: download manually" } }
    })
  })

  it('a release staged before this run checked still shows', () => {
    const app = appSection(
      appView({ available: undefined, download: { phase: 'staged', version: '3.9.1-pre.14' } }),
      { later: NO_LATER }
    )
    expect(app).toMatchObject({
      kind: 'release',
      release: { version: '3.9.1-pre.14', status: { kind: 'staged' }, size: null }
    })
  })

  it('Later hides the row until the next check; the Rebuild entry still shows it', () => {
    const later = { [appLaterKey('3.9.1-pre.14')]: CHECKED }
    expect(appSection(stagedView(), { later })).toBeNull()
    expect(
      appSection(stagedView({ check: { running: false, lastCheckedAt: 'next' } }), { later })
    ).not.toBeNull()
    expect(isLater(later, appLaterKey('3.9.1-pre.14'), CHECKED)).toBe(true)
    expect(isLater(later, appLaterKey('3.9.1-pre.14'), undefined)).toBe(false)
  })

  it('C: a local build offers the two paths', () => {
    expect(appSection(localView(), { later: NO_LATER })).toMatchObject({
      kind: 'local',
      localBuild: true,
      from: 'pre.13 +5',
      commit: 'e4f1a2c',
      dirty: true,
      canRebuild: true,
      skipLabel: 'pre.14',
      release: { version: '3.9.1-pre.14' },
      rebuildError: null
    })
  })

  it('the Rebuild entry shows the local row with nothing on offer, even on a release build', () => {
    expect(appSection(localView({ available: undefined }), { later: NO_LATER })).toBeNull()
    expect(
      appSection(localView({ available: undefined }), { later: NO_LATER, rebuildIntent: true })
    ).toMatchObject({ kind: 'local', release: null, from: '3.9.1-pre.13 +5' })
    expect(
      appSection(appView({ available: undefined, rebuildAvailable: true }), {
        later: NO_LATER,
        rebuildIntent: true
      })
    ).toMatchObject({ kind: 'local', localBuild: false, from: '3.9.1-pre.13', canRebuild: true })
  })

  it('a failed rebuild shows on the local row with its reason', () => {
    const app = appSection(
      localView({
        available: undefined,
        rebuild: { phase: 'failed', startedAt: 'b1', error: 'electron-builder exited 1' }
      }),
      { later: NO_LATER }
    )
    expect(app).toMatchObject({ kind: 'local', rebuildError: 'electron-builder exited 1' })
  })

  it('D: a running build, then a built one with its commit', () => {
    expect(appSection(buildingView(), { later: NO_LATER })).toMatchObject({
      kind: 'building',
      tree: { name: 'auto-update' },
      lastLine: '• packaging platform=win32 arch=x64 electron=45.0.1'
    })
    const built = localView({
      rebuild: {
        phase: 'built',
        startedAt: 'b1',
        built: { version: '3.9.1-pre.13+6', commit: 'f00ba12' }
      }
    })
    expect(appSection(built, { later: NO_LATER })).toMatchObject({
      kind: 'built',
      commit: 'f00ba12',
      laterKey: rebuildLaterKey('b1')
    })
    expect(appSection(built, { later: { [rebuildLaterKey('b1')]: CHECKED } })?.kind).toBe('local')
  })
})

describe('harnessUpdateRows', () => {
  const input = (patch: Partial<HarnessRowsInput> = {}): HarnessRowsInput => ({
    updates: harnessView(),
    installs: [],
    dismissed: new Set(),
    completed: [],
    started: {},
    later: NO_LATER,
    ...patch
  })

  it('lists each available update in harness order', () => {
    expect(harnessUpdateRows(input()).map((r) => [r.id, r.from, r.to, r.state])).toEqual([
      ['opencode', '2.4.1', '2.5.0', 'available'],
      ['pi', '0.71.0', '0.72.1', 'available']
    ])
  })

  it('installing with progress, then this client’s failure with its reason', () => {
    const progress: HarnessInstallProgress = {
      id: 'opencode',
      version: '2.5.0',
      phase: 'downloading',
      receivedBytes: 14,
      totalBytes: 22
    }
    const failed: HarnessInstallProgress = {
      id: 'pi',
      version: '0.72.1',
      phase: 'failed',
      reason: 'Download stalled: no data for 30 s.'
    }
    const rows = harnessUpdateRows(input({ installs: [progress, failed] }))
    expect(rows[0]).toMatchObject({ id: 'opencode', state: 'installing', progress })
    expect(rows[1]).toMatchObject({
      id: 'pi',
      state: 'failed',
      reason: 'Download stalled: no data for 30 s.',
      dismiss: { kind: 'install' }
    })
  })

  it('Later hides an available update until the harnesses are checked again', () => {
    const later = { 'pi@0.72.1': CHECKED }
    expect(harnessUpdateRows(input({ later })).map((r) => r.id)).toEqual(['opencode'])
    const next = harnessView({ status: { running: false, lastCheckedAt: 'next', results: [] } })
    expect(harnessUpdateRows(input({ later, updates: next })).map((r) => r.id)).toEqual([
      'opencode',
      'pi'
    ])
  })

  it('an update this client installed shows as installed, from → to', () => {
    const rows = harnessUpdateRows(
      input({
        updates: harnessView({ available: [harnessView().available[1]] }),
        completed: [{ id: 'opencode', version: '2.5.0' }],
        started: { 'opencode@2.5.0': '2.4.1' }
      })
    )
    expect(rows[0]).toEqual({ id: 'opencode', from: '2.4.1', to: '2.5.0', state: 'installed' })
  })

  it('an Automatically run: results, then the rest waiting; a dismissed failure is gone', () => {
    const updates = harnessView({
      mode: 'auto',
      status: {
        running: true,
        lastRunAt: 'run1',
        results: [{ id: 'opencode', from: '2.4.1', to: '2.5.0', status: 'installed' }]
      }
    })
    expect(harnessUpdateRows(input({ updates })).map((r) => r.state)).toEqual([
      'installed',
      'waiting'
    ])
    const failed = harnessView({
      available: [],
      status: {
        running: false,
        lastRunAt: 'run1',
        results: [{ id: 'pi', from: '0.71.0', to: '0.72.1', status: 'failed', reason: 'x' }]
      }
    })
    expect(harnessUpdateRows(input({ updates: failed }))[0]).toMatchObject({
      state: 'failed',
      dismiss: { kind: 'result', key: 'pi@0.72.1@run1' }
    })
    expect(
      harnessUpdateRows(input({ updates: failed, dismissed: new Set(['pi@0.72.1@run1']) }))
    ).toEqual([])
  })

  it('install rows leave out what an update row already shows', () => {
    const updates = harnessView({ available: [] })
    const completed = [
      { id: 'opencode' as const, version: '2.5.0' },
      { id: 'pi' as const, version: '0.70.0' }
    ]
    const rows = harnessUpdateRows(
      input({ updates, completed, started: { 'opencode@2.5.0': '2.4.1' } })
    )
    expect(rows.map((r) => r.id)).toEqual(['opencode'])
    const others = otherInstallRows(updates, [], completed, rows)
    expect(others.map((r) => `${r.id}@${r.version}`)).toEqual(['pi@0.70.0'])
  })
})

describe('updatesButtonModel', () => {
  const base = {
    app: null,
    harnessRows: [],
    installRows: [],
    harnessMode: 'ask' as const,
    harnessRunning: false,
    justFinished: false,
    finished: []
  }
  const rows = harnessUpdateRows({
    updates: harnessView(),
    installs: [],
    dismissed: new Set(),
    completed: [],
    started: {},
    later: NO_LATER
  })

  it('E: hidden with nothing pending', () => {
    expect(updatesButtonModel(base).state).toBe('hidden')
  })

  it('E: harness updates only — the download icon, the count, the items in the title', () => {
    expect(updatesButtonModel({ ...base, harnessRows: rows })).toEqual({
      state: 'available',
      count: 2,
      title: 'opencode 2.5.0, pi 0.72.1: click to review'
    })
    // Automatically installs them by itself: they await no decision.
    expect(updatesButtonModel({ ...base, harnessRows: rows, harnessMode: 'auto' }).state).toBe(
      'hidden'
    )
  })

  it('E: the app staged plus others — the restart arrow, counting all', () => {
    const app = appSection(stagedView(), { later: NO_LATER })
    expect(updatesButtonModel({ ...base, app, harnessRows: rows })).toEqual({
      state: 'restart',
      count: 3,
      title: 'ClaudeUI 3.9.1-pre.14 ready to restart, 2 more: click to review'
    })
    const built = appSection(
      localView({
        rebuild: { phase: 'built', startedAt: 'b', built: { version: 'v', commit: 'c' } }
      }),
      { later: NO_LATER }
    )
    expect(updatesButtonModel({ ...base, app: built })).toMatchObject({
      state: 'restart',
      count: 1
    })
  })

  it('E: something running — a spinner naming it', () => {
    const app = appSection(buildingView(), { later: NO_LATER })
    const installing = harnessUpdateRows({
      updates: harnessView(),
      installs: [
        {
          id: 'opencode',
          version: '2.5.0',
          phase: 'downloading',
          receivedBytes: 62,
          totalBytes: 100
        }
      ],
      dismissed: new Set(),
      completed: [],
      started: {},
      later: NO_LATER
    })
    expect(updatesButtonModel({ ...base, app, harnessRows: installing })).toEqual({
      state: 'running',
      count: 0,
      title: 'Building ClaudeUI · installing opencode 62%'
    })
    expect(updatesButtonModel({ ...base, harnessRunning: true }).state).toBe('running')
  })

  it('E: something failed — amber, naming it', () => {
    const failed = harnessUpdateRows({
      updates: harnessView({ available: [harnessView().available[1]] }),
      installs: [{ id: 'pi', version: '0.72.1', phase: 'failed', reason: 'stalled' }],
      dismissed: new Set(),
      completed: [],
      started: {},
      later: NO_LATER
    })
    expect(updatesButtonModel({ ...base, harnessRows: failed })).toEqual({
      state: 'failed',
      count: 0,
      title: 'pi 0.72.1 failed to install'
    })
    const app = appSection(
      appView({ download: { phase: 'failed', version: '3.9.1-pre.14', error: 'x' } }),
      { later: NO_LATER }
    )
    expect(updatesButtonModel({ ...base, app }).title).toBe(
      'ClaudeUI 3.9.1-pre.14 failed to download'
    )
  })

  it('the check after installs finished, naming them', () => {
    expect(
      updatesButtonModel({
        ...base,
        justFinished: true,
        finished: [{ id: 'opencode', version: '2.5.0' }]
      })
    ).toEqual({ state: 'done', count: 0, title: 'opencode 2.5.0 installed' })
  })
})

describe('impactLines', () => {
  it('reads naturally, one line per thing interrupted', () => {
    expect(impactLines({ workingSessions: 2, terminals: 1, remoteClients: 1 })).toEqual([
      '2 sessions are working. Their turns stop; they reopen after.',
      '1 terminal will close.',
      '1 remote device will reconnect.'
    ])
    expect(impactLines({ workingSessions: 1, terminals: 0, remoteClients: 3 })).toEqual([
      '1 session is working. Its turn stops; it reopens after.',
      '3 remote devices will reconnect.'
    ])
    expect(impactLines({ workingSessions: 0, terminals: 0, remoteClients: 0 })).toEqual([])
  })
})
