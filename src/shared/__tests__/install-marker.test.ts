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

  it('carries version and buildId when present', () => {
    const raw = { ...good, version: '3.9.2', buildId: 'abc1234@2026-11-25T00:00:00Z' }
    expect(parseInstallMarker(raw)).toEqual(raw)
  })

  it('reads a server marker only when asked for one', () => {
    const server = { ...good, kind: 'server' }
    expect(parseInstallMarker(server)).toBeNull()
    expect(parseInstallMarker(server, 'server')).toEqual(server)
    expect(parseInstallMarker(good, 'server')).toBeNull()
  })

  it.each([
    ['null', null],
    ['an empty version', { ...good, version: '' }],
    ['a non-string version', { ...good, version: 3 }],
    ['a version with a newline', { ...good, version: '1.0.0\nx' }],
    ['a non-string buildId', { ...good, buildId: {} }],
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
