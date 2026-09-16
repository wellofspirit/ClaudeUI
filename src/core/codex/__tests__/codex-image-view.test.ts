/**
 * Layer 1 guards for the `imageView` byte reader (F20).
 *
 * The rule it enforces is that nothing but a real, small, renderable image ever
 * reaches the renderer's `data:<mediaType>;base64,…`: the EXTENSION and the
 * MAGIC BYTES must agree, the file must be under the cap, and every other
 * outcome — missing, directory, empty, oversized, mislabelled, unreadable —
 * is `undefined` rather than a throw, because the caller's fallback is the
 * path-only card and a throw there would take the whole turn's item with it.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { IMAGE_VIEW_MAX_BYTES, readCodexImageView } from '../codex-image-view'

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x01])
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10])
const GIF = Buffer.concat([Buffer.from('GIF89a', 'latin1'), Buffer.from([0x01, 0x00])])
const WEBP = Buffer.concat([
  Buffer.from('RIFF', 'latin1'),
  Buffer.from([0x10, 0x00, 0x00, 0x00]),
  Buffer.from('WEBP', 'latin1')
])

let dir: string
const write = (name: string, bytes: Buffer): string => {
  const path = join(dir, name)
  writeFileSync(path, bytes)
  return path
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'codex-image-view-'))
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('readCodexImageView', () => {
  it.each([
    ['shot.png', PNG, 'image/png'],
    ['shot.jpg', JPEG, 'image/jpeg'],
    ['shot.jpeg', JPEG, 'image/jpeg'],
    ['shot.gif', GIF, 'image/gif'],
    ['shot.webp', WEBP, 'image/webp']
  ])('reads %s as %s', async (name, bytes, mediaType) => {
    expect(await readCodexImageView(write(name, bytes))).toEqual({
      mediaType,
      base64Data: bytes.toString('base64')
    })
  })

  it('is case-insensitive about the extension', async () => {
    expect(await readCodexImageView(write('SHOT.PNG', PNG))).toMatchObject({
      mediaType: 'image/png'
    })
  })

  it('refuses a file whose bytes disagree with its extension', async () => {
    // A PDF named .png would reach the renderer as `data:image/png;base64,…`
    // and render as a broken image, so the sniff is what makes the media type
    // an assertion rather than a guess.
    expect(await readCodexImageView(write('lying.png', Buffer.from('%PDF-1.7\n')))).toBeUndefined()
    // …and the other way round: a real PNG under a name the reader does not
    // allow stays refused, because the extension is what the user sees.
    expect(await readCodexImageView(write('real.txt', PNG))).toBeUndefined()
  })

  it('refuses a RIFF container that is not WebP', async () => {
    const wav = Buffer.concat([
      Buffer.from('RIFF', 'latin1'),
      Buffer.from([0x10, 0x00, 0x00, 0x00]),
      Buffer.from('WAVE', 'latin1')
    ])
    expect(await readCodexImageView(write('audio.webp', wav))).toBeUndefined()
  })

  it('refuses a file over the 5 MB cap and accepts one just under it', async () => {
    const oversized = Buffer.concat([PNG, Buffer.alloc(IMAGE_VIEW_MAX_BYTES)])
    expect(await readCodexImageView(write('huge.png', oversized))).toBeUndefined()
    const allowed = Buffer.concat([PNG, Buffer.alloc(IMAGE_VIEW_MAX_BYTES - PNG.length - 1)])
    expect(await readCodexImageView(write('big.png', allowed))).toMatchObject({
      mediaType: 'image/png'
    })
  })

  it('never throws: missing, empty, a directory, and an unknown extension', async () => {
    mkdirSync(join(dir, 'folder.png'))
    expect(await readCodexImageView(join(dir, 'absent.png'))).toBeUndefined()
    expect(await readCodexImageView(write('empty.png', Buffer.alloc(0)))).toBeUndefined()
    expect(await readCodexImageView(join(dir, 'folder.png'))).toBeUndefined()
    expect(await readCodexImageView(write('doc.svg', Buffer.from('<svg/>')))).toBeUndefined()
    expect(await readCodexImageView('')).toBeUndefined()
  })
})
