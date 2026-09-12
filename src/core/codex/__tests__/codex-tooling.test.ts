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
  existsSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import {
  assertPin,
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
import { checkOutput } from '../../../../scripts/generate-codex-protocol.mjs'
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
  expect(() => extractBinary(gzipSync(fixture()))).toThrow()
})
it('rejects unsupported platforms instead of selecting a likely asset', () => {
  expect(() => assertPin('linux', 'arm64')).toThrow()
  expect(() => assertPin('win32', 'x64')).toThrow()
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
it('pins both release assets a code-mode-only catalog needs', () => {
  expect(Object.keys(manifest.binaries)).toStrictEqual(['codex', 'codex-code-mode-host'])
  for (const entry of Object.values(manifest.binaries)) {
    expect(entry).toMatchObject({
      member: expect.stringMatching(/^codex(-code-mode-host)?-aarch64-apple-darwin$/),
      archiveSha256: expect.stringMatching(/^[0-9a-f]{64}$/),
      binarySha256: expect.stringMatching(/^[0-9a-f]{64}$/)
    })
  }
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
const HOST = 'codex-code-mode-host'
function twoMemberManifest(): typeof manifest {
  return {
    ...manifest,
    licenseSha256: sha256('license'),
    binaries: {
      codex: { ...manifest.binaries.codex, binarySha256: sha256('binary') },
      [HOST]: { ...manifest.binaries[HOST], binarySha256: sha256('host') }
    }
  }
}
function install(dir: string, saved: typeof manifest): void {
  writeFileSync(join(dir, 'version.json'), JSON.stringify(saved))
  writeFileSync(join(dir, 'codex'), 'binary', { mode: 0o755 })
  writeFileSync(join(dir, HOST), 'host', { mode: 0o755 })
  writeFileSync(join(dir, 'LICENSE'), 'license')
}
it.skipIf(process.platform === 'win32')(
  'verifies every member payload and the license bytes, not just saved metadata (POSIX mode bits)',
  () => {
    const dir = temp()
    const expected = twoMemberManifest()
    install(dir, expected)
    expect(cacheValid(dir, expected)).toBe(true)
    writeFileSync(join(dir, 'codex'), 'corrupt')
    expect(cacheValid(dir, expected)).toBe(false)
    writeFileSync(join(dir, 'codex'), 'binary')
    writeFileSync(join(dir, 'LICENSE'), 'corrupt')
    expect(cacheValid(dir, expected)).toBe(false)
  }
)
it.skipIf(process.platform === 'win32')(
  'treats a missing, stale or non-executable code-mode host as a cache miss (POSIX mode bits)',
  () => {
    const dir = temp()
    const expected = twoMemberManifest()
    install(dir, expected)
    rmSync(join(dir, HOST))
    expect(cacheValid(dir, expected)).toBe(false)
    writeFileSync(join(dir, HOST), 'stale host', { mode: 0o755 })
    expect(cacheValid(dir, expected)).toBe(false)
    rmSync(join(dir, HOST))
    writeFileSync(join(dir, HOST), 'host', { mode: 0o644 })
    expect(cacheValid(dir, expected)).toBe(false)
    chmodSync(join(dir, HOST), 0o755)
    expect(cacheValid(dir, expected)).toBe(true)
  }
)
it.skipIf(process.platform === 'win32')(
  'treats a version.json that predates a pinned member as a cache miss (POSIX mode bits)',
  () => {
    const dir = temp()
    const expected = twoMemberManifest()
    const older = { ...expected.binaries }
    delete older[HOST]
    // Both files are on disk; only the recorded inventory is from an older pin.
    install(dir, { ...expected, binaries: older })
    expect(cacheValid(dir, expected)).toBe(false)
    install(dir, expected)
    expect(cacheValid(dir, expected)).toBe(true)
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
  const files = new Map([['generated.ts', 'expected']])
  expect(() => checkOutput(dir, files)).toThrow('drift')
  writeFileSync(join(dir, 'generated.ts'), 'changed')
  expect(() => checkOutput(dir, files)).toThrow('drift')
  expect(readFileSync(join(dir, 'generated.ts'), 'utf8')).toBe('changed')
  writeFileSync(join(dir, 'generated.ts'), 'expected')
  expect(() => checkOutput(dir, files)).not.toThrow()
  writeFileSync(join(dir, 'extra.ts'), 'extra')
  expect(() => checkOutput(dir, files)).toThrow('drift')
})
