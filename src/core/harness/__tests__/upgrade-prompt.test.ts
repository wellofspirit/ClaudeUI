/**
 * @vitest-environment node
 *
 * The one-time upgrade sheet's candidate rule (ADR-082 §8,
 * `core/harness/upgrade-prompt.ts`) and who can be installed at all
 * (`core/harness/installable.ts`). Pure: entries are built by hand.
 */
import { describe, expect, it } from 'vitest'
import type { HarnessId, HarnessStateEntry } from '../../../shared/harness-types'
import { harnessInstallable } from '../installable'
import { upgradeCandidates } from '../upgrade-prompt'

function entry(id: HarnessId, patch: Partial<HarnessStateEntry> = {}): HarnessStateEntry {
  return {
    id,
    manifest: { tested: '1.0.0', floor: '1.0.0', ceiling: '2.0.0' },
    selection: id === 'claude' ? { source: 'bundled' } : { source: 'managed', version: 'tested' },
    resolved: {
      source: id === 'claude' ? 'bundled' : 'managed',
      version: null,
      path: null,
      reason: 'not installed',
      available: false
    },
    system: {
      detectedAt: '2026-09-30T00:00:00.000Z',
      installs: [],
      choice: { kind: 'fallback', reason: 'none found' }
    },
    managed: [],
    installable: id !== 'claude',
    ...patch
  }
}

/** Every harness missing, installable and managed: the case the sheet exists for. */
function harnesses(
  patch: Partial<Record<HarnessId, Partial<HarnessStateEntry>>> = {}
): Record<HarnessId, HarnessStateEntry> {
  return {
    claude: entry('claude', patch.claude),
    opencode: entry('opencode', patch.opencode),
    pi: entry('pi', patch.pi),
    codex: entry('codex', patch.codex)
  }
}

const RUNNING = {
  source: 'managed' as const,
  version: '1.0.0',
  path: '/store/x',
  available: true
}

describe('upgradeCandidates', () => {
  it('offers each harness with sessions that nothing runs for, in harness order, with its count', () => {
    expect(upgradeCandidates(harnesses(), { codex: 2, opencode: 14, pi: 3 })).toEqual([
      { id: 'opencode', sessions: 14 },
      { id: 'pi', sessions: 3 },
      { id: 'codex', sessions: 2 }
    ])
  })

  it('never offers Claude Code, whatever its state and sessions', () => {
    const all = harnesses({
      claude: { installable: true, resolved: { ...RUNNING, available: false } }
    })
    expect(upgradeCandidates(all, { claude: 40 })).toEqual([])
  })

  it('skips a harness this profile never used (no session_meta row)', () => {
    expect(upgradeCandidates(harnesses(), { opencode: 1, pi: 0 })).toEqual([
      { id: 'opencode', sessions: 1 }
    ])
  })

  it('skips a harness that runs (installed, or an override)', () => {
    const all = harnesses({ opencode: { resolved: RUNNING } })
    expect(upgradeCandidates(all, { opencode: 5, pi: 1 })).toEqual([{ id: 'pi', sessions: 1 }])
  })

  it('skips a System selection that cannot run: that is the banner’s job', () => {
    const all = harnesses({ pi: { selection: { source: 'system', version: 'tested' } } })
    expect(upgradeCandidates(all, { pi: 3 })).toEqual([])
  })

  it('skips a harness whose detected System install is usable', () => {
    const all = harnesses({
      opencode: {
        system: {
          detectedAt: '2026-09-30T00:00:00.000Z',
          installs: [],
          choice: { kind: 'ok', displayPath: '/usr/bin/opencode', version: '1.0.0' }
        }
      }
    })
    expect(upgradeCandidates(all, { opencode: 9 })).toEqual([])
  })

  it('skips a harness ClaudeUI cannot install on this host', () => {
    const all = harnesses({ codex: { installable: false } })
    expect(upgradeCandidates(all, { codex: 4, pi: 1 })).toEqual([{ id: 'pi', sessions: 1 }])
  })
})

describe('harnessInstallable', () => {
  it('is never true for Claude Code, which is bundled', () => {
    expect(harnessInstallable('claude', 'win32', 'x64')).toBe(false)
    expect(harnessInstallable('claude', 'darwin', 'arm64')).toBe(false)
  })

  it('follows the reviewed Codex hosts', () => {
    expect(harnessInstallable('codex', 'win32', 'x64')).toBe(true)
    expect(harnessInstallable('codex', 'darwin', 'arm64')).toBe(true)
    expect(harnessInstallable('codex', 'win32', 'arm64')).toBe(false)
    expect(harnessInstallable('codex', 'darwin', 'x64')).toBe(false)
  })

  it('follows the manifest for opencode (Windows on arm64 runs the x64 build) and pi', () => {
    expect(harnessInstallable('opencode', 'win32', 'arm64')).toBe(true)
    expect(harnessInstallable('opencode', 'linux', 'x64')).toBe(true)
    expect(harnessInstallable('opencode', 'linux', 'ia32')).toBe(false)
    expect(harnessInstallable('opencode', 'freebsd', 'x64')).toBe(false)
    expect(harnessInstallable('pi', 'win32', 'arm64')).toBe(true)
    expect(harnessInstallable('pi', 'darwin', 'x64')).toBe(true)
  })
})
