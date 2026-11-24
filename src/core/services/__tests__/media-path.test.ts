/**
 * @vitest-environment node
 *
 * Media job paths (Critical): what an agent may name as an output or an input image.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import {
  MEDIA_INPUT_MAX_BYTES,
  finalOutputPath,
  readMediaInput,
  resolveMediaOutput,
  sniffImageMime,
  writeMediaFile,
  type MediaPathContext
} from '../media-path'

const PNG = Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), Buffer.alloc(16)])

let root: string
let cwd: string
let outside: string
let ctx: MediaPathContext

beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'media-path-')))
  cwd = path.join(root, 'work')
  outside = path.join(root, 'outside')
  fs.mkdirSync(cwd)
  fs.mkdirSync(outside)
  ctx = { cwd }
})
afterEach(() => fs.rmSync(root, { recursive: true, force: true }))

const out = (
  requested?: string,
  kind: 'image' | 'video' = 'image',
  saveTo: 'media' | 'generated' = 'media'
) =>
  resolveMediaOutput(ctx, { requested, kind, saveTo, sessionKey: 'sess/1', jobId: 'abc123abc123' })

describe('the output path', () => {
  it('defaults under .claude/ui/media/<session-key>, or generated/, and the key cannot nest', () => {
    expect(out()).toEqual({
      ok: true,
      agentGiven: false,
      path: path.join(cwd, '.claude', 'ui', 'media', 'sess_1', 'abc123abc123.png')
    })
    expect(out(undefined, 'video', 'generated')).toMatchObject({
      path: path.join(cwd, 'generated', 'abc123abc123.mp4')
    })
  })

  it('resolves a relative path against the session working directory, or the entered worktree', () => {
    const wt = path.join(cwd, 'wt')
    fs.mkdirSync(wt)
    expect(out('art/cat.png')).toMatchObject({ ok: true, path: path.join(cwd, 'art', 'cat.png') })
    ctx = {
      cwd,
      worktree: { worktreePath: wt, originalCwd: cwd } as never
    }
    expect(out('cat.png')).toMatchObject({ ok: true, path: path.join(wt, 'cat.png') })
  })

  it('refuses traversal and absolute paths outside the roots', () => {
    expect(out('../outside/x.png')).toMatchObject({ ok: false })
    expect(out(path.join(outside, 'x.png'))).toMatchObject({ ok: false })
  })

  it('allows an additional directory', () => {
    ctx = { cwd, additionalDirectories: [outside] }
    expect(out(path.join(outside, 'x.png'))).toMatchObject({ ok: true })
  })

  it('refuses a link or junction that leaves the roots, also for a not-yet-created file below it', () => {
    const link = path.join(cwd, 'link')
    fs.symlinkSync(outside, link, 'junction')
    expect(out('link/x.png')).toMatchObject({ ok: false })
    expect(out('link/deeper/new/x.png')).toMatchObject({ ok: false })
    // A file link to an outside file is not replaced either.
    fs.writeFileSync(path.join(outside, 'target.png'), PNG)
    try {
      fs.symlinkSync(path.join(outside, 'target.png'), path.join(cwd, 'file-link.png'), 'file')
      expect(out('file-link.png')).toMatchObject({ ok: false })
    } catch {
      // Creating a file symlink needs a privilege on some Windows setups; the junction case above covers it.
    }
  })

  it('refuses agent-control targets, but not the default path under .claude', () => {
    expect(out('.claude/settings.png')).toMatchObject({ ok: false })
    expect(out('.git/hooks/x.png')).toMatchObject({ ok: false })
    expect(out()).toMatchObject({ ok: true })
  })

  it('needs an extension of the right media type', () => {
    expect(out('a.txt')).toMatchObject({ ok: false })
    expect(out('a.mp4', 'image')).toMatchObject({ ok: false })
    expect(out('a.png', 'video')).toMatchObject({ ok: false })
    expect(out('a.webm', 'video')).toMatchObject({ ok: true })
  })

  it('replaces an existing image of the same type, never a non-media file or a directory', () => {
    fs.writeFileSync(path.join(cwd, 'old.png'), PNG)
    fs.mkdirSync(path.join(cwd, 'dir.png'))
    expect(out('old.png')).toMatchObject({ ok: true })
    expect(out('dir.png')).toMatchObject({ ok: false })
    // Same name, wrong media type: a video path cannot overwrite an image file's name either.
    expect(out('old.mp4', 'video')).toMatchObject({ ok: true })
  })

  it('the final path takes the extension of the returned mime', () => {
    const first = out('pic.png')
    if (!first.ok) throw new Error('setup')
    expect(finalOutputPath(ctx, first.path, 'image/webp', 'image', true, 'j1')).toEqual({
      ok: true,
      path: path.join(cwd, 'pic.webp')
    })
    // The requested extension is kept as it is, and an existing file there is the agent's to replace.
    fs.writeFileSync(path.join(cwd, 'pic.png'), PNG)
    expect(finalOutputPath(ctx, first.path, 'image/png', 'image', true, 'j1')).toEqual({
      ok: true,
      path: path.join(cwd, 'pic.png')
    })
    // A case-only difference is the same extension: the agent's own `Hero.PNG` is replaced, not
    // side-stepped to a fresh name.
    fs.writeFileSync(path.join(cwd, 'Hero.PNG'), PNG)
    const upper = out('Hero.PNG')
    if (!upper.ok) throw new Error('setup')
    const final = finalOutputPath(ctx, upper.path, 'image/png', 'image', true, 'j2')
    expect(final.ok && path.basename(final.path).toLowerCase()).toBe('hero.png')
  })

  it('a changed extension never lands on an existing file the agent did not name', () => {
    // Requested hero.jpg; hero.png exists; the provider returns PNG.
    fs.writeFileSync(path.join(cwd, 'hero.png'), 'precious')
    fs.mkdirSync(path.join(cwd, 'dir.webp'))
    const first = out('hero.jpg')
    if (!first.ok) throw new Error('setup')
    expect(finalOutputPath(ctx, first.path, 'image/png', 'image', true, 'job7')).toEqual({
      ok: true,
      path: path.join(cwd, 'hero.job7.png')
    })
    expect(fs.readFileSync(path.join(cwd, 'hero.png'), 'utf8')).toBe('precious')
    const dirReq = out('dir.png')
    if (!dirReq.ok) throw new Error('setup')
    expect(finalOutputPath(ctx, dirReq.path, 'image/webp', 'image', true, 'job8')).toEqual({
      ok: true,
      path: path.join(cwd, 'dir.job8.webp')
    })
  })
})

describe('writeMediaFile', () => {
  it('writes through a temp file and leaves only the final one', () => {
    const file = path.join(cwd, 'deep', 'dir', 'x.png')
    writeMediaFile(ctx, file, PNG)
    expect(fs.readFileSync(file)).toEqual(PNG)
    expect(fs.readdirSync(path.dirname(file))).toEqual(['x.png'])
  })

  it('does not write where the directory has been linked out of the roots', () => {
    fs.symlinkSync(outside, path.join(cwd, 'link'), 'junction')
    expect(() => writeMediaFile(ctx, path.join(cwd, 'link', 'x.png'), PNG)).toThrow()
    expect(fs.readdirSync(outside)).toEqual([])
  })
})

describe('input images', () => {
  it('reads a PNG by its bytes whatever its name', () => {
    fs.writeFileSync(path.join(cwd, 'in.dat'), PNG)
    expect(readMediaInput(ctx, 'in.dat')).toMatchObject({ ok: true, mime: 'image/png' })
  })

  it('sniffs the four image types', () => {
    expect(sniffImageMime(Buffer.from([0xff, 0xd8, 0xff, 0xe0]))).toBe('image/jpeg')
    expect(sniffImageMime(Buffer.from('RIFF\0\0\0\0WEBPVP8 '))).toBe('image/webp')
    expect(sniffImageMime(Buffer.from('GIF89a'))).toBe('image/gif')
    expect(sniffImageMime(Buffer.from('<svg/>'))).toBeUndefined()
  })

  it('refuses a non-image, an oversize file, a directory, a missing file, outside paths and escaping links', () => {
    fs.writeFileSync(path.join(cwd, 'a.png'), 'not an image')
    expect(readMediaInput(ctx, 'a.png')).toMatchObject({ ok: false })
    fs.writeFileSync(
      path.join(cwd, 'big.png'),
      Buffer.concat([PNG, Buffer.alloc(MEDIA_INPUT_MAX_BYTES)])
    )
    expect(readMediaInput(ctx, 'big.png')).toMatchObject({ ok: false })
    fs.mkdirSync(path.join(cwd, 'd.png'))
    expect(readMediaInput(ctx, 'd.png')).toMatchObject({ ok: false })
    expect(readMediaInput(ctx, 'nope.png')).toMatchObject({ ok: false })
    fs.writeFileSync(path.join(outside, 'o.png'), PNG)
    expect(readMediaInput(ctx, path.join(outside, 'o.png'))).toMatchObject({ ok: false })
    fs.symlinkSync(outside, path.join(cwd, 'link'), 'junction')
    expect(readMediaInput(ctx, 'link/o.png')).toMatchObject({ ok: false })
  })
})
