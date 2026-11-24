/** @vitest-environment node */
import { describe, expect, it } from 'vitest'
import {
  INSTALL_MARKER_PRODUCT,
  INSTALL_MARKER_SEGMENTS,
  markerPlatformOf,
  parseInstallMarker,
  unexpectedEntries
} from '../install-marker'

const good = { schema: 1, product: INSTALL_MARKER_PRODUCT, kind: 'desktop', entries: ['a', 'b'] }

describe('parseInstallMarker', () => {
  it('accepts a desktop marker and copies its entries', () => {
    const parsed = parseInstallMarker(good)
    expect(parsed).toEqual(good)
    expect(parsed!.entries).not.toBe(good.entries)
  })

  it.each([
    ['null', null],
    ['an array', [good]],
    ['another schema', { ...good, schema: 2 }],
    ['another product', { ...good, product: 'com.example.app' }],
    ['another kind', { ...good, kind: 'server' }],
    ['entries missing', { ...good, entries: undefined }],
    ['an entry with a separator', { ...good, entries: ['a/b'] }],
    ['a backslash entry', { ...good, entries: ['a\\b'] }],
    ['a dot-dot entry', { ...good, entries: ['..'] }],
    ['an empty entry', { ...good, entries: [''] }],
    ['a non-string entry', { ...good, entries: [1] }]
  ])('refuses %s', (_name, raw) => {
    expect(parseInstallMarker(raw)).toBeNull()
  })
})

describe('unexpectedEntries', () => {
  const marker = parseInstallMarker({ ...good, entries: ['ClaudeUI.exe', 'resources'] })!

  it('lists what the marker does not, sorted', () => {
    expect(
      unexpectedEntries(['resources', 'notes.txt', 'ClaudeUI.exe', 'Downloads.lnk'], marker, true)
    ).toEqual(['Downloads.lnk', 'notes.txt'])
  })

  it('compares case-insensitively only when asked (Windows)', () => {
    expect(unexpectedEntries(['RESOURCES'], marker, true)).toEqual([])
    expect(unexpectedEntries(['RESOURCES'], marker, false)).toEqual(['RESOURCES'])
  })
})

describe('layout', () => {
  it('maps platforms and places the marker in the resources folder', () => {
    expect(markerPlatformOf('darwin')).toBe('mac')
    expect(markerPlatformOf('win32')).toBe('win')
    expect(markerPlatformOf('linux')).toBeNull()
    expect(INSTALL_MARKER_SEGMENTS.mac.join('/')).toBe('Contents/Resources/claudeui-install.json')
    expect(INSTALL_MARKER_SEGMENTS.win.join('/')).toBe('resources/claudeui-install.json')
  })
})
