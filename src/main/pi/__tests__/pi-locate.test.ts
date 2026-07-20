/**
 * @vitest-environment node
 *
 * Minimal unit tests for pi-locate.ts's dev/production path resolution —
 * mirrors the OpencodeServerManager.locateBinary()/locateBunClaude() split
 * this module was written to match. `electron`'s `app` and `node:fs`'s
 * `existsSync` are mocked so no real vendor/pi-cli directory is required.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const { mockGetAppPath, mockExistsSync } = vi.hoisted(() => ({
  mockGetAppPath: vi.fn(),
  mockExistsSync: vi.fn()
}))

vi.mock('electron', () => ({
  app: { getAppPath: mockGetAppPath }
}))
vi.mock('node:fs', () => ({
  existsSync: mockExistsSync
}))

import { locatePiBinary, piBinaryAvailable } from '../pi-locate'

const BINARY_NAME = process.platform === 'win32' ? 'pi.exe' : 'pi'

beforeEach(() => {
  mockGetAppPath.mockReset()
  mockExistsSync.mockReset()
})

describe('locatePiBinary — dev path resolution', () => {
  it('resolves <appPath>/vendor/pi-cli/<binary> when it exists (appPath has no app.asar)', () => {
    mockGetAppPath.mockReturnValue('/project/root')
    const expected = `/project/root/vendor/pi-cli/${BINARY_NAME}`
    mockExistsSync.mockImplementation((p: string) => p.replace(/\\/g, '/') === expected)

    const result = locatePiBinary()
    expect(result?.replace(/\\/g, '/')).toBe(expected)
  })

  it('returns null when the dev vendor path does not exist', () => {
    mockGetAppPath.mockReturnValue('/project/root')
    mockExistsSync.mockReturnValue(false)

    expect(locatePiBinary()).toBeNull()
  })
})

describe('locatePiBinary — production candidate ordering', () => {
  const packagedAppPath = '/Applications/ClaudeUI.app/Contents/Resources/app.asar'
  const primaryCandidate = `/Applications/ClaudeUI.app/Contents/Resources/pi-cli/${BINARY_NAME}`
  const fallbackCandidate = `/Applications/ClaudeUI.app/Contents/Resources/app.asar.unpacked/vendor/pi-cli/${BINARY_NAME}`

  it('prefers the primary extraResources candidate when it exists', () => {
    mockGetAppPath.mockReturnValue(packagedAppPath)
    mockExistsSync.mockImplementation((p: string) => p.replace(/\\/g, '/') === primaryCandidate)

    expect(locatePiBinary()?.replace(/\\/g, '/')).toBe(primaryCandidate)
  })

  it('falls back to the app.asar.unpacked candidate when the primary is absent', () => {
    mockGetAppPath.mockReturnValue(packagedAppPath)
    mockExistsSync.mockImplementation((p: string) => p.replace(/\\/g, '/') === fallbackCandidate)

    expect(locatePiBinary()?.replace(/\\/g, '/')).toBe(fallbackCandidate)
  })

  it('checks the primary candidate BEFORE the fallback — both existing still returns the primary', () => {
    mockGetAppPath.mockReturnValue(packagedAppPath)
    mockExistsSync.mockReturnValue(true) // both candidates "exist"

    expect(locatePiBinary()?.replace(/\\/g, '/')).toBe(primaryCandidate)
  })

  it('returns null when neither production candidate exists', () => {
    mockGetAppPath.mockReturnValue(packagedAppPath)
    mockExistsSync.mockReturnValue(false)

    expect(locatePiBinary()).toBeNull()
  })
})

describe('piBinaryAvailable', () => {
  it('mirrors locatePiBinary — true when the dev vendor path exists', () => {
    mockGetAppPath.mockReturnValue('/project/root')
    mockExistsSync.mockReturnValue(true)
    expect(piBinaryAvailable()).toBe(true)
  })

  it('false when locatePiBinary resolves to null', () => {
    mockGetAppPath.mockReturnValue('/project/root')
    mockExistsSync.mockReturnValue(false)
    expect(piBinaryAvailable()).toBe(false)
  })

  it('false (never throws) when existsSync itself throws', () => {
    mockGetAppPath.mockReturnValue('/project/root')
    mockExistsSync.mockImplementation(() => {
      throw new Error('EPERM')
    })
    expect(() => piBinaryAvailable()).not.toThrow()
    expect(piBinaryAvailable()).toBe(false)
  })
})
