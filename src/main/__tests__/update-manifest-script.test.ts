/** @vitest-environment node */
import * as crypto from 'node:crypto'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { parseManifest } from '../../shared/update-manifest'

const mod: any = await import('../../../scripts/release/update-manifest.mjs')
const { buildManifest, signBytes, verifyPinned, writeSignedManifest, keyIdFor } = mod

const V = '3.9.1'
let dir: string
let out: string
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'um-assets-'))
  out = fs.mkdtempSync(path.join(os.tmpdir(), 'um-out-'))
})
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true })
  fs.rmSync(out, { recursive: true, force: true })
})
const put = (name: string, content = name) => fs.writeFileSync(path.join(dir, name), content)
const putDesktop = () => {
  put(`ClaudeUI-${V}-mac-arm64.zip`, 'mac')
  put(`ClaudeUI-${V}-win-x64.zip`, 'win')
}
const keyPair = () => {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519')
  const spki = publicKey.export({ type: 'spki', format: 'der' }).toString('base64')
  return {
    pem: privateKey.export({ type: 'pkcs8', format: 'pem' }) as string,
    pinned: [{ id: keyIdFor(spki), spki }]
  }
}
const opts = () => ({ dir, version: V, channel: 'stable', outDir: out })

describe('buildManifest', () => {
  it('hashes the mapped assets and ignores other files', async () => {
    putDesktop()
    put(`claudeui-server-${V}-linux-x64.tar.gz`, 'srv')
    put('notes.txt')
    const m = await buildManifest({
      dir,
      version: V,
      channel: 'stable',
      claudeCodeVersion: '2.1.330',
      publishedAt: 'now'
    })
    expect(Object.keys(m.assets).sort()).toEqual([
      'desktop-darwin-arm64',
      'desktop-win32-x64',
      'server-linux-x64'
    ])
    expect(m.assets['desktop-win32-x64']).toEqual({
      name: `ClaudeUI-${V}-win-x64.zip`,
      size: 3,
      sha256: crypto.createHash('sha256').update('win').digest('hex')
    })
    expect(m.tag).toBe(`v${V}`)
    expect(parseManifest(m)).not.toBeNull()
  })

  it('fails on a release-looking asset with no target, and on a missing desktop target', async () => {
    putDesktop()
    put(`ClaudeUI-${V}-mac-x64.zip`)
    const args = { dir, version: V, channel: 'stable', claudeCodeVersion: 'c', publishedAt: 'n' }
    await expect(buildManifest(args)).rejects.toThrow(/no target/)
    fs.rmSync(path.join(dir, `ClaudeUI-${V}-mac-x64.zip`))
    fs.rmSync(path.join(dir, `ClaudeUI-${V}-win-x64.zip`))
    await expect(buildManifest(args)).rejects.toThrow(/desktop-win32-x64/)
  })

  it('fails on an asset of another version', async () => {
    putDesktop()
    put('ClaudeUI-3.9.0-mac-arm64.zip')
    await expect(
      buildManifest({
        dir,
        version: V,
        channel: 'stable',
        claudeCodeVersion: 'c',
        publishedAt: 'n'
      })
    ).rejects.toThrow(/no target/)
  })
})

describe('writeSignedManifest', () => {
  it('signs, and the pinned key verifies the written bytes', async () => {
    putDesktop()
    const k = keyPair()
    expect(await writeSignedManifest({ ...opts(), signingKey: k.pem, keys: k.pinned })).toBe(true)
    const bytes = fs.readFileSync(path.join(out, 'update-manifest.json'))
    const sig = fs.readFileSync(path.join(out, 'update-manifest.json.sig'), 'utf8').trim()
    expect(verifyPinned(bytes, sig, k.pinned)).toBe(k.pinned[0].id)
    expect(parseManifest(JSON.parse(bytes.toString()))?.version).toBe(V)
  })

  it('fails verification when one byte of the manifest changes', async () => {
    putDesktop()
    const k = keyPair()
    await writeSignedManifest({ ...opts(), signingKey: k.pem, keys: k.pinned })
    const bytes = Buffer.from(fs.readFileSync(path.join(out, 'update-manifest.json')))
    const sig = fs.readFileSync(path.join(out, 'update-manifest.json.sig'), 'utf8').trim()
    bytes[bytes.length - 3] ^= 1
    expect(verifyPinned(bytes, sig, k.pinned)).toBeNull()
  })

  it('refuses a signing key that no pinned key matches, writing nothing', async () => {
    putDesktop()
    const k = keyPair()
    const other = keyPair()
    await expect(
      writeSignedManifest({ ...opts(), signingKey: k.pem, keys: other.pinned })
    ).rejects.toThrow(/pinned/)
    expect(fs.readdirSync(out)).toEqual([])
    // and the shipped (empty) pin list verifies nothing
    await expect(writeSignedManifest({ ...opts(), signingKey: k.pem, keys: [] })).rejects.toThrow(
      /pinned/
    )
  })

  it('writes nothing without a key', async () => {
    putDesktop()
    expect(await writeSignedManifest({ ...opts(), signingKey: undefined })).toBe(false)
    expect(await writeSignedManifest({ ...opts(), signingKey: '' })).toBe(false)
    expect(fs.readdirSync(out)).toEqual([])
  })

  it('does not echo the key in its error for a garbage key', async () => {
    putDesktop()
    const k = keyPair()
    const err = await writeSignedManifest({
      ...opts(),
      signingKey: 'not a pem SECRET-MARKER',
      keys: k.pinned
    }).catch((e: Error) => e)
    expect(String(err.message)).not.toContain('SECRET-MARKER')
  })

  it('signBytes is verifiable by a plain crypto.verify', () => {
    const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519')
    const pem = privateKey.export({ type: 'pkcs8', format: 'pem' }) as string
    const sig = signBytes(Buffer.from('x'), pem)
    expect(crypto.verify(null, Buffer.from('x'), publicKey, Buffer.from(sig, 'base64'))).toBe(true)
  })
})
