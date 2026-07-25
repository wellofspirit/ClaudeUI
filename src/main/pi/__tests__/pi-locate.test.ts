/**
 * @vitest-environment node
 *
 * Minimal unit tests for pi-locate.ts's dev/production path resolution —
 * mirrors the OpencodeServerManager.locateBinary()/locateBunClaude() split
 * this module was written to match. `electron`'s `app` and `node:fs`'s
 * `statSync` are mocked so no real vendor/pi-cli directory is required.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const { mockGetAppPath, mockStatSync } = vi.hoisted(() => ({
  mockGetAppPath: vi.fn(),
  mockStatSync: vi.fn()
}))

vi.mock('electron', () => ({
  app: { getAppPath: mockGetAppPath }
}))
vi.mock('node:fs', () => ({
  statSync: mockStatSync
}))

import { locatePiBinary, piBinaryAvailable } from '../pi-locate'

const BINARY_NAME = process.platform === 'win32' ? 'pi.exe' : 'pi'
const fileStat = { isFile: () => true }
const directoryStat = { isFile: () => false }

function normalized(path: unknown): string {
  return String(path).replace(/\\/g, '/')
}

function mockFiles(...files: string[]): void {
  mockStatSync.mockImplementation((path: string) => {
    if (files.includes(normalized(path))) return fileStat
    throw new Error('ENOENT')
  })
}

beforeEach(() => {
  mockGetAppPath.mockReset()
  mockStatSync.mockReset()
})

describe('locatePiBinary — dev path resolution', () => {
  it('resolves <appPath>/vendor/pi-cli/<binary> when it exists (appPath has no app.asar)', () => {
    mockGetAppPath.mockReturnValue('/project/root')
    const expected = `/project/root/vendor/pi-cli/${BINARY_NAME}`
    mockFiles(expected)

    const result = locatePiBinary()
    expect(result?.replace(/\\/g, '/')).toBe(expected)
  })

  it('returns null when the dev vendor path does not exist', () => {
    mockGetAppPath.mockReturnValue('/project/root')
    mockStatSync.mockImplementation(() => {
      throw new Error('ENOENT')
    })

    expect(locatePiBinary()).toBeNull()
  })

  it('skips a directory at the flat path and resolves the nested release executable', () => {
    mockGetAppPath.mockReturnValue('/project/root')
    const flat = `/project/root/vendor/pi-cli/${BINARY_NAME}`
    const nested = `/project/root/vendor/pi-cli/pi/${BINARY_NAME}`
    mockStatSync.mockImplementation((path: string) => {
      const candidate = normalized(path)
      if (candidate === flat) return directoryStat
      if (candidate === nested) return fileStat
      throw new Error('ENOENT')
    })

    expect(locatePiBinary()?.replace(/\\/g, '/')).toBe(nested)
  })

  it('returns null when the flat path is a directory without a nested executable', () => {
    mockGetAppPath.mockReturnValue('/project/root')
    const flat = `/project/root/vendor/pi-cli/${BINARY_NAME}`
    mockStatSync.mockImplementation((path: string) => {
      if (normalized(path) === flat) return directoryStat
      throw new Error('ENOENT')
    })

    expect(locatePiBinary()).toBeNull()
  })
})

describe('locatePiBinary — production candidate ordering', () => {
  const packagedAppPath = '/Applications/ClaudeUI.app/Contents/Resources/app.asar'
  const primaryCandidate = `/Applications/ClaudeUI.app/Contents/Resources/pi-cli/${BINARY_NAME}`
  const nestedPrimaryCandidate = `/Applications/ClaudeUI.app/Contents/Resources/pi-cli/pi/${BINARY_NAME}`
  const fallbackCandidate = `/Applications/ClaudeUI.app/Contents/Resources/app.asar.unpacked/vendor/pi-cli/${BINARY_NAME}`
  const nestedFallbackCandidate = `/Applications/ClaudeUI.app/Contents/Resources/app.asar.unpacked/vendor/pi-cli/pi/${BINARY_NAME}`

  it('prefers the primary extraResources candidate when it exists', () => {
    mockGetAppPath.mockReturnValue(packagedAppPath)
    mockFiles(primaryCandidate)

    expect(locatePiBinary()?.replace(/\\/g, '/')).toBe(primaryCandidate)
  })

  it('falls back to the app.asar.unpacked candidate when the primary is absent', () => {
    mockGetAppPath.mockReturnValue(packagedAppPath)
    mockFiles(fallbackCandidate)

    expect(locatePiBinary()?.replace(/\\/g, '/')).toBe(fallbackCandidate)
  })

  it('checks the primary candidate BEFORE the fallback — both existing still returns the primary', () => {
    mockGetAppPath.mockReturnValue(packagedAppPath)
    mockFiles(primaryCandidate, fallbackCandidate)

    expect(locatePiBinary()?.replace(/\\/g, '/')).toBe(primaryCandidate)
  })

  it('returns null when neither production candidate exists', () => {
    mockGetAppPath.mockReturnValue(packagedAppPath)
    mockStatSync.mockImplementation(() => {
      throw new Error('ENOENT')
    })

    expect(locatePiBinary()).toBeNull()
  })

  it('resolves the nested extraResources release executable', () => {
    mockGetAppPath.mockReturnValue(packagedAppPath)
    mockFiles(nestedPrimaryCandidate)

    expect(locatePiBinary()?.replace(/\\/g, '/')).toBe(nestedPrimaryCandidate)
  })

  it('prefers nested extraResources over a flat app.asar.unpacked fallback', () => {
    mockGetAppPath.mockReturnValue(packagedAppPath)
    mockFiles(nestedPrimaryCandidate, fallbackCandidate)

    expect(locatePiBinary()?.replace(/\\/g, '/')).toBe(nestedPrimaryCandidate)
  })

  it('resolves the nested app.asar.unpacked fallback', () => {
    mockGetAppPath.mockReturnValue(packagedAppPath)
    mockFiles(nestedFallbackCandidate)

    expect(locatePiBinary()?.replace(/\\/g, '/')).toBe(nestedFallbackCandidate)
  })
})

describe('piBinaryAvailable', () => {
  it('mirrors locatePiBinary — true when the dev vendor path exists', () => {
    mockGetAppPath.mockReturnValue('/project/root')
    mockStatSync.mockReturnValue(fileStat)
    expect(piBinaryAvailable()).toBe(true)
  })

  it('false when locatePiBinary resolves to null', () => {
    mockGetAppPath.mockReturnValue('/project/root')
    mockStatSync.mockImplementation(() => {
      throw new Error('ENOENT')
    })
    expect(piBinaryAvailable()).toBe(false)
  })

  it('false (never throws) when statSync itself throws', () => {
    mockGetAppPath.mockReturnValue('/project/root')
    mockStatSync.mockImplementation(() => {
      throw new Error('EPERM')
    })
    expect(() => piBinaryAvailable()).not.toThrow()
    expect(piBinaryAvailable()).toBe(false)
  })
})
