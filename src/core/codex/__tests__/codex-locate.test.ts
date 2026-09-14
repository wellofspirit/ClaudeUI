// @vitest-environment node
import { afterEach, expect, it, vi } from 'vitest'
import { lstatSync } from 'node:fs'
import { join } from 'node:path'
import { setHostPaths } from '../../host'
import {
  codexBinaryAvailable,
  codexHostSupported,
  codexLinuxSandboxWarning,
  locateCodexBinary,
  locateCodexCodeModeHost
} from '../codex-locate'
vi.mock('node:fs', () => ({ lstatSync: vi.fn() }))
afterEach(() => {
  setHostPaths(null)
  vi.resetAllMocks()
})
it('uses host dev path and never PATH', () => {
  setHostPaths({ getAppPath: () => '/project' })
  vi.mocked(lstatSync).mockReturnValue({ isFile: () => true } as ReturnType<typeof lstatSync>)
  expect(locateCodexBinary()).toBe(
    join('/project/vendor/codex-cli', process.platform === 'win32' ? 'codex.exe' : 'codex')
  )
})
it('tries packaged resource and unpacked paths, rejecting directories/symlinks', () => {
  setHostPaths({ getAppPath: () => '/Resources/app.asar' })
  vi.mocked(lstatSync).mockReturnValue({ isFile: () => false } as ReturnType<typeof lstatSync>)
  expect(locateCodexBinary()).toBeNull()
  expect(lstatSync).toHaveBeenCalledTimes(2)
  // extraResources puts the binaries beside app.asar, so that is the first probe.
  expect(vi.mocked(lstatSync).mock.calls[0][0]).toBe(
    join('/Resources/codex-cli', process.platform === 'win32' ? 'codex.exe' : 'codex')
  )
  expect(vi.mocked(lstatSync).mock.calls[1][0]).toContain('app.asar.unpacked')
})
it('returns unavailable rather than falling back to PATH', () => {
  vi.mocked(lstatSync).mockImplementation(() => {
    throw new Error('missing')
  })
  expect(locateCodexBinary()).toBeNull()
  expect(lstatSync).toHaveBeenCalledTimes(1)
})
// The set is guarded against `scripts/codex-digests.json#hosts` in codex-tooling.test.ts;
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
const HOST_NAME = process.platform === 'win32' ? 'codex-code-mode-host.exe' : 'codex-code-mode-host'
it.skipIf(!codexHostSupported())(
  'reports unavailable when the code-mode host is missing beside the binary',
  () => {
    setHostPaths({ getAppPath: () => '/project' })
    vi.mocked(lstatSync).mockImplementation((path) => {
      if (String(path).endsWith(HOST_NAME)) throw new Error('missing')
      return { isFile: () => true } as ReturnType<typeof lstatSync>
    })
    expect(locateCodexBinary()).not.toBeNull()
    expect(codexBinaryAvailable()).toBe(false)
    vi.mocked(lstatSync).mockReturnValue({ isFile: () => true } as ReturnType<typeof lstatSync>)
    expect(codexBinaryAvailable()).toBe(true)
  }
)
it.skipIf(!codexHostSupported())('locates the host only beside the located binary', () => {
  setHostPaths({ getAppPath: () => '/project' })
  vi.mocked(lstatSync).mockReturnValue({ isFile: () => true } as ReturnType<typeof lstatSync>)
  expect(locateCodexCodeModeHost()).toBe(join('/project/vendor/codex-cli', HOST_NAME))
  vi.mocked(lstatSync).mockReturnValue({ isFile: () => false } as ReturnType<typeof lstatSync>)
  expect(locateCodexCodeModeHost()).toBeNull()
  expect(codexBinaryAvailable()).toBe(false)
})

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
