/**
 * Unit tests for the SendUserFile security decisions (ADR-043).
 *
 * These are the pure/fs-only pieces behind two very different callers — the
 * `file:sent-file-preview` IPC and the remote `/sent-file` route — so they are
 * exercised here without Electron or an HTTP server. Non-vacuity: every allow
 * case has a matching deny case.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  MAX_PREVIEW_BYTES,
  matchSentFilePath,
  normalizePathForCompare,
  readImagePreview,
  sanitizeHeaderFilename,
  sentFileDisposition,
  validateImagePreview
} from '../sent-file-security'

// A 1x1 transparent PNG.
const PNG_BYTES = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64'
)

describe('validateImagePreview / readImagePreview (preview IPC guard)', () => {
  let dir: string
  let png: string
  let html: string
  let big: string
  let subdir: string

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'sent-preview-'))
    png = join(dir, 'shot.PNG') // uppercase → extension match must be case-insensitive
    writeFileSync(png, PNG_BYTES)
    html = join(dir, 'report.html')
    writeFileSync(html, '<h1>hi</h1>')
    big = join(dir, 'huge.png')
    writeFileSync(big, Buffer.alloc(MAX_PREVIEW_BYTES + 1))
    subdir = join(dir, 'nested')
    mkdirSync(subdir)
  })

  afterAll(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('accepts an existing image and reports its mime + size', () => {
    const res = validateImagePreview(png)
    expect(res).toEqual({ ok: true, path: png, mime: 'image/png', size: PNG_BYTES.length })
  })

  it('returns a data: URL for an accepted image', () => {
    const res = readImagePreview(png)
    expect(res).toEqual({ src: `data:image/png;base64,${PNG_BYTES.toString('base64')}` })
  })

  it('refuses non-image extensions (HTML is never rendered inline)', () => {
    expect(validateImagePreview(html)).toEqual({
      ok: false,
      error: 'Preview is only available for image files'
    })
    expect(readImagePreview(html)).toEqual({
      error: 'Preview is only available for image files'
    })
  })

  it('refuses a file over the size cap without reading it', () => {
    const res = validateImagePreview(big)
    expect(res.ok).toBe(false)
    expect((res as { error: string }).error).toContain('too large')
  })

  it('inherits the local-file guard: relative, UNC, missing, directory', () => {
    expect(validateImagePreview('shot.png')).toEqual({
      ok: false,
      error: 'File path must be absolute'
    })
    expect(validateImagePreview('\\\\evil\\share\\x.png')).toEqual({
      ok: false,
      error: 'Network (UNC) paths are not allowed'
    })
    expect(validateImagePreview(join(dir, 'nope.png'))).toEqual({
      ok: false,
      error: 'File does not exist'
    })
    // A directory named like an image must not pass.
    expect(validateImagePreview(subdir).ok).toBe(false)
    expect(validateImagePreview('').ok).toBe(false)
  })
})

describe('normalizePathForCompare', () => {
  it('is case-insensitive and separator-agnostic on win32', () => {
    expect(normalizePathForCompare('D:/Repo/Out/A.PNG', 'win32')).toBe(
      normalizePathForCompare('d:\\repo\\out\\a.png', 'win32')
    )
  })

  it('is case-SENSITIVE on posix', () => {
    expect(normalizePathForCompare('/repo/A.png', 'linux')).not.toBe(
      normalizePathForCompare('/repo/a.png', 'linux')
    )
  })

  it('collapses . / .. / duplicate separators and trailing separators', () => {
    expect(normalizePathForCompare('/repo//out/../out/./a.png', 'linux')).toBe('/repo/out/a.png')
    expect(normalizePathForCompare('/repo/out/', 'linux')).toBe('/repo/out')
  })
})

describe('matchSentFilePath (renderer-authoritative allowlist)', () => {
  const entries = [{ path: 'out/report.html' }, { path: '/tmp/abs.png' }]

  it('matches a relative entry resolved against the session cwd', () => {
    expect(matchSentFilePath('/d/repo', entries, '/d/repo/out/report.html', 'linux')).toBe(
      '/d/repo/out/report.html'
    )
  })

  it('matches an absolute entry verbatim', () => {
    expect(matchSentFilePath('/d/repo', entries, '/tmp/abs.png', 'linux')).toBe('/tmp/abs.png')
  })

  it('returns the SNAPSHOT-derived path, not the requester spelling', () => {
    // Equivalent-but-exotic spelling still yields the canonical allowlisted value.
    expect(matchSentFilePath('/d/repo', entries, '/d/repo/x/../out/report.html', 'linux')).toBe(
      '/d/repo/out/report.html'
    )
  })

  it('refuses a path that is not on the list', () => {
    expect(matchSentFilePath('/d/repo', entries, '/d/repo/out/other.html', 'linux')).toBeNull()
    expect(matchSentFilePath('/d/repo', entries, '/etc/passwd', 'linux')).toBeNull()
    // Traversal that normalises outside the delivered set.
    expect(
      matchSentFilePath('/d/repo', entries, '/d/repo/out/../../../etc/passwd', 'linux')
    ).toBeNull()
  })

  it('refuses everything when the session delivered nothing', () => {
    expect(matchSentFilePath('/d/repo', [], '/d/repo/out/report.html', 'linux')).toBeNull()
  })

  it('refuses an empty request', () => {
    expect(matchSentFilePath('/d/repo', entries, '', 'linux')).toBeNull()
  })

  it('ignores case on win32 only', () => {
    const winEntries = [{ path: 'out\\report.html' }]
    expect(matchSentFilePath('D:\\repo', winEntries, 'd:/REPO/OUT/report.HTML', 'win32')).toBe(
      'D:\\repo\\out\\report.html'
    )
    expect(matchSentFilePath('/d/repo', entries, '/d/repo/OUT/report.html', 'linux')).toBeNull()
  })
})

describe('sanitizeHeaderFilename', () => {
  it('strips CR/LF (header injection), quotes and backslashes', () => {
    expect(sanitizeHeaderFilename('a\r\nX-Evil: 1.txt')).toBe('aX-Evil: 1.txt')
    expect(sanitizeHeaderFilename('a"b\\c.txt')).toBe('abc.txt')
  })

  it('falls back to a placeholder when nothing survives', () => {
    expect(sanitizeHeaderFilename('"\\')).toBe('download')
    expect(sanitizeHeaderFilename('')).toBe('download')
  })
})

describe('sentFileDisposition', () => {
  it('serves an image inline when asked', () => {
    const d = sentFileDisposition('/d/repo/out/a.png', true)
    expect(d.inline).toBe(true)
    expect(d.contentType).toBe('image/png')
    expect(d.contentDisposition).toContain('inline; filename="a.png"')
  })

  it('defaults to attachment when inline is not requested', () => {
    const d = sentFileDisposition('/d/repo/out/a.png', false)
    expect(d.inline).toBe(false)
    expect(d.contentDisposition.startsWith('attachment;')).toBe(true)
  })

  it('FORCES attachment for non-images even when inline is requested', () => {
    for (const p of ['/x/evil.html', '/x/doc.pdf', '/x/notes.txt', '/x/noext']) {
      const d = sentFileDisposition(p, true)
      expect(d.inline).toBe(false)
      expect(d.contentDisposition.startsWith('attachment;')).toBe(true)
    }
    expect(sentFileDisposition('/x/evil.html', true).contentType).toBe('text/html; charset=utf-8')
  })

  it('falls back to octet-stream for unknown extensions', () => {
    expect(sentFileDisposition('/x/thing.qqq', false).contentType).toBe('application/octet-stream')
  })

  it('emits an ASCII fallback plus RFC 6266 filename* for non-ASCII names', () => {
    const d = sentFileDisposition('/x/日本語.png', true)
    expect(d.contentDisposition).toContain('filename="___.png"')
    expect(d.contentDisposition).toContain(`filename*=UTF-8''${encodeURIComponent('日本語.png')}`)
  })

  it('never lets a CRLF in the filename reach the header', () => {
    const d = sentFileDisposition('/x/a\r\nSet-Cookie: x.png', true)
    expect(d.contentDisposition).not.toMatch(/[\r\n]/)
  })
})
