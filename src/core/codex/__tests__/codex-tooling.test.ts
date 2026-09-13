// @vitest-environment node
import { gzipSync } from 'node:zlib'
import {
  mkdtempSync,
  rmSync,
  writeFileSync,
  chmodSync,
  readFileSync,
  mkdirSync,
  renameSync,
  existsSync,
  lstatSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import {
  assertPin,
  assertManifestPin,
  hostManifest,
  hostSupported,
  cacheValid,
  extractBinary,
  manifest,
  parseArgs,
  sha256,
  verifyVersion,
  isolatedEnv,
  installStaged,
  CodexRecoveryError
} from '../../../../scripts/ensure-codex.mjs'
import { checkOutput, codexBinaryDigests } from '../../../../scripts/generate-codex-protocol.mjs'
import { CODEX_SUPPORTED_HOSTS } from '../codex-locate'
import provenance from '../protocol/provenance.json'
const directories: string[] = []
function temp(): string {
  const dir = mkdtempSync(join(tmpdir(), 'codex-tooling-test-'))
  directories.push(dir)
  return dir
}
afterEach(() => {
  for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true })
})
function fixture(name = 'codex', flag = '0', size = 3): Buffer {
  const tar = Buffer.alloc(2048)
  tar.write(name)
  tar.write(size.toString(8).padStart(11, '0') + '\0', 124)
  tar.write(flag, 156)
  tar.fill(32, 148, 156)
  let sum = 0
  for (const byte of tar.subarray(0, 512)) sum += byte
  tar.write(sum.toString(8).padStart(6, '0') + '\0 ', 148)
  tar.write('bin', 512)
  return tar
}
function extract(tar: Buffer): Buffer {
  const gz = gzipSync(tar)
  return extractBinary(gz, {
    member: 'codex',
    archiveSha256: sha256(gz),
    binarySha256: sha256('bin')
  })
}
it('extracts exactly the verified regular member', () => {
  expect(extract(fixture()).toString()).toBe('bin')
})
it.each(['../codex', '/codex', 'dir/codex', 'dir\\codex'])('rejects archive path %s', (name) => {
  expect(() => extract(fixture(name))).toThrow()
})
it.each(['1', '2', '5', 'L', 'x'])('rejects tar type %s', (flag) => {
  expect(() => extract(fixture('codex', flag))).toThrow()
})
it('rejects truncation, trailing members, oversized payloads, corrupt headers and digest mismatch', () => {
  expect(() => extract(fixture().subarray(0, 1024))).toThrow()
  const trailing = fixture()
  trailing[1536] = 1
  expect(() => extract(trailing)).toThrow()
  expect(() => extract(fixture('codex', '0', 300 * 1024 * 1024))).toThrow()
  const corrupt = fixture()
  corrupt[0] = 1
  expect(() => extract(corrupt)).toThrow()
  const gz = gzipSync(fixture())
  expect(() =>
    extractBinary(gz, {
      member: 'codex',
      archiveSha256: sha256('other'),
      binarySha256: sha256('bin')
    })
  ).toThrow()
})
it('rejects unsupported platforms instead of selecting a likely asset', () => {
  expect(() => assertPin('linux', 'arm64')).toThrow()
  expect(() => assertPin('linux', 'x64')).toThrow()
  expect(() => assertPin('win32', 'arm64')).toThrow()
  expect(() => assertPin('darwin', 'x64')).toThrow()
  expect(() => assertPin('darwin', 'arm64')).not.toThrow()
  expect(() => assertPin('win32', 'x64')).not.toThrow()
})
it('separates the host check (a skip) from the pin check (a failure everywhere)', () => {
  expect(hostSupported('darwin', 'arm64')).toBe(true)
  expect(hostSupported('win32', 'x64')).toBe(true)
  expect(hostSupported('darwin', 'x64')).toBe(false)
  expect(hostSupported('linux', 'arm64')).toBe(false)
  expect(hostSupported('linux', 'x64')).toBe(false)
  expect(hostSupported('win32', 'arm64')).toBe(false)
  // The pinned version is reviewed in-tree, so this passes on every host; only a
  // package.json/manifest disagreement makes it throw.
  expect(() => assertManifestPin()).not.toThrow()
})
it('treats malformed/missing metadata and modified payload as cache misses', () => {
  const dir = temp()
  expect(cacheValid(dir)).toBe(false)
  writeFileSync(join(dir, 'version.json'), '{')
  expect(cacheValid(dir)).toBe(false)
  writeFileSync(join(dir, 'version.json'), JSON.stringify(manifest))
  writeFileSync(join(dir, 'codex'), 'not the binary')
  expect(cacheValid(dir)).toBe(false)
})
// Install names (the manifest keys) and release-asset names (the members) differ
// per host, and Windows carries the `.exe` suffix in both.
const INSTALL_NAMES: Record<string, string[]> = {
  'darwin-arm64': ['codex', 'codex-code-mode-host'],
  'win32-x64': ['codex.exe', 'codex-code-mode-host.exe']
}
const MEMBER_PATTERNS: Record<string, RegExp> = {
  'darwin-arm64': /^codex(-code-mode-host)?-aarch64-apple-darwin$/,
  'win32-x64': /^codex(-code-mode-host)?-x86_64-pc-windows-msvc\.exe$/
}
it('pins both release assets a code-mode-only catalog needs, for every reviewed host', () => {
  expect(Object.keys(manifest.hosts)).toStrictEqual(['darwin-arm64', 'win32-x64'])
  for (const key of Object.keys(manifest.hosts)) {
    const [platform, arch] = key.split('-')
    const host = hostManifest(platform, arch)
    // `hostManifest` flattens to exactly the version.json shape `cacheValid` compares.
    expect(Object.keys(host)).toStrictEqual([
      'version',
      'sourceCommit',
      'license',
      'licenseSha256',
      'platform',
      'arch',
      'binaries'
    ])
    expect(host).toMatchObject({
      version: manifest.version,
      sourceCommit: manifest.sourceCommit,
      license: manifest.license,
      licenseSha256: manifest.licenseSha256,
      platform,
      arch
    })
    expect(Object.keys(host.binaries)).toStrictEqual(INSTALL_NAMES[key])
    for (const entry of Object.values(host.binaries)) {
      expect(entry).toMatchObject({
        member: expect.stringMatching(MEMBER_PATTERNS[key]),
        archiveSha256: expect.stringMatching(/^[0-9a-f]{64}$/),
        binarySha256: expect.stringMatching(/^[0-9a-f]{64}$/)
      })
    }
  }
  expect(hostManifest('linux', 'x64')).toBeNull()
})
// The DRY seam: acquisition installs a host only if the manifest names it, and the
// runtime gate offers the engine only if this set names it. They must agree.
it('keeps the runtime host gate in parity with the acquisition manifest', () => {
  expect([...CODEX_SUPPORTED_HOSTS].sort()).toStrictEqual(Object.keys(manifest.hosts).sort())
})
// Provenance must name every host's `codex`, not just the one that ran the
// generator: the output is a pure function of the source commit, so `--check` has
// to reach the same verdict on macOS and on Windows.
it('records the codex payload digest of every reviewed host in provenance', () => {
  expect(codexBinaryDigests()).toStrictEqual({
    'darwin-arm64': manifest.hosts['darwin-arm64'].binaries.codex.binarySha256,
    'win32-x64': manifest.hosts['win32-x64'].binaries['codex.exe'].binarySha256
  })
  // The checked-in file is what a regeneration would emit for this pin.
  expect(provenance.codexBinaries).toStrictEqual(codexBinaryDigests())
  // The code-mode host is never an input, and a host missing its `codex` is an error.
  expect(Object.values(codexBinaryDigests())).not.toContain(
    manifest.hosts['darwin-arm64'].binaries['codex-code-mode-host'].binarySha256
  )
  expect(() =>
    codexBinaryDigests({ hosts: { 'linux-x64': { binaries: { 'codex.exe': {} } } } })
  ).toThrow()
})
it('parses repeated archives and a single license, rejecting anything else', () => {
  expect(parseArgs([])).toMatchObject({ force: false, archives: [] })
  expect(parseArgs(['--force'])).toMatchObject({ force: true })
  expect(parseArgs(['--archive', 'a', '--archive', 'b', '--license', 'l'])).toMatchObject({
    archives: ['a', 'b'],
    license: 'l'
  })
  expect(() => parseArgs(['--archive'])).toThrow()
  expect(() => parseArgs(['--archive', '--force'])).toThrow()
  expect(() => parseArgs(['--license', 'a', '--license', 'b'])).toThrow()
  expect(() => parseArgs(['--archive', 'a', '--archive', 'b', '--archive', 'c'])).toThrow()
  expect(() => parseArgs(['--update'])).toThrow()
})
it.skipIf(process.platform === 'win32')(
  'rejects mismatched executable version in isolated generator preflight (POSIX shell)',
  () => {
    const dir = temp()
    const binary = join(dir, 'wrong-version')
    writeFileSync(binary, '#!/bin/sh\nprintf "codex-cli 0.0.0\\n"\n')
    chmodSync(binary, 0o755)
    expect(() => verifyVersion(binary, dir, isolatedEnv(dir))).toThrow('Codex version mismatch')
  }
)
// `cacheValid` only ever reads what `expected` names, so one host's install names
// exercise it on every OS. The darwin record keeps the fixture file names POSIX.
const DARWIN = hostManifest('darwin', 'arm64')
const [CODEX, HOST] = Object.keys(DARWIN.binaries) as [string, string]
function twoMemberManifest(): typeof DARWIN {
  return {
    ...DARWIN,
    licenseSha256: sha256('license'),
    binaries: {
      [CODEX]: { ...DARWIN.binaries[CODEX], binarySha256: sha256('binary') },
      [HOST]: { ...DARWIN.binaries[HOST], binarySha256: sha256('host') }
    }
  }
}
function install(dir: string, saved: typeof DARWIN): void {
  writeFileSync(join(dir, 'version.json'), JSON.stringify(saved))
  writeFileSync(join(dir, CODEX), 'binary', { mode: 0o755 })
  writeFileSync(join(dir, HOST), 'host', { mode: 0o755 })
  writeFileSync(join(dir, 'LICENSE'), 'license')
}
it('verifies every member payload and the license bytes, not just saved metadata', () => {
  const dir = temp()
  const expected = twoMemberManifest()
  install(dir, expected)
  expect(cacheValid(dir, expected)).toBe(true)
  writeFileSync(join(dir, CODEX), 'corrupt')
  expect(cacheValid(dir, expected)).toBe(false)
  writeFileSync(join(dir, CODEX), 'binary')
  writeFileSync(join(dir, 'LICENSE'), 'corrupt')
  expect(cacheValid(dir, expected)).toBe(false)
})
it('treats a missing or stale code-mode host as a cache miss', () => {
  const dir = temp()
  const expected = twoMemberManifest()
  install(dir, expected)
  rmSync(join(dir, HOST))
  expect(cacheValid(dir, expected)).toBe(false)
  writeFileSync(join(dir, HOST), 'stale host', { mode: 0o755 })
  expect(cacheValid(dir, expected)).toBe(false)
})
it.skipIf(process.platform === 'win32')(
  'treats a non-executable member as a cache miss (POSIX mode bits)',
  () => {
    const dir = temp()
    const expected = twoMemberManifest()
    install(dir, expected)
    rmSync(join(dir, HOST))
    writeFileSync(join(dir, HOST), 'host', { mode: 0o644 })
    expect(cacheValid(dir, expected)).toBe(false)
    chmodSync(join(dir, HOST), 0o755)
    expect(cacheValid(dir, expected)).toBe(true)
  }
)
// Windows reports no exec bit at all - not even for files written 0o755 - so
// requiring one there would turn every postinstall into a 127 MB re-download.
it.runIf(process.platform === 'win32')(
  'accepts a correct install that carries no exec bits (Windows)',
  () => {
    const dir = temp()
    const expected = twoMemberManifest()
    install(dir, expected)
    expect(lstatSync(join(dir, CODEX)).mode & 0o111).toBe(0)
    expect(cacheValid(dir, expected)).toBe(true)
  }
)
it('treats a version.json that predates a pinned member as a cache miss', () => {
  const dir = temp()
  const expected = twoMemberManifest()
  const older = { ...expected.binaries }
  delete older[HOST]
  // Both files are on disk; only the recorded inventory is from an older pin.
  install(dir, { ...expected, binaries: older })
  expect(cacheValid(dir, expected)).toBe(false)
  install(dir, expected)
  expect(cacheValid(dir, expected)).toBe(true)
})
// The acquisition preflight runs `codex --version` with a hand-built environment;
// a missing USERPROFILE/TEMP on Windows or HOME on POSIX makes that fail.
it.skipIf(process.platform === 'win32')('isolates HOME, TMPDIR and CODEX_HOME (POSIX)', () => {
  const dir = temp()
  const env = isolatedEnv(dir)
  expect(Object.keys(env).sort()).toStrictEqual([
    'CODEX_HOME',
    'HOME',
    'LANG',
    'PATH',
    'RUST_LOG',
    'TMPDIR'
  ])
  expect(env.HOME).toBe(join(dir, 'home'))
  expect(env.CODEX_HOME).toBe(join(dir, 'home/.codex'))
  expect(env.TMPDIR).toBe(join(dir, 'tmp'))
  expect(existsSync(env.CODEX_HOME)).toBe(true)
  expect(existsSync(env.TMPDIR)).toBe(true)
})
it.runIf(process.platform === 'win32')(
  'isolates USERPROFILE, TEMP/TMP and CODEX_HOME (Windows)',
  () => {
    const dir = temp()
    const env = isolatedEnv(dir)
    expect(Object.keys(env).sort()).toStrictEqual([
      'CODEX_HOME',
      'PATH',
      'RUST_LOG',
      'SYSTEMROOT',
      'TEMP',
      'TMP',
      'USERPROFILE'
    ])
    expect(env.USERPROFILE).toBe(join(dir, 'home'))
    expect(env.CODEX_HOME).toBe(join(dir, 'home/.codex'))
    expect(env.TEMP).toBe(join(dir, 'tmp'))
    expect(env.TMP).toBe(env.TEMP)
    expect(env.PATH).toBe(join(env.SYSTEMROOT, 'System32'))
    expect(existsSync(env.CODEX_HOME)).toBe(true)
    expect(existsSync(env.TEMP)).toBe(true)
  }
)

it.each([false, true])(
  'preserves the old install when replacement fails, rollback failure=%s',
  (rollbackFails) => {
    const dir = temp()
    const stage = join(dir, 'stage')
    const destination = join(dir, 'installed')
    mkdirSync(join(stage, 'payload'), { recursive: true })
    mkdirSync(destination)
    writeFileSync(join(destination, 'codex'), 'old-install')
    writeFileSync(join(destination, HOST), 'old-host')
    writeFileSync(join(stage, 'payload/codex'), 'new-install')
    writeFileSync(join(stage, `payload/${HOST}`), 'new-host')
    const rename = vi.fn((from: string, to: string) => {
      if (from === join(stage, 'payload') || (rollbackFails && from === join(stage, 'previous'))) {
        throw new Error('private OS failure details')
      }
      renameSync(from, to)
    })
    let failure: unknown
    try {
      installStaged(stage, destination, rename)
    } catch (error) {
      failure = error
    }
    expect(rename).toHaveBeenCalledTimes(3)
    if (rollbackFails) {
      expect(failure).toBeInstanceOf(CodexRecoveryError)
      expect(failure).toMatchObject({ backup: join(stage, 'previous') })
      expect(String(failure)).not.toContain('private OS failure details')
      expect(readFileSync(join(stage, 'previous/codex'), 'utf8')).toBe('old-install')
      expect(readFileSync(join(stage, `previous/${HOST}`), 'utf8')).toBe('old-host')
      expect(existsSync(destination)).toBe(false)
    } else {
      expect(failure).toBeInstanceOf(Error)
      // Members are published by one directory rename, so a failed install can
      // never leave a new `codex` beside an old host or vice versa.
      expect(readFileSync(join(destination, 'codex'), 'utf8')).toBe('old-install')
      expect(readFileSync(join(destination, HOST), 'utf8')).toBe('old-host')
      expect(existsSync(stage)).toBe(false)
    }
  }
)
it('check mode detects changed, missing and extra output without rewriting', () => {
  const dir = temp()
  // A nested member: the generated map is keyed by posix names, and on Windows
  // `readdirSync` reports the same file with a backslash, which must still match.
  const files = new Map([
    ['generated.ts', 'expected'],
    ['v2/nested.ts', 'nested']
  ])
  mkdirSync(join(dir, 'v2'))
  writeFileSync(join(dir, 'v2/nested.ts'), 'nested')
  expect(() => checkOutput(dir, files)).toThrow('drift')
  writeFileSync(join(dir, 'generated.ts'), 'changed')
  expect(() => checkOutput(dir, files)).toThrow('drift')
  expect(readFileSync(join(dir, 'generated.ts'), 'utf8')).toBe('changed')
  writeFileSync(join(dir, 'generated.ts'), 'expected')
  expect(() => checkOutput(dir, files)).not.toThrow()
  writeFileSync(join(dir, 'extra.ts'), 'extra')
  expect(() => checkOutput(dir, files)).toThrow('drift')
})
