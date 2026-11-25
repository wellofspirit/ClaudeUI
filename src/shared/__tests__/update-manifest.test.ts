import { describe, expect, it } from 'vitest'
import {
  UPDATE_TARGETS,
  assetTargetFor,
  parseManifest,
  serializeManifest,
  type UpdateManifest
} from '../update-manifest'

const V = '3.9.1-pre.14'
const asset = (name: string) => ({ name, size: 100, sha256: 'a'.repeat(64) })
const manifest: UpdateManifest = {
  schema: 1,
  version: V,
  tag: `v${V}`,
  channel: 'pre-release',
  publishedAt: '2026-11-24T10:00:00.000Z',
  claudeCodeVersion: '2.1.330',
  assets: {
    'desktop-darwin-arm64': asset(`ClaudeUI-${V}-mac-arm64.zip`),
    'desktop-win32-x64': asset(`ClaudeUI-${V}-win-x64.zip`)
  }
}
const withAsset = (a: unknown, key = 'desktop-win32-x64') => ({
  ...manifest,
  assets: { ...manifest.assets, [key]: a }
})

describe('assetTargetFor', () => {
  it.each([
    [`ClaudeUI-${V}-mac-arm64.zip`, 'desktop-darwin-arm64'],
    [`ClaudeUI-${V}-win-x64.zip`, 'desktop-win32-x64'],
    [`claudeui-server-${V}-mac-arm64.zip`, 'server-darwin-arm64'],
    [`claudeui-server-${V}-win-x64.zip`, 'server-win32-x64'],
    [`claudeui-server-${V}-linux-x64.tar.gz`, 'server-linux-x64'],
    [`claudeui-server-${V}-linux-arm64.tar.gz`, 'server-linux-arm64']
  ])('%s', (name, target) => expect(assetTargetFor(name, V)).toBe(target))

  it('covers every target exactly once', () => {
    const hit = [
      `ClaudeUI-${V}-mac-arm64.zip`,
      `ClaudeUI-${V}-win-x64.zip`,
      `claudeui-server-${V}-mac-arm64.zip`,
      `claudeui-server-${V}-win-x64.zip`,
      `claudeui-server-${V}-linux-x64.tar.gz`,
      `claudeui-server-${V}-linux-arm64.tar.gz`
    ].map((n) => assetTargetFor(n, V))
    expect([...hit].sort()).toEqual([...UPDATE_TARGETS].sort())
  })

  it('rejects a wrong version and near misses', () => {
    expect(assetTargetFor(`ClaudeUI-3.9.1-pre.13-mac-arm64.zip`, V)).toBeNull()
    expect(assetTargetFor(`ClaudeUI-${V}-mac-x64.zip`, V)).toBeNull()
    expect(assetTargetFor(`ClaudeUI-${V}-mac-arm64.zip.sig`, V)).toBeNull()
    expect(assetTargetFor(`x/ClaudeUI-${V}-mac-arm64.zip`, V)).toBeNull()
    expect(assetTargetFor('update-manifest.json', V)).toBeNull()
  })
})

describe('parseManifest', () => {
  it('round-trips through serializeManifest', () => {
    const text = serializeManifest(manifest)
    expect(text.endsWith('\n')).toBe(true)
    expect(parseManifest(JSON.parse(text))).toEqual(manifest)
  })
  it('serializes with a fixed key order regardless of input order', () => {
    const shuffled: UpdateManifest = {
      ...manifest,
      assets: {
        'desktop-win32-x64': asset('b'),
        'desktop-darwin-arm64': asset('a')
      }
    }
    expect(serializeManifest(shuffled)).toBe(
      serializeManifest({ ...shuffled, assets: { ...shuffled.assets } })
    )
    expect(serializeManifest(shuffled).indexOf('desktop-darwin-arm64')).toBeLessThan(
      serializeManifest(shuffled).indexOf('desktop-win32-x64')
    )
  })
  it.each([
    ['short sha', withAsset({ ...asset('a.zip'), sha256: 'abc' })],
    ['uppercase sha', withAsset({ ...asset('a.zip'), sha256: 'A'.repeat(64) })],
    ['slash in name', withAsset(asset('dir/a.zip'))],
    ['backslash in name', withAsset(asset('dir\\a.zip'))],
    ['negative size', withAsset({ ...asset('a.zip'), size: -1 })],
    ['zero size', withAsset({ ...asset('a.zip'), size: 0 })],
    ['fractional size', withAsset({ ...asset('a.zip'), size: 1.5 })],
    ['unknown target', withAsset(asset('a.zip'), 'desktop-linux-x64')],
    ['bad version', { ...manifest, version: '3.9' }],
    ['v-prefixed version', { ...manifest, version: 'v3.9.1' }],
    ['bad channel', { ...manifest, channel: 'beta' }],
    ['schema 2', { ...manifest, schema: 2 }],
    ['assets array', { ...manifest, assets: [] }],
    ['null', null]
  ])('rejects %s', (_n, raw) => expect(parseManifest(raw)).toBeNull())
})
