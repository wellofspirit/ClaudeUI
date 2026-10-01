// @vitest-environment node
/**
 * codex-locate.ts delegates to the harness resolver (ADR-082). Codex is not
 * bundled (§8): it runs from ClaudeUI's managed store at the pin (or a System
 * install), never from a vendored copy and never from PATH. A real temp store
 * stands in; the resolver caches, so every test starts from
 * `invalidateHarness()`.
 */
import { afterEach, beforeEach, expect, it } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { setHostPaths } from '../../host'
import { harnessManifest } from '../../harness/manifests'
import { invalidateHarness } from '../../harness/resolve'
import { HARNESS_STORE_ENV } from '../../harness/store'
import {
  exeName,
  fakeHarnessInstall,
  writeHarnessPayload
} from '../../../test/helpers/fake-harness'
import {
  codexBinaryAvailable,
  codexHostSupported,
  codexLinuxSandboxWarning,
  locateCodexBinary,
  locateCodexCodeModeHost
} from '../codex-locate'

const TESTED = harnessManifest('codex').tested
let tmp: string
let store: string
const saved = { store: process.env[HARNESS_STORE_ENV], override: process.env.CLAUDEUI_CODEX_CLI }
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-locate-'))
  store = path.join(tmp, 'store')
  process.env[HARNESS_STORE_ENV] = store
  delete process.env.CLAUDEUI_CODEX_CLI
  setHostPaths({ getAppPath: () => path.join(tmp, 'app') })
  invalidateHarness()
})
afterEach(() => {
  setHostPaths(null)
  if (saved.store === undefined) delete process.env[HARNESS_STORE_ENV]
  else process.env[HARNESS_STORE_ENV] = saved.store
  if (saved.override === undefined) delete process.env.CLAUDEUI_CODEX_CLI
  else process.env.CLAUDEUI_CODEX_CLI = saved.override
  fs.rmSync(tmp, { recursive: true, force: true })
  invalidateHarness()
})
it("runs the pinned Codex from ClaudeUI's store", () => {
  const dir = fakeHarnessInstall(store, 'codex', TESTED)
  expect(locateCodexBinary()).toBe(path.join(dir, exeName('codex')))
})
it('never falls back to a vendored copy, a packaged one, or PATH', () => {
  writeHarnessPayload(path.join(tmp, 'app', 'vendor', 'codex-cli'), 'codex')
  const onPath = writeHarnessPayload(path.join(tmp, 'bin'), 'codex')
  const savedPath = process.env.PATH
  process.env.PATH = `${path.dirname(onPath)}${path.delimiter}${savedPath ?? ''}`
  try {
    expect(locateCodexBinary()).toBeNull()
    expect(codexBinaryAvailable()).toBe(false)
  } finally {
    process.env.PATH = savedPath
  }
  const resources = path.join(tmp, 'Resources')
  setHostPaths({ getAppPath: () => path.join(resources, 'app.asar') })
  writeHarnessPayload(path.join(resources, 'codex-cli'), 'codex')
  invalidateHarness()
  expect(locateCodexBinary()).toBeNull()
})
// The set is guarded against `src/shared/harness-manifests/codex.json#platforms` in codex-tooling.test.ts;
// here only the predicate's own shape matters.
it('gates on the hosts with a reviewed acquisition manifest', () => {
  expect(codexHostSupported('darwin', 'arm64')).toBe(true)
  expect(codexHostSupported('win32', 'x64')).toBe(true)
  expect(codexHostSupported('linux', 'x64')).toBe(true)
  expect(codexHostSupported('linux', 'arm64')).toBe(true)
  expect(codexHostSupported('win32', 'arm64')).toBe(false)
  expect(codexHostSupported('darwin', 'x64')).toBe(false)
  expect(codexHostSupported('linux', 'ia32')).toBe(false)
})
it.skipIf(!codexHostSupported())(
  'reports unavailable when the code-mode host is missing beside the binary',
  () => {
    fakeHarnessInstall(store, 'codex', TESTED, { codeModeHost: false })
    expect(locateCodexBinary()).not.toBeNull()
    expect(locateCodexCodeModeHost()).toBeNull()
    expect(codexBinaryAvailable()).toBe(false)
    const dir = fakeHarnessInstall(store, 'codex', TESTED)
    invalidateHarness()
    expect(locateCodexCodeModeHost()).toBe(path.join(dir, exeName('codex-code-mode-host')))
    expect(codexBinaryAvailable()).toBe(true)
  }
)

/**
 * The Linux sandbox is bubblewrap, and Codex finds it the way `which` would: a
 * walk of PATH for an executable file named `bwrap`. Without one, every
 * sandboxed command panics `bubblewrap is unavailable`, so the server says so at
 * boot rather than at the first command.
 */
const executables = (...paths: string[]) => {
  const allowed = new Set(paths)
  return (path: string): boolean => allowed.has(path)
}
it('says nothing about bubblewrap off Linux, whatever PATH holds', () => {
  expect(codexLinuxSandboxWarning('darwin', {}, () => false)).toBeNull()
  expect(codexLinuxSandboxWarning('win32', { PATH: 'C:\\Windows' }, () => false)).toBeNull()
})
it('accepts a bwrap found anywhere on PATH, not just its first entry', () => {
  expect(
    codexLinuxSandboxWarning(
      'linux',
      { PATH: '/opt/empty:/usr/bin:/usr/local/bin' },
      executables('/usr/bin/bwrap')
    )
  ).toBeNull()
})
it('warns when Linux has no bwrap on PATH', () => {
  const warning = codexLinuxSandboxWarning('linux', { PATH: '/usr/bin:/bin' }, () => false)
  expect(warning).toContain('Codex sandboxed commands need bubblewrap')
  expect(warning).toContain('no `bwrap` on PATH')
  // An empty, missing or entry-free PATH is the same answer, not a crash.
  expect(codexLinuxSandboxWarning('linux', {}, () => false)).toBe(warning)
  expect(codexLinuxSandboxWarning('linux', { PATH: '::' }, () => false)).toBe(warning)
})
it('does not count a PATH entry that is itself a directory named bwrap', () => {
  // A PATH entry is a directory to look INSIDE, so `/opt/bwrap` holding nothing
  // is still a miss; only `/opt/bwrap/bwrap` is the executable Codex runs.
  expect(
    codexLinuxSandboxWarning('linux', { PATH: '/opt/bwrap' }, executables('/opt/bwrap'))
  ).toContain('no `bwrap` on PATH')
  expect(
    codexLinuxSandboxWarning('linux', { PATH: '/opt/bwrap' }, executables('/opt/bwrap/bwrap'))
  ).toBeNull()
})
