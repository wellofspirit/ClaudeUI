import { describe, expect, it } from 'vitest'
import type { HarnessStateEntry, HarnessVersionsResult } from '../../../../../shared/harness-types'
import {
  choiceLabel,
  exactVersions,
  missingManagedVersion,
  progressPercent,
  progressText,
  installNeeded,
  rowLine,
  systemOffReason,
  systemVerdict
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
  const bundled = (version: string, reason?: string): HarnessStateEntry['resolved'] => ({
    source: 'bundled',
    version,
    path: '/opt/claudeui/vendor/pi-cli/pi',
    available: true,
    ...(reason ? { reason } : {})
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

  it('a bundled copy of the selected version satisfies the selection: no "not installed"', () => {
    const entry = pi({
      managed: [],
      resolved: bundled('0.87.4', 'pi 0.87.4 is not installed in ClaudeUI')
    })
    expect(installNeeded(entry)).toBeNull()
    expect(rowLine(entry)).toMatchObject({
      state: 'running',
      text: 'Bundled with ClaudeUI · 0.87.4',
      tone: 'normal'
    })
  })

  it('a selected version that is neither installed nor bundled is the actionable state', () => {
    const entry = pi({
      selection: { source: 'managed', version: '0.88.0' },
      managed: [],
      resolved: bundled('0.87.4', 'pi 0.88.0 is not installed in ClaudeUI')
    })
    expect(installNeeded(entry)).toEqual({ request: '0.88.0', version: '0.88.0' })
    expect(rowLine(entry)).toMatchObject({
      state: 'not-installed',
      // What runs meanwhile, so the row does not hide the bundled copy.
      text: '0.88.0 is not installed; running the bundled 0.87.4',
      tone: 'warning'
    })
  })

  it("Codex reads design 1's uiNote", () => {
    const codex = pi({
      id: 'codex',
      manifest: { tested: '0.156.0', floor: '0.156.0', ceiling: '1.0.0' },
      managed: [],
      resolved: { ...bundled('0.156.0', 'Codex 0.156.0 is not installed in ClaudeUI') }
    })
    expect(rowLine(codex).text).toBe('Exact version this ClaudeUI release speaks · 0.156.0')
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

  it('an unusable System selection says why, and what runs instead', () => {
    const entry = pi({
      selection: { source: 'system' },
      resolved: bundled('0.87.4', 'pi 0.80.0 is older than 0.87.4, the oldest ClaudeUI supports')
    })
    expect(rowLine(entry)).toMatchObject({
      state: 'fallback',
      text: 'pi 0.80.0 is older than 0.87.4, the oldest ClaudeUI supports; running the bundled copy',
      tone: 'warning'
    })
  })

  it('an unavailable harness says so', () => {
    expect(
      rowLine(
        pi({
          resolved: { source: 'bundled', version: null, path: null, available: false, reason: 'x' }
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
