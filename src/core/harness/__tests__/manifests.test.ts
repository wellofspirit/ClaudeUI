/**
 * @vitest-environment node
 *
 * The release manifests (ADR-082 §5) are the source of truth for "Tested".
 * Codex's own parity checks (host set vs `CODEX_SUPPORTED_HOSTS`, `tested` vs
 * the generated protocol's provenance) live beside the Codex tooling tests in
 * `src/core/codex/__tests__/codex-tooling.test.ts`.
 */
import { describe, it, expect } from 'vitest'
import { HARNESS_IDS } from '../../../shared/harness-types'
import { harnessManifest } from '../manifests'
import { HARNESS_VERSION_RE } from '../selection-store'
import { compareVersions } from '../store'
import { opencodePlatformKey, piPlatformKey } from '../install/sources'
import pkg from '../../../../package.json'

describe('harness manifests', () => {
  it.each(HARNESS_IDS)('%s names itself and pins floor <= tested < ceiling', (id) => {
    const manifest = harnessManifest(id)
    expect(manifest.id).toBe(id)
    expect(manifest.tested).toMatch(HARNESS_VERSION_RE)
    expect(manifest.floor).toMatch(HARNESS_VERSION_RE)
    expect(manifest.ceiling).toMatch(HARNESS_VERSION_RE)
    expect(compareVersions(manifest.floor, manifest.tested)).toBeLessThanOrEqual(0)
    expect(compareVersions(manifest.tested, manifest.ceiling)).toBeLessThan(0)
    expect(typeof manifest.platforms).toBe('object')
  })

  it('floors Claude Code at 2.1.290, the bundled build (owner, 2026-10-06)', () => {
    // The bundled build is the baseline: floor = tested. A deliberate floor
    // decision, so a bump that moves it has to touch this test too.
    expect(harnessManifest('claude').floor).toBe('2.1.290')
  })

  it('keeps Claude Code on the bundled build that package.json pins', () => {
    expect(harnessManifest('claude').tested).toBe(pkg.claudeCliVersion)
    expect(harnessManifest('claude').platforms).toEqual({})
  })

  it('pins opencode to the 2.x line: floor = tested, ceiling 3.0.0 (ADR-093 §1)', () => {
    const { tested, floor, ceiling } = harnessManifest('opencode')
    expect(tested).toMatch(/^2\.\d+\.\d+$/)
    expect(floor).toBe(tested)
    expect(ceiling).toBe('3.0.0')
  })

  it('names a reviewed opencode package for exactly the hosts the installer can select', () => {
    const packages: Record<string, string> = {
      'win32-x64': '@opencode/cli-windows-x64',
      'darwin-arm64': '@opencode/cli-darwin-arm64',
      'darwin-x64': '@opencode/cli-darwin-x64',
      'linux-x64': '@opencode/cli-linux-x64',
      'linux-arm64': '@opencode/cli-linux-arm64'
    }
    const platforms = harnessManifest('opencode').platforms
    expect(Object.keys(platforms).sort()).toEqual(Object.keys(packages).sort())
    for (const [key, entry] of Object.entries(platforms)) {
      expect(entry).toStrictEqual({
        package: packages[key],
        integrity: expect.stringMatching(/^sha512-[A-Za-z0-9+/]+=*$/),
        binarySha256: expect.stringMatching(/^[0-9a-f]{64}$/)
      })
    }
    // Every host the installer maps to a package has a reviewed record, and a
    // host with no build of its own gets none rather than a likely one.
    for (const [platform, arch] of [
      ['win32', 'x64'],
      ['win32', 'arm64'],
      ['darwin', 'arm64'],
      ['darwin', 'x64'],
      ['linux', 'x64'],
      ['linux', 'arm64']
    ]) {
      expect(Object.keys(platforms)).toContain(opencodePlatformKey(platform, arch))
    }
    expect(opencodePlatformKey('linux', 'ia32')).toBeNull()
    expect(opencodePlatformKey('freebsd', 'x64')).toBeNull()
  })

  it('names a reviewed pi archive for every host the installer can select', () => {
    const platforms = harnessManifest('pi').platforms
    expect(Object.keys(platforms).sort()).toEqual(
      ['darwin-arm64', 'darwin-x64', 'linux-arm64', 'linux-x64', 'win32-arm64', 'win32-x64'].sort()
    )
    for (const [key, entry] of Object.entries(platforms)) {
      const [os, arch] = key.split('-')
      const name = os === 'win32' ? 'windows' : os
      expect(entry.asset).toBe(`pi-${name}-${arch}.${os === 'win32' ? 'zip' : 'tar.gz'}`)
      expect(entry.archiveSha256).toMatch(/^[0-9a-f]{64}$/)
      expect(piPlatformKey(os, arch)).toBe(key)
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
