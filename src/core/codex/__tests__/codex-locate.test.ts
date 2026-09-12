// @vitest-environment node
import { afterEach, expect, it, vi } from 'vitest'
import { lstatSync } from 'node:fs'
import { join } from 'node:path'
import { setHostPaths } from '../../host'
import { codexBinaryAvailable, locateCodexBinary, locateCodexCodeModeHost } from '../codex-locate'
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
it('tries reserved packaged resource and unpacked paths, rejecting directories/symlinks', () => {
  setHostPaths({ getAppPath: () => '/Resources/app.asar' })
  vi.mocked(lstatSync).mockReturnValue({ isFile: () => false } as ReturnType<typeof lstatSync>)
  expect(locateCodexBinary()).toBeNull()
  expect(lstatSync).toHaveBeenCalledTimes(2)
  expect(vi.mocked(lstatSync).mock.calls[1][0]).toContain('app.asar.unpacked')
})
it('returns unavailable rather than falling back to PATH', () => {
  vi.mocked(lstatSync).mockImplementation(() => {
    throw new Error('missing')
  })
  expect(locateCodexBinary()).toBeNull()
  expect(lstatSync).toHaveBeenCalledTimes(1)
})
const onSupportedHost = process.platform === 'darwin' && process.arch === 'arm64'
it.skipIf(!onSupportedHost)(
  'reports unavailable when the code-mode host is missing beside the binary (macOS arm64)',
  () => {
    setHostPaths({ getAppPath: () => '/project' })
    vi.mocked(lstatSync).mockImplementation((path) => {
      if (String(path).endsWith('codex-code-mode-host')) throw new Error('missing')
      return { isFile: () => true } as ReturnType<typeof lstatSync>
    })
    expect(locateCodexBinary()).not.toBeNull()
    expect(codexBinaryAvailable()).toBe(false)
    vi.mocked(lstatSync).mockReturnValue({ isFile: () => true } as ReturnType<typeof lstatSync>)
    expect(codexBinaryAvailable()).toBe(true)
  }
)
it.skipIf(!onSupportedHost)('locates the host only beside the located binary (macOS arm64)', () => {
  setHostPaths({ getAppPath: () => '/project' })
  vi.mocked(lstatSync).mockReturnValue({ isFile: () => true } as ReturnType<typeof lstatSync>)
  expect(locateCodexCodeModeHost()).toBe(join('/project/vendor/codex-cli', 'codex-code-mode-host'))
  vi.mocked(lstatSync).mockReturnValue({ isFile: () => false } as ReturnType<typeof lstatSync>)
  expect(locateCodexCodeModeHost()).toBeNull()
  expect(codexBinaryAvailable()).toBe(false)
})
