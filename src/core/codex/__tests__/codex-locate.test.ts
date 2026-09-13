// @vitest-environment node
import { afterEach, expect, it, vi } from 'vitest'
import { lstatSync } from 'node:fs'
import { join } from 'node:path'
import { setHostPaths } from '../../host'
import {
  codexBinaryAvailable,
  codexHostSupported,
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
  expect(codexHostSupported('win32', 'arm64')).toBe(false)
  expect(codexHostSupported('darwin', 'x64')).toBe(false)
  expect(codexHostSupported('linux', 'x64')).toBe(false)
  expect(codexHostSupported('linux', 'arm64')).toBe(false)
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
