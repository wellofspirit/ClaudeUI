/**
 * Unit tests for the `/sent-file` URL builder/parser (ADR-043 §5).
 *
 * The build→parse round-trip is the contract that matters: the web client
 * builds these URLs and the main process parses them, so any asymmetry in the
 * base64url/`URLSearchParams` handling turns a legitimate download into a 404.
 */

import { describe, it, expect } from 'vitest'
import { buildSentFileUrl, parseSentFileQuery, SENT_FILE_ROUTE } from '../sent-file-url'

/** Parse the way the server does: from a real URL's search params. */
function parseUrl(url: string): ReturnType<typeof parseSentFileQuery> {
  return parseSentFileQuery(new URL(url).searchParams)
}

describe('buildSentFileUrl / parseSentFileQuery', () => {
  const ORIGIN = 'https://host.ts.net:8443'
  const TOKEN = 'a'.repeat(64)

  it('builds the documented route shape', () => {
    const url = buildSentFileUrl(ORIGIN, 'route-1', '/d/repo/out/a.png', { token: TOKEN })
    const parsed = new URL(url)
    expect(parsed.pathname).toBe(SENT_FILE_ROUTE)
    expect(parsed.origin).toBe(ORIGIN)
    expect(parsed.searchParams.get('session')).toBe('route-1')
    expect(parsed.searchParams.get('token')).toBe(TOKEN)
    expect(parsed.searchParams.get('inline')).toBeNull()
    // The path is base64url, never the raw string.
    expect(parsed.searchParams.get('path')).not.toContain('/')
    expect(parsed.searchParams.get('path')).toMatch(/^[A-Za-z0-9_-]+$/)
  })

  it('does not double the slash when the origin has a trailing one', () => {
    const url = buildSentFileUrl('http://x/', 's', '/a.txt', { token: 't' })
    expect(url.startsWith(`http://x${SENT_FILE_ROUTE}?`)).toBe(true)
  })

  it('round-trips a Windows path with spaces', () => {
    const p = 'D:\\My Docs\\report v2.pdf'
    const got = parseUrl(buildSentFileUrl('http://x', 's1', p, { token: 't' }))
    expect(got).toEqual({ session: 's1', path: p, token: 't', inline: false })
  })

  it('round-trips unicode and query-hostile characters', () => {
    const p = '/tmp/日本語 & 100% #1/a+b?c=d.png'
    const got = parseUrl(buildSentFileUrl('http://x', 's1', p, { token: 't' }))
    expect(got?.path).toBe(p)
  })

  it('round-trips a session id needing percent-encoding', () => {
    const got = parseUrl(buildSentFileUrl('http://x', 'route a/b&c', '/a.txt', { token: 't' }))
    expect(got?.session).toBe('route a/b&c')
  })

  it('carries the inline flag only when requested', () => {
    expect(parseUrl(buildSentFileUrl('http://x', 's', '/a.png', { token: 't' }))?.inline).toBe(
      false
    )
    expect(
      parseUrl(buildSentFileUrl('http://x', 's', '/a.png', { token: 't', inline: true }))?.inline
    ).toBe(true)
  })

  it('preserves a token containing URL-significant characters', () => {
    const weird = 'a+b/c=d&e'
    expect(parseUrl(buildSentFileUrl('http://x', 's', '/a.txt', { token: weird }))?.token).toBe(
      weird
    )
  })

  it('returns null for missing session or path', () => {
    expect(parseSentFileQuery(new URLSearchParams('path=L2EudHh0&token=t'))).toBeNull()
    expect(parseSentFileQuery(new URLSearchParams('session=s&token=t'))).toBeNull()
    expect(parseSentFileQuery(new URLSearchParams(''))).toBeNull()
  })

  it('returns null for a path that is not valid base64url', () => {
    // `!` is outside the base64url alphabet; `%2F` decodes to a raw slash.
    expect(parseSentFileQuery(new URLSearchParams('session=s&path=abc!&token=t'))).toBeNull()
    expect(parseSentFileQuery(new URLSearchParams('session=s&path=%2Fetc%2Fpasswd'))).toBeNull()
  })

  it('returns null for base64 that is not valid UTF-8', () => {
    // 0xFF 0xFE is not a valid UTF-8 sequence.
    expect(parseSentFileQuery(new URLSearchParams('session=s&path=__4&token=t'))).toBeNull()
  })

  it('treats a missing token as an empty string rather than throwing', () => {
    const got = parseUrl(buildSentFileUrl('http://x', 's', '/a.txt', { token: '' }))
    expect(got?.token).toBe('')
  })
})
