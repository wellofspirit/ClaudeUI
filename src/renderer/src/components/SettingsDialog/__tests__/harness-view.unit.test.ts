import { describe, expect, it } from 'vitest'
import type {
  HarnessInstallProgress,
  HarnessStateEntry,
  HarnessUpdatesView,
  HarnessVersionsResult
} from '../../../../../shared/harness-types'
import {
  autoLatestWarning,
  installPanelRows,
  openUpdateFailures,
  otherInstalls,
  updateButtonState,
  updatePanelRows,
  updateResultKey,
  updateSummary,
  choiceLabel,
  exactVersions,
  missingManagedVersion,
  progressPercent,
  progressText,
  installNeeded,
  rowLine,
  systemOffReason,
  systemVerdict,
  chatgptDisconnectText
} from '../harness-view'

function pi(patch: Partial<HarnessStateEntry> = {}): HarnessStateEntry {
  return {
    id: 'pi',
    manifest: { tested: '0.87.4', floor: '0.87.4', ceiling: '1.0.0' },
    selection: { source: 'managed', version: 'tested' },
    resolved: {
      source: 'managed',
      version: '0.87.4',
      path: '/opt/store/pi/0.87.4/pi',
      available: true
    },
    system: { detectedAt: null, installs: [], choice: { kind: 'fallback', reason: 'none' } },
    managed: [{ version: '0.87.4', verified: 'reviewed', installedAt: '2026-09-29T00:00:00.000Z' }],
    installable: true,
    ...patch
  }
}

const upstream: HarnessVersionsResult = {
  status: 'ok',
  id: 'pi',
  latest: '0.88.0',
  available: ['0.88.0', '0.87.10', '0.87.4']
}

describe('missingManagedVersion', () => {
  it('is null while the selected version is installed, or the source is System', () => {
    expect(missingManagedVersion(pi())).toBeNull()
    expect(
      missingManagedVersion(pi({ selection: { source: 'system', version: '0.88.0' }, managed: [] }))
    ).toBeNull()
  })

  it('names Tested when the store lacks it', () => {
    expect(missingManagedVersion(pi({ managed: [] }))).toEqual({
      request: '0.87.4',
      version: '0.87.4'
    })
  })

  it('names an exact version the store lacks', () => {
    expect(
      missingManagedVersion(pi({ selection: { source: 'managed', version: '0.88.0' } }))
    ).toEqual({ request: '0.88.0', version: '0.88.0' })
  })

  it("Latest is missing only when nothing is installed, and asks for upstream's newest", () => {
    const latest = { source: 'managed' as const, version: 'latest' }
    expect(missingManagedVersion(pi({ selection: latest }), upstream)).toBeNull()
    expect(missingManagedVersion(pi({ selection: latest, managed: [] }), upstream)).toEqual({
      request: '0.88.0',
      version: '0.88.0'
    })
    expect(missingManagedVersion(pi({ selection: latest, managed: [] }))).toEqual({
      request: 'latest',
      version: null
    })
  })
})

describe('the version dropdown', () => {
  it('lists upstream releases and installed versions once each, newest first', () => {
    const entry = pi({
      managed: [
        { version: '0.87.9', verified: 'publisher', installedAt: '2026-09-29T00:00:00.000Z' },
        { version: '0.87.4', verified: 'reviewed', installedAt: '2026-09-29T00:00:00.000Z' }
      ]
    })
    // 0.87.10 sorts above 0.87.9: a numeric collation, not a string one.
    expect(exactVersions(entry, upstream)).toEqual(['0.88.0', '0.87.10', '0.87.9', '0.87.4'])
  })

  it('reads the ClaudeUI choice as the trigger shows it', () => {
    expect(choiceLabel(pi(), 'tested')).toBe('Tested · 0.87.4')
    expect(choiceLabel(pi(), 'latest', upstream)).toBe('Latest · 0.87.4')
    expect(choiceLabel(pi({ managed: [] }), 'latest', upstream)).toBe('Latest · 0.88.0')
    expect(choiceLabel(pi({ managed: [] }), 'latest')).toBe('Latest')
    expect(choiceLabel(pi(), '0.87.10')).toBe('0.87.10')
  })
})

describe('the row line (one line, the active side only)', () => {
  /** What the resolver answers when nothing runs (ADR-082 §8: nothing bundled). */
  const nothing = (
    source: 'managed' | 'system',
    reason: string
  ): HarnessStateEntry['resolved'] => ({
    source,
    version: null,
    path: null,
    available: false,
    reason
  })

  it("ClaudeUI's copy says so, with the running path only in the title", () => {
    const line = rowLine(pi())
    expect(line).toMatchObject({
      state: 'running',
      text: "ClaudeUI's copy · 0.87.4",
      tone: 'normal'
    })
    expect(line.title).toContain('/opt/store/pi/0.87.4/pi')
    expect(line.text).not.toContain('/opt')
  })

  it('an empty store is the actionable state: "<v> is not installed" with Install', () => {
    const entry = pi({ managed: [], resolved: nothing('managed', 'pi 0.87.4 is not installed') })
    expect(installNeeded(entry)).toEqual({ request: '0.87.4', version: '0.87.4' })
    expect(rowLine(entry)).toEqual({
      state: 'not-installed',
      text: '0.87.4 is not installed',
      tone: 'warning',
      title: 'pi 0.87.4 is not installed'
    })
  })

  it('never mentions a bundled copy for opencode, pi or Codex', () => {
    for (const id of ['opencode', 'pi', 'codex'] as const) {
      const entry = pi({
        id,
        managed: [],
        resolved: nothing('managed', `${id} 0.87.4 is not installed`)
      })
      expect(rowLine(entry).text).not.toMatch(/bundled/i)
      expect(rowLine(pi({ id })).text).not.toMatch(/bundled/i)
    }
  })

  it('a selected version that is not installed is the actionable state', () => {
    const entry = pi({
      selection: { source: 'managed', version: '0.88.0' },
      resolved: nothing('managed', 'pi 0.88.0 is not installed')
    })
    expect(installNeeded(entry)).toEqual({ request: '0.88.0', version: '0.88.0' })
    expect(rowLine(entry)).toMatchObject({
      state: 'not-installed',
      text: '0.88.0 is not installed',
      tone: 'warning'
    })
  })

  it('an environment override runs instead and offers no install', () => {
    const entry = pi({
      managed: [],
      resolved: { source: 'env', version: '9.9.9', path: '/dev/pi', available: true }
    })
    expect(installNeeded(entry)).toBeNull()
    expect(rowLine(entry)).toMatchObject({
      state: 'running',
      text: 'Environment override · 9.9.9'
    })
  })

  it("Codex reads design 1's uiNote when installed, else the not-installed state", () => {
    const codexEntry = (managed: HarnessStateEntry['managed']): HarnessStateEntry =>
      pi({
        id: 'codex',
        manifest: { tested: '0.156.0', floor: '0.156.0', ceiling: '1.0.0' },
        managed,
        resolved:
          managed.length > 0
            ? {
                source: 'managed',
                version: '0.156.0',
                path: '/opt/store/codex/0.156.0/codex',
                available: true
              }
            : nothing('managed', 'Codex 0.156.0 is not installed')
      })
    expect(
      rowLine(
        codexEntry([
          { version: '0.156.0', verified: 'reviewed', installedAt: '2026-09-29T00:00:00.000Z' }
        ])
      ).text
    ).toBe('Exact version this ClaudeUI release speaks · 0.156.0')
    expect(rowLine(codexEntry([]))).toMatchObject({
      state: 'not-installed',
      text: '0.156.0 is not installed'
    })
  })

  it("Claude Code's bundled copy carries the patches", () => {
    const claude = pi({
      id: 'claude',
      selection: { source: 'bundled' },
      resolved: { source: 'bundled', version: '2.1.280', path: '/opt/claude', available: true }
    })
    expect(rowLine(claude).text).toBe(
      'Bundled with ClaudeUI · 2.1.280 · patched: voice and live streaming'
    )
  })

  it('System reads the path and how the version compares with the one ClaudeUI tested', () => {
    const system = pi({
      selection: { source: 'system', version: 'tested' },
      resolved: {
        source: 'system',
        version: '0.88.0',
        path: '/opt/tools/lib/pi/cli.js',
        displayPath: '/opt/tools/bin/pi',
        available: true
      }
    })
    expect(rowLine(system).text).toBe(
      '/opt/tools/bin/pi · 0.88.0, newer than the 0.87.4 ClaudeUI tested'
    )
    expect(systemVerdict(system)).toBe('untested')
    expect(systemVerdict(pi())).toBeNull()
  })

  it('an unusable System selection says why; only Claude Code has a bundled copy to run', () => {
    const reason = 'pi 0.80.0 is older than 0.87.4, the oldest ClaudeUI supports'
    expect(
      rowLine(pi({ selection: { source: 'system' }, resolved: nothing('system', reason) }))
    ).toMatchObject({ state: 'unavailable', text: reason, tone: 'danger' })

    const claude = pi({
      id: 'claude',
      selection: { source: 'system' },
      resolved: {
        source: 'bundled',
        version: '2.1.280',
        path: '/opt/claude',
        available: true,
        reason: 'No usable System Claude Code found'
      }
    })
    expect(rowLine(claude)).toMatchObject({
      state: 'fallback',
      text: 'No usable System Claude Code found; running the bundled copy',
      tone: 'warning'
    })
  })

  it('an unavailable harness says so', () => {
    expect(
      rowLine(
        pi({
          // The version is in the store, but its executable is gone.
          resolved: { source: 'managed', version: null, path: null, available: false, reason: 'x' }
        })
      )
    ).toMatchObject({ state: 'unavailable', text: 'x', tone: 'danger' })
  })
})

describe("the System segment's tooltip", () => {
  it('says nothing was found, or why what was found is unusable', () => {
    expect(
      systemOffReason(
        pi({
          system: {
            detectedAt: '2026-09-30T00:00:00.000Z',
            installs: [],
            choice: { kind: 'fallback', reason: 'r' }
          }
        })
      )
    ).toBe('No pi found on this computer')
    expect(
      systemOffReason(
        pi({
          system: {
            detectedAt: '2026-09-30T00:00:00.000Z',
            installs: [
              {
                displayPath: '/opt/tools/bin/pi',
                version: '0.1.0',
                verdict: 'too-old',
                installKind: 'npm'
              }
            ],
            choice: { kind: 'fallback', reason: 'No usable System pi found: too old' }
          }
        })
      )
    ).toBe('No usable System pi found: too old')
    expect(
      systemOffReason(
        pi({
          system: {
            detectedAt: null,
            installs: [],
            choice: { kind: 'ok', displayPath: '/x', version: '0.87.4' }
          }
        })
      )
    ).toBeUndefined()
  })
})

describe('progress', () => {
  it('reports bytes while downloading and the phase otherwise', () => {
    const p = { id: 'pi' as const, version: '0.88.0' }
    expect(
      progressText({ ...p, phase: 'downloading', receivedBytes: 1572864, totalBytes: 3145728 })
    ).toBe('Downloading 1.5 MB of 3.0 MB')
    expect(
      progressPercent({ ...p, phase: 'downloading', receivedBytes: 1572864, totalBytes: 3145728 })
    ).toBe(50)
    expect(progressPercent({ ...p, phase: 'downloading', receivedBytes: 10 })).toBeNull()
    expect(progressText({ ...p, phase: 'verifying' })).toBe('Verifying')
    expect(progressText({ ...p, phase: 'failed', reason: 'checksum mismatch' })).toBe(
      'Failed: checksum mismatch'
    )
  })
})

// ── Updates (ADR-082 §6) ──────────────────────────────────────────────

const RUN = '2026-09-30T01:00:00.000Z'

function updates(patch: Partial<HarnessUpdatesView> = {}): HarnessUpdatesView {
  return {
    mode: 'ask',
    available: [
      { id: 'opencode', from: '1.18.40', to: '1.18.41', choice: 'latest' },
      { id: 'pi', from: '0.87.1', to: '0.87.4', choice: 'tested' }
    ],
    status: { running: false, results: [] },
    ...patch
  }
}

const idle = { installs: [], pending: false, dismissed: new Set<string>(), justFinished: false }
const failedPi = {
  id: 'pi' as const,
  from: '0.87.1',
  to: '0.87.4',
  status: 'failed' as const,
  reason: 'checksum mismatch'
}

describe('updateButtonState', () => {
  it('is hidden with nothing to show, and before the first read', () => {
    expect(updateButtonState({ ...idle, updates: undefined })).toBe('hidden')
    expect(updateButtonState({ ...idle, updates: updates({ available: [] }) })).toBe('hidden')
  })

  it('counts in Ask me; Automatically only reports, so available alone is hidden', () => {
    expect(updateButtonState({ ...idle, updates: updates() })).toBe('available')
    expect(updateButtonState({ ...idle, updates: updates({ mode: 'auto' }) })).toBe('hidden')
  })

  it('spins while a run is in flight, this client asked for one, or any install runs', () => {
    const running = updates({ status: { running: true, lastRunAt: RUN, results: [] } })
    expect(updateButtonState({ ...idle, updates: running })).toBe('running')
    expect(updateButtonState({ ...idle, updates: updates(), pending: true })).toBe('running')
    const installing: HarnessInstallProgress = { id: 'pi', version: '0.87.4', phase: 'downloading' }
    expect(updateButtonState({ ...idle, updates: updates(), installs: [installing] })).toBe(
      'running'
    )
    // Since S7b an install that is not an update (the upgrade sheet's) spins too.
    const other: HarnessInstallProgress = { id: 'codex', version: '0.156.0', phase: 'downloading' }
    expect(
      updateButtonState({ ...idle, updates: updates({ available: [] }), installs: [other] })
    ).toBe('running')
  })

  it('is amber for a failed install outside the update flow, not for an update’s own', () => {
    const failed: HarnessInstallProgress = {
      id: 'codex',
      version: '0.156.0',
      phase: 'failed',
      reason: 'digest mismatch'
    }
    expect(
      updateButtonState({ ...idle, updates: updates({ available: [] }), installs: [failed] })
    ).toBe('failed')
    // The update's failure is the run's result's business (and dismissable there).
    const updateFailed: HarnessInstallProgress = { ...failed, id: 'pi', version: '0.87.4' }
    expect(updateButtonState({ ...idle, updates: updates(), installs: [updateFailed] })).toBe(
      'available'
    )
  })

  it('is amber while a failure is not dismissed, then falls back to what else is true', () => {
    const failed = updates({ status: { running: false, lastRunAt: RUN, results: [failedPi] } })
    expect(updateButtonState({ ...idle, updates: failed })).toBe('failed')
    const dismissed = new Set([updateResultKey(failedPi, RUN)])
    expect(updateButtonState({ ...idle, updates: failed, dismissed })).toBe('available')
    // A dismissal is for that run: a retry that fails again shows again.
    const again = updates({ status: { running: false, lastRunAt: 'later', results: [failedPi] } })
    expect(updateButtonState({ ...idle, updates: again, dismissed })).toBe('failed')
    expect(openUpdateFailures(again, dismissed)).toEqual([failedPi])
  })

  it('shows the check only just after a run that installed everything', () => {
    const done = updates({ available: [] })
    expect(updateButtonState({ ...idle, updates: done, justFinished: true })).toBe('done')
    expect(updateButtonState({ ...idle, updates: done })).toBe('hidden')
  })
})

describe('updatePanelRows', () => {
  it('lists results, then updates installing, waiting or available, in harness order', () => {
    const view = updates({
      available: [{ id: 'pi', from: '0.87.1', to: '0.87.4', choice: 'tested' }],
      status: {
        running: true,
        lastRunAt: RUN,
        results: [{ id: 'opencode', from: '1.18.40', to: '1.18.41', status: 'installed' }]
      }
    })
    expect(updatePanelRows(view, [], new Set())).toEqual([
      { id: 'opencode', from: '1.18.40', to: '1.18.41', state: 'installed' },
      { id: 'pi', from: '0.87.1', to: '0.87.4', state: 'waiting' }
    ])
    const progress: HarnessInstallProgress = { id: 'pi', version: '0.87.4', phase: 'verifying' }
    expect(updatePanelRows(view, [progress], new Set())[1]).toEqual({
      id: 'pi',
      from: '0.87.1',
      to: '0.87.4',
      state: 'installing',
      progress
    })
    expect(updatePanelRows(updates(), [], new Set()).map((r) => r.state)).toEqual([
      'available',
      'available'
    ])
  })

  it('keeps a failure (with its key) over the same version still available, until dismissed', () => {
    const view = updates({
      available: [{ id: 'pi', from: '0.87.1', to: '0.87.4', choice: 'tested' }],
      status: { running: false, lastRunAt: RUN, results: [failedPi] }
    })
    expect(updatePanelRows(view, [], new Set())).toEqual([
      {
        id: 'pi',
        from: '0.87.1',
        to: '0.87.4',
        state: 'failed',
        reason: 'checksum mismatch',
        key: updateResultKey(failedPi, RUN)
      }
    ])
    expect(
      updatePanelRows(view, [], new Set([updateResultKey(failedPi, RUN)])).map((r) => r.state)
    ).toEqual(['available'])
  })

  it('summarises for the tooltip', () => {
    expect(updateSummary(updates().available)).toBe(
      'opencode 1.18.40 → 1.18.41, pi 0.87.1 → 0.87.4'
    )
  })
})

describe('autoLatestWarning', () => {
  const opencode = (version: string, source: 'managed' | 'system' = 'managed'): HarnessStateEntry =>
    pi({ id: 'opencode', selection: { source, version } })

  it('warns for a ClaudeUI copy on Latest under Automatically only', () => {
    expect(autoLatestWarning(opencode('latest'), 'auto')).toBe(true)
    expect(autoLatestWarning(opencode('latest'), 'ask')).toBe(false)
    expect(autoLatestWarning(opencode('tested'), 'auto')).toBe(false)
    expect(autoLatestWarning(opencode('1.18.40'), 'auto')).toBe(false)
    expect(autoLatestWarning(opencode('latest', 'system'), 'auto')).toBe(false)
  })
})

describe('installPanelRows (S7b)', () => {
  it('lists installs outside the update flow, in flight, failed and finished, in harness order', () => {
    const view = updates()
    const rowsOf = installPanelRows(
      view,
      [
        { id: 'codex', version: '0.156.0', phase: 'downloading', receivedBytes: 5 },
        { id: 'pi', version: '0.87.4', phase: 'downloading' },
        { id: 'opencode', version: '1.18.32', phase: 'failed', reason: 'no network' }
      ],
      [
        { id: 'claude', version: '9.9.9' },
        { id: 'codex', version: '0.156.0' }
      ]
    )
    expect(rowsOf.map((r) => [r.id, r.version, r.state])).toEqual([
      ['claude', '9.9.9', 'installed'],
      ['opencode', '1.18.32', 'failed'],
      ['codex', '0.156.0', 'installing']
    ])
    expect(rowsOf[1].reason).toBe('no network')
    // pi 0.87.4 is an available update: it is an update row, not an install row.
    expect(otherInstalls(view, [{ id: 'pi', version: '0.87.4' }])).toEqual([])
  })
})

describe('chatgptDisconnectText (ADR-082 §8, S7e)', () => {
  const running =
    (...ids: string[]) =>
    (engine: string): boolean =>
      ids.includes(engine)

  it('names every harness that runs, and the ones whose own sign-in stays', () => {
    expect(chatgptDisconnectText(running('codex', 'pi', 'opencode'))).toBe(
      'ClaudeUI’s ChatGPT sign-in is removed from Codex, pi and opencode. Where ChatGPT is switched off for pi or opencode, a sign-in made there directly stays.'
    )
    expect(chatgptDisconnectText(running('opencode'))).toBe(
      'ClaudeUI’s ChatGPT sign-in is removed from opencode. Where ChatGPT is switched off for opencode, a sign-in made there directly stays.'
    )
  })

  it('Codex alone keeps nothing to mention; none running says nothing', () => {
    expect(chatgptDisconnectText(running('codex'))).toBe(
      'ClaudeUI’s ChatGPT sign-in is removed from Codex.'
    )
    expect(chatgptDisconnectText(running())).toBeUndefined()
  })
})
