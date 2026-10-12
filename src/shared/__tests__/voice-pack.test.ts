import { describe, it, expect } from 'vitest'
import {
  VOICE_PACK,
  VOICE_PACK_APPROX_BYTES,
  voicePackModelUrl,
  voicePackPlatformKey
} from '../voice-pack'

describe('voicePackPlatformKey', () => {
  it.each([
    ['win32', 'x64', 'win32-x64'],
    ['darwin', 'arm64', 'darwin-arm64'],
    ['darwin', 'x64', 'darwin-x64'],
    ['linux', 'x64', 'linux-x64'],
    ['linux', 'arm64', 'linux-arm64']
  ])('%s/%s → %s', (platform, arch, key) => {
    expect(voicePackPlatformKey(platform, arch)).toBe(key)
  })

  it.each([
    ['win32', 'arm64'],
    ['win32', 'ia32'],
    ['freebsd', 'x64'],
    ['linux', 'riscv64'],
    ['constructor', 'x']
  ])('%s/%s has no runtime', (platform, arch) => {
    expect(voicePackPlatformKey(platform, arch)).toBeNull()
  })

  it('every supported key is a real npm package pinned by integrity', () => {
    for (const p of Object.values(VOICE_PACK.runtime.platforms)) {
      expect(p.tarball).toBe(
        `https://registry.npmjs.org/${p.package}/-/${p.package}-${VOICE_PACK.runtime.version}.tgz`
      )
      expect(p.integrity).toMatch(/^sha512-[A-Za-z0-9+/]+=*$/)
    }
  })
})

describe('the model pins', () => {
  it('URLs are at the pinned revision, never a branch', () => {
    expect(voicePackModelUrl('tokens.txt')).toBe(
      `https://huggingface.co/${VOICE_PACK.model.repo}/resolve/${VOICE_PACK.model.revision}/tokens.txt`
    )
    expect(VOICE_PACK.model.revision).toMatch(/^[0-9a-f]{40}$/)
  })

  it('every file carries a sha256 and a size, and the UI copy covers the download', () => {
    let total = 0
    for (const f of VOICE_PACK.model.files) {
      expect(f.sha256).toMatch(/^[0-9a-f]{64}$/)
      expect(f.size).toBeGreaterThan(0)
      total += f.size
    }
    // "~700 MB" is the download rounded: the model is ~661 MB, the runtime the rest.
    expect(total).toBeLessThanOrEqual(VOICE_PACK_APPROX_BYTES)
    expect(total).toBeGreaterThan(VOICE_PACK_APPROX_BYTES * 0.9)
  })
})
