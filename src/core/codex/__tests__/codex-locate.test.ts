// @vitest-environment node
import { afterEach, expect, it, vi } from 'vitest'
import { lstatSync } from 'node:fs'
import { join } from 'node:path'
import { setHostPaths } from '../../host'
import { locateCodexBinary } from '../codex-locate'
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
