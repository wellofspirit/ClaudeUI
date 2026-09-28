// @vitest-environment node
/**
 * scripts/ensure-opencode.mjs — the reviewed-digest gate on the vendored
 * upstream release (ADR-081 §7). Every check here is one the script relies on
 * to fail closed; none of them downloads anything.
 */
import { gzipSync } from 'node:zlib'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  assertManifestPin,
  binaryName,
  detectPackageName,
  expectedRelease,
  extractBinary,
  isCacheHit,
  isolatedEnv,
  manifest,
  sha256,
  sriSha512,
  verifyVersion,
  walkTar
} from '../../../../scripts/ensure-opencode.mjs'
import pkg from '../../../../package.json'

const directories: string[] = []
function temp(): string {
  const dir = mkdtempSync(join(tmpdir(), 'opencode-tooling-test-'))
  directories.push(dir)
  return dir
}
afterEach(() => {
  for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true })
})

/** A one-entry ustar archive, the shape `npm pack` produces (checksum unused by the reader). */
function tarOf(name: string, body: string): Buffer {
  const data = Buffer.from(body)
  const tar = Buffer.alloc(512 + Math.ceil(data.length / 512) * 512 + 1024)
  tar.write(name, 0)
  tar.write('0000755\0', 100)
  tar.write(data.length.toString(8).padStart(11, '0') + '\0', 124)
  tar.write('0', 156)
  data.copy(tar, 512)
  return tar
}

function record(tgz: Buffer, bin: string) {
  return {
    version: '1.0.0',
    package: 'opencode-linux-x64',
    integrity: sriSha512(tgz),
    binarySha256: sha256(bin)
  }
}

const PACKAGES = [
  'opencode-windows-x64',
  'opencode-darwin-arm64',
  'opencode-darwin-x64',
  'opencode-linux-x64',
  'opencode-linux-arm64'
]

describe('manifest', () => {
  it('matches the package.json pin, and a pin without reviewed digests throws', () => {
    const pinned = pkg.opencodeCliVersion
    expect(manifest.version).toBe(pinned)
    expect(() => assertManifestPin(pinned)).not.toThrow()
    expect(() => assertManifestPin(pinned, { ...manifest, version: '0.0.1' })).toThrow(
      /record the reviewed digests/
    )
  })

  it('carries a well-formed record for exactly the packages detectPackageName can return', () => {
    expect(Object.keys(manifest.packages).sort()).toStrictEqual([...PACKAGES].sort())
    const hosts: Array<[string, string]> = [
      ['win32', 'x64'],
      ['win32', 'arm64'],
      ['darwin', 'arm64'],
      ['darwin', 'x64'],
      ['linux', 'x64'],
      ['linux', 'arm64']
    ]
    for (const [platform, arch] of hosts) {
      const name = detectPackageName(platform, arch)
      expect(expectedRelease(name)).toStrictEqual({
        version: manifest.version,
        package: name,
        integrity: expect.stringMatching(/^sha512-[A-Za-z0-9+/]+=*$/),
        binarySha256: expect.stringMatching(/^[0-9a-f]{64}$/)
      })
    }
  })

  it('refuses a host with no reviewed package instead of picking a likely one', () => {
    expect(() => detectPackageName('linux', 'ia32')).toThrow(/no reviewed opencode release/)
    expect(() => detectPackageName('freebsd', 'x64')).toThrow(/no reviewed opencode release/)
  })

  it('refuses a missing or malformed record, and never reads inherited keys', () => {
    expect(() => expectedRelease('opencode-sunos-x64')).toThrow(/no valid digest record/)
    expect(() => expectedRelease('toString')).toThrow(/no valid digest record/)
    const bad = {
      version: '1.0.0',
      packages: { 'opencode-linux-x64': { integrity: 'sha256-abc', binarySha256: 'x' } }
    }
    expect(() => expectedRelease('opencode-linux-x64', bad)).toThrow(/no valid digest record/)
  })
})

describe('extractBinary', () => {
  const tgz = gzipSync(tarOf('package/bin/opencode', 'the-binary'))

  it('returns the binary when both digests match', () => {
    expect(extractBinary(tgz, record(tgz, 'the-binary'), 'opencode').toString()).toBe('the-binary')
  })

  it('refuses a tarball whose integrity differs from the manifest', () => {
    const other = gzipSync(tarOf('package/bin/opencode', 'the-binary!'))
    expect(() => extractBinary(other, record(tgz, 'the-binary'), 'opencode')).toThrow(
      /tarball integrity .* does not match/
    )
  })

  it('refuses a binary whose SHA-256 differs from the manifest', () => {
    expect(() =>
      extractBinary(tgz, { ...record(tgz, 'the-binary'), binarySha256: sha256('x') }, 'opencode')
    ).toThrow(/binary SHA-256 .* does not match/)
  })

  it('refuses a tarball without the platform binary at package/bin/', () => {
    expect(() => extractBinary(tgz, record(tgz, 'the-binary'), 'opencode.exe')).toThrow(/not found/)
    // Exact path, not a suffix: a look-alike elsewhere in the archive is not the binary.
    expect(walkTar(tarOf('evil/package/bin/opencode', 'x'), 'package/bin/opencode')).toBeNull()
  })
})

describe('isCacheHit', () => {
  function vendored(overrides: Record<string, unknown> = {}, body = 'the-binary') {
    const dir = temp()
    const expected = {
      version: '1.0.0',
      package: 'opencode-linux-x64',
      integrity: 'sha512-AAAA',
      binarySha256: sha256('the-binary')
    }
    writeFileSync(join(dir, binaryName('linux')), body)
    writeFileSync(
      join(dir, 'version.json'),
      JSON.stringify({
        ...expected,
        platform: 'linux',
        arch: 'x64',
        source: 'release',
        ...overrides
      })
    )
    return { dir, expected }
  }

  it('hits only when the record and the installed bytes both match', () => {
    const { dir, expected } = vendored()
    expect(isCacheHit(expected, dir, 'linux', 'x64')).toBe(true)
  })

  it('misses a swapped binary even when version.json still matches', () => {
    const { dir, expected } = vendored({}, 'a-different-binary')
    expect(isCacheHit(expected, dir, 'linux', 'x64')).toBe(false)
  })

  it('misses an old fork build, another package, another arch or a missing digest', () => {
    for (const overrides of [
      { source: 'fork' },
      { source: undefined },
      { package: 'opencode-linux-arm64' },
      { arch: 'arm64' },
      { binarySha256: undefined },
      { version: '0.9.0' }
    ]) {
      const { dir, expected } = vendored(overrides)
      expect(isCacheHit(expected, dir, 'linux', 'x64')).toBe(false)
    }
  })

  it('misses a missing binary or unreadable version.json', () => {
    const dir = temp()
    expect(isCacheHit(vendored().expected, dir, 'linux', 'x64')).toBe(false)
    writeFileSync(join(dir, 'version.json'), '{')
    expect(isCacheHit(vendored().expected, dir, 'linux', 'x64')).toBe(false)
  })
})

describe('verifyVersion', () => {
  // The Node executable stands in for opencode: `--version` prints its version.
  it('accepts the exact version and refuses any other, in the isolated env', () => {
    const dir = temp()
    const env = isolatedEnv(dir)
    expect(env).toMatchObject({ XDG_DATA_HOME: expect.stringContaining(dir) })
    expect(() => verifyVersion(process.execPath, dir, env, process.version)).not.toThrow()
    expect(() => verifyVersion(process.execPath, dir, env, '1.18.32')).toThrow(/expected 1\.18\.32/)
  })

  it('refuses a binary that cannot run', () => {
    const dir = temp()
    expect(() =>
      verifyVersion(join(dir, 'missing-binary'), dir, isolatedEnv(dir), '1.0.0')
    ).toThrow(/failed to run --version/)
  })
})
