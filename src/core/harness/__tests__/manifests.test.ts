/**
 * @vitest-environment node
 *
 * The release manifests (ADR-082 §5) are the source of truth for "Tested".
 * Codex's own parity checks (host set vs `CODEX_SUPPORTED_HOSTS`, `tested` vs
 * the generated protocol's provenance) live beside its acquisition tests in
 * `src/core/codex/__tests__/codex-tooling.test.ts`.
 */
import { describe, it, expect } from 'vitest'
import { HARNESS_IDS } from '../../../shared/harness-types'
import { harnessManifest } from '../manifests'
import { HARNESS_VERSION_RE } from '../selection-store'
import { compareVersions } from '../store'
import pkg from '../../../../package.json'

describe('harness manifests', () => {
  it.each(HARNESS_IDS)('%s names itself and pins a well-formed tested/floor', (id) => {
    const manifest = harnessManifest(id)
    expect(manifest.id).toBe(id)
    expect(manifest.tested).toMatch(HARNESS_VERSION_RE)
    expect(manifest.floor).toMatch(HARNESS_VERSION_RE)
    expect(compareVersions(manifest.floor, manifest.tested)).toBeLessThanOrEqual(0)
    expect(typeof manifest.platforms).toBe('object')
  })

  it('keeps Claude Code on the bundled build that package.json pins', () => {
    expect(harnessManifest('claude').tested).toBe(pkg.claudeCliVersion)
    expect(harnessManifest('claude').platforms).toEqual({})
  })

  it('names a reviewed pi archive for every host ensure-pi can select', () => {
    const platforms = harnessManifest('pi').platforms
    expect(Object.keys(platforms).sort()).toEqual(
      ['darwin-arm64', 'darwin-x64', 'linux-arm64', 'linux-x64', 'win32-arm64', 'win32-x64'].sort()
    )
    for (const [key, entry] of Object.entries(platforms)) {
      const [os, arch] = key.split('-')
      const name = os === 'win32' ? 'windows' : os
      expect(entry.asset).toBe(`pi-${name}-${arch}.${os === 'win32' ? 'zip' : 'tar.gz'}`)
      expect(entry.archiveSha256).toMatch(/^[0-9a-f]{64}$/)
    }
  })
})

describe('compareVersions', () => {
  it('orders numerically, a release above its pre-releases', () => {
    const sorted = [
      '1.10.0',
      '1.2.0',
      '1.10.0-beta.2',
      '1.10.0-beta.10',
      '0.9.9',
      '1.2.0+build'
    ].sort(compareVersions)
    expect(sorted).toEqual([
      '0.9.9',
      '1.2.0',
      '1.2.0+build',
      '1.10.0-beta.2',
      '1.10.0-beta.10',
      '1.10.0'
    ])
  })
})
