/**
 * The S7b readers in `harness-view.ts` (ADR-082 §8): whether a harness runs,
 * how the picker marks it, what the composer banner says, and the upgrade
 * sheet's rows. Pure: snapshots are built by hand.
 */
import { describe, expect, it } from 'vitest'
import type {
  HarnessId,
  HarnessInstallProgress,
  HarnessStateEntry,
  HarnessStateSnapshot
} from '../../../../../shared/harness-types'
import {
  harnessBannerState,
  harnessCanRun,
  harnessPickerMark,
  harnessReadiness,
  sessionCountLabel,
  upgradeSheetRows
} from '../harness-view'

const TESTED: Record<HarnessId, string> = {
  claude: '2.1.280',
  opencode: '1.18.32',
  pi: '0.87.4',
  codex: '0.156.0'
}

function entry(id: HarnessId, patch: Partial<HarnessStateEntry> = {}): HarnessStateEntry {
  return {
    id,
    manifest: { tested: TESTED[id], floor: TESTED[id], ceiling: '9.0.0' },
    selection: id === 'claude' ? { source: 'bundled' } : { source: 'managed', version: 'tested' },
    resolved: {
      source: id === 'claude' ? 'bundled' : 'managed',
      version: TESTED[id],
      path: `/store/${id}`,
      available: true
    },
    system: { detectedAt: null, installs: [], choice: { kind: 'fallback', reason: 'none' } },
    managed: [
      { version: TESTED[id], verified: 'reviewed', installedAt: '2026-09-29T00:00:00.000Z' }
    ],
    installable: id !== 'claude',
    ...patch
  }
}

const MISSING: Partial<HarnessStateEntry> = {
  resolved: {
    source: 'managed',
    version: null,
    path: null,
    reason: 'not installed',
    available: false
  },
  managed: []
}

function snapshot(
  patch: Partial<Record<HarnessId, Partial<HarnessStateEntry>>> = {},
  upgradePrompt: HarnessStateSnapshot['upgradePrompt'] = { pending: false, candidates: [] }
): HarnessStateSnapshot {
  return {
    harnesses: {
      claude: entry('claude', patch.claude),
      opencode: entry('opencode', patch.opencode),
      pi: entry('pi', patch.pi),
      codex: entry('codex', patch.codex)
    },
    detection: { running: false },
    installs: [],
    updates: { mode: 'ask', available: [], status: { running: false, results: [] } },
    upgradePrompt
  }
}

describe('harnessReadiness', () => {
  it('is unknown until the snapshot loads, and unknown still counts as runnable', () => {
    expect(harnessReadiness(null, 'opencode')).toBe('unknown')
    expect(harnessCanRun('unknown')).toBe(true)
  })

  it('is ready whenever the resolver says it runs', () => {
    expect(harnessReadiness(snapshot(), 'pi')).toBe('ready')
    expect(harnessCanRun('ready')).toBe(true)
  })

  it('is missing for ClaudeUI’s copy not installed on a host that can install it', () => {
    expect(harnessReadiness(snapshot({ opencode: MISSING }), 'opencode')).toBe('missing')
    expect(harnessCanRun('missing')).toBe(false)
  })

  it('is system-unusable for a System selection that cannot run', () => {
    const s = snapshot({
      pi: {
        ...MISSING,
        selection: { source: 'system', version: 'tested' },
        resolved: { ...MISSING.resolved!, source: 'system', reason: 'No usable System pi found' }
      }
    })
    expect(harnessReadiness(s, 'pi')).toBe('system-unusable')
  })

  it('is unavailable-here when ClaudeUI cannot install it, or an override names something that cannot run', () => {
    expect(harnessReadiness(snapshot({ codex: { ...MISSING, installable: false } }), 'codex')).toBe(
      'unavailable-here'
    )
    expect(
      harnessReadiness(
        snapshot({ opencode: { ...MISSING, resolved: { ...MISSING.resolved!, source: 'env' } } }),
        'opencode'
      )
    ).toBe('unavailable-here')
  })
})

describe('harnessPickerMark', () => {
  it('chips a harness that can be installed, disables one that cannot, and leaves the rest', () => {
    expect(harnessPickerMark('missing')).toBe('not-installed')
    expect(harnessPickerMark('system-unusable')).toBe('not-installed')
    expect(harnessPickerMark('unavailable-here')).toBe('disabled')
    expect(harnessPickerMark('ready')).toBe('none')
    expect(harnessPickerMark('unknown')).toBe('none')
  })
})

describe('harnessBannerState', () => {
  const missing = snapshot({ opencode: MISSING })

  it('is null for a harness that runs, or before the snapshot loads', () => {
    expect(harnessBannerState(snapshot(), 'opencode', [], true)).toBeNull()
    expect(harnessBannerState(null, 'opencode', [], true)).toBeNull()
  })

  it('offers the selection’s version to an admin', () => {
    expect(harnessBannerState(missing, 'opencode', [], true)).toEqual({
      kind: 'offer',
      request: '1.18.32',
      version: '1.18.32'
    })
  })

  it('follows an install in flight, then its failure', () => {
    const active: HarnessInstallProgress = {
      id: 'opencode',
      version: '1.18.32',
      phase: 'downloading',
      receivedBytes: 10,
      totalBytes: 40
    }
    expect(harnessBannerState(missing, 'opencode', [active], true)).toEqual({
      kind: 'installing',
      progress: active
    })
    const failed: HarnessInstallProgress = {
      id: 'opencode',
      version: '1.18.32',
      phase: 'failed',
      reason: 'the digest does not match'
    }
    expect(harnessBannerState(missing, 'opencode', [failed], true)).toEqual({
      kind: 'failed',
      progress: failed,
      request: '1.18.32'
    })
    // Another harness's install is not this banner's.
    expect(harnessBannerState(missing, 'opencode', [{ ...active, id: 'pi' }], true)?.kind).toBe(
      'offer'
    )
  })

  it('tells a connection without admin who can install it', () => {
    expect(harnessBannerState(missing, 'opencode', [], false)).toEqual({ kind: 'ask-admin' })
  })

  it('offers ClaudeUI’s copy for a System selection that cannot run, with its reason', () => {
    const s = snapshot({
      pi: {
        ...MISSING,
        selection: { source: 'system' },
        resolved: {
          ...MISSING.resolved!,
          source: 'system',
          reason: 'No usable System pi found: too old'
        }
      }
    })
    expect(harnessBannerState(s, 'pi', [], true)).toEqual({
      kind: 'system-unusable',
      reason: 'No usable System pi found: too old'
    })
  })

  it('offers no install for a selected version that is installed yet cannot run', () => {
    // Codex installed at the pin, but without its code-mode host: an install
    // would be satisfied by what is there and change nothing.
    const s = snapshot({
      codex: { resolved: { ...MISSING.resolved!, path: '/store/codex', reason: undefined } }
    })
    expect(harnessReadiness(s, 'codex')).toBe('missing')
    expect(harnessBannerState(s, 'codex', [], true)).toEqual({
      kind: 'unavailable-here',
      reason: 'Codex is installed but cannot run'
    })
  })

  it('names why a harness cannot run here, with nothing to click', () => {
    const s = snapshot({
      codex: {
        ...MISSING,
        installable: false,
        resolved: { ...MISSING.resolved!, reason: 'Codex is not available for win32-arm64' }
      }
    })
    expect(harnessBannerState(s, 'codex', [], true)).toEqual({
      kind: 'unavailable-here',
      reason: 'Codex is not available for win32-arm64'
    })
  })
})

describe('upgradeSheetRows', () => {
  it('is empty unless the host says the prompt is pending', () => {
    expect(upgradeSheetRows(null)).toEqual([])
    expect(
      upgradeSheetRows(
        snapshot(
          { opencode: MISSING },
          { pending: false, candidates: [{ id: 'opencode', sessions: 2 }] }
        )
      )
    ).toEqual([])
  })

  it('lists each candidate with the version its install fetches and its session count', () => {
    const s = snapshot(
      { opencode: MISSING, codex: MISSING },
      {
        pending: true,
        candidates: [
          { id: 'opencode', sessions: 14 },
          { id: 'codex', sessions: 1 }
        ]
      }
    )
    expect(upgradeSheetRows(s)).toEqual([
      { id: 'opencode', version: '1.18.32', request: '1.18.32', sessions: 14 },
      { id: 'codex', version: '0.156.0', request: '0.156.0', sessions: 1 }
    ])
    expect(sessionCountLabel(14)).toBe('14 sessions')
    expect(sessionCountLabel(1)).toBe('1 session')
  })

  it('drops a candidate that no longer needs an install', () => {
    const s = snapshot({}, { pending: true, candidates: [{ id: 'pi', sessions: 3 }] })
    expect(upgradeSheetRows(s)).toEqual([])
  })
})
