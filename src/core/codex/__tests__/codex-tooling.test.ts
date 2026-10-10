// @vitest-environment node
/**
 * The Codex development tooling (`scripts/codex-tooling.mjs`,
 * `scripts/generate-codex-protocol.mjs`) and the parities around the release
 * manifest. Acquisition itself is the app's installer now (ADR-082 §8): its
 * archive, digest and staging checks live in
 * `src/core/harness/install/__tests__/`.
 */
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import {
  assertPin,
  hostSupported,
  isolatedEnv,
  manifest,
  storeCodexExecutable,
  verifyVersion
} from '../../../../scripts/codex-tooling.mjs'
import {
  checkOutput,
  codexBinaryDigests,
  serverMethods
} from '../../../../scripts/generate-codex-protocol.mjs'
import { HARNESS_STORE_ENV } from '../../harness/store'
import { CODEX_SUPPORTED_HOSTS } from '../codex-locate'
import provenance from '../protocol/provenance.json'
import { fakeHarnessInstall } from '../../../test/helpers/fake-harness'

const directories: string[] = []
function temp(): string {
  const dir = mkdtempSync(join(tmpdir(), 'codex-tooling-test-'))
  directories.push(dir)
  return dir
}
const savedStore = process.env[HARNESS_STORE_ENV]
afterEach(() => {
  for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true })
  if (savedStore === undefined) delete process.env[HARNESS_STORE_ENV]
  else process.env[HARNESS_STORE_ENV] = savedStore
})

it('rejects unsupported platforms instead of selecting a likely asset', () => {
  expect(() => assertPin('linux', 'ia32')).toThrow()
  expect(() => assertPin('win32', 'arm64')).toThrow()
  expect(() => assertPin('darwin', 'x64')).toThrow()
  expect(() => assertPin('darwin', 'arm64')).not.toThrow()
  expect(() => assertPin('win32', 'x64')).not.toThrow()
  expect(() => assertPin('linux', 'x64')).not.toThrow()
  expect(() => assertPin('linux', 'arm64')).not.toThrow()
  expect(hostSupported('linux', 'ia32')).toBe(false)
})

// Install names (the manifest keys) and release-asset names (the members) differ
// per host, and Windows carries the `.exe` suffix in both.
const INSTALL_NAMES: Record<string, string[]> = {
  'darwin-arm64': ['codex', 'codex-code-mode-host'],
  'win32-x64': ['codex.exe', 'codex-code-mode-host.exe'],
  'linux-x64': ['codex', 'codex-code-mode-host'],
  'linux-arm64': ['codex', 'codex-code-mode-host']
}
const MEMBER_PATTERNS: Record<string, RegExp> = {
  'darwin-arm64': /^codex(-code-mode-host)?-aarch64-apple-darwin$/,
  'win32-x64': /^codex(-code-mode-host)?-x86_64-pc-windows-msvc\.exe$/,
  'linux-x64': /^codex(-code-mode-host)?-x86_64-unknown-linux-musl$/,
  'linux-arm64': /^codex(-code-mode-host)?-aarch64-unknown-linux-musl$/
}
it('pins both release assets a code-mode-only catalog needs, for every reviewed host', () => {
  expect(Object.keys(manifest.platforms)).toStrictEqual([
    'darwin-arm64',
    'win32-x64',
    'linux-x64',
    'linux-arm64'
  ])
  expect(manifest.sourceCommit).toMatch(/^[0-9a-f]{40}$/)
  expect(manifest.license).toBe(
    `https://raw.githubusercontent.com/openai/codex/${manifest.sourceCommit}/LICENSE`
  )
  expect(manifest.licenseSha256).toMatch(/^[0-9a-f]{64}$/)
  for (const [key, host] of Object.entries(manifest.platforms) as Array<
    [string, { binaries: Record<string, Record<string, string>> }]
  >) {
    const [platform, arch] = key.split('-')
    expect(hostSupported(platform, arch)).toBe(true)
    expect(Object.keys(host.binaries)).toStrictEqual(INSTALL_NAMES[key])
    for (const entry of Object.values(host.binaries)) {
      expect(entry).toStrictEqual({
        member: expect.stringMatching(MEMBER_PATTERNS[key]),
        archiveSha256: expect.stringMatching(/^[0-9a-f]{64}$/),
        binarySha256: expect.stringMatching(/^[0-9a-f]{64}$/)
      })
    }
  }
})
// The DRY seam: the installer installs a host only if the manifest names it, and
// the runtime gate offers the engine only if this set names it. They must agree.
it('keeps the runtime host gate in parity with the acquisition manifest', () => {
  expect([...CODEX_SUPPORTED_HOSTS].sort()).toStrictEqual(Object.keys(manifest.platforms).sort())
})
// The exact-version gate (`CodexAppServerClient.checkVersion`) reads provenance;
// the installer installs the manifest's `tested`. A bump must move both.
it('pins the same Codex version the generated protocol was built from', () => {
  expect(manifest.tested).toBe(provenance.version)
})
// Provenance must name every host's `codex`, not just the one that ran the
// generator: the output is a pure function of the source commit, so `--check` has
// to reach the same verdict on every reviewed host.
it('records the codex payload digest of every reviewed host in provenance', () => {
  expect(codexBinaryDigests()).toStrictEqual({
    'darwin-arm64': manifest.platforms['darwin-arm64'].binaries.codex.binarySha256,
    'win32-x64': manifest.platforms['win32-x64'].binaries['codex.exe'].binarySha256,
    'linux-x64': manifest.platforms['linux-x64'].binaries.codex.binarySha256,
    'linux-arm64': manifest.platforms['linux-arm64'].binaries.codex.binarySha256
  })
  // The checked-in file is what a regeneration would emit for this pin.
  expect(provenance.codexBinaries).toStrictEqual(codexBinaryDigests())
  // The code-mode host is never an input, and a host missing its `codex` is an error.
  expect(Object.values(codexBinaryDigests())).not.toContain(
    manifest.platforms['darwin-arm64'].binaries['codex-code-mode-host'].binarySha256
  )
  expect(() =>
    codexBinaryDigests({ platforms: { 'linux-x64': { binaries: { 'codex.exe': {} } } } })
  ).toThrow()
})

// The scripts run the pinned Codex from ClaudeUI's managed store, never a
// vendored copy or whatever the resolver would pick.
it('finds the pinned Codex only as a valid install of the tested version in the store', () => {
  const store = temp()
  process.env[HARNESS_STORE_ENV] = store
  expect(storeCodexExecutable()).toBeNull()
  // Another version, or the tested one without a valid install.json, is not it.
  fakeHarnessInstall(store, 'codex', '0.1.0')
  fakeHarnessInstall(store, 'codex', manifest.tested, { record: null })
  expect(storeCodexExecutable()).toBeNull()
  const dir = fakeHarnessInstall(store, 'codex', manifest.tested)
  expect(storeCodexExecutable()).toBe(
    join(dir, process.platform === 'win32' ? 'codex.exe' : 'codex')
  )
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

// The generator runs `codex --version` and `generate-ts` with a hand-built
// environment; a missing USERPROFILE/TEMP on Windows or HOME on POSIX makes
// that fail.
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

/**
 * Slice 4b guard 1 — the MCP approval elicitation is in the generator's
 * selection, so the two upstream types it needs stay generated and pinned. A
 * method missing here regenerates a `methods.ts` without it, which makes the
 * session's own registration a type error long before anything reaches a
 * binary.
 */
it('selects the MCP elicitation server request for generation', () => {
  expect(serverMethods['mcpServer/elicitation/request']).toEqual([
    'McpServerElicitationRequestParams',
    'McpServerElicitationRequestResponse'
  ])
  expect(provenance.roots).toContain('v2/McpServerElicitationRequestParams')
  expect(provenance.roots).toContain('v2/McpServerElicitationRequestResponse')
})
