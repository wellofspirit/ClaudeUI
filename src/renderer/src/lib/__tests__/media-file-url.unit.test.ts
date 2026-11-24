import { afterEach, describe, expect, it } from 'vitest'
import { mediaFileUrl } from '../media-file-url'
import { heldResultTitle } from '../held-result-title'

const ID = 'abcdef012345'
const w = window as unknown as { api?: { platform?: string }; __FILE_TOKEN__?: string }

describe('mediaFileUrl', () => {
  afterEach(() => {
    delete w.api
    delete w.__FILE_TOKEN__
  })

  it('web: the /media-file route with the file token', () => {
    w.api = { platform: 'web' }
    w.__FILE_TOKEN__ = 'tok en'
    const url = new URL(mediaFileUrl(ID)!)
    expect(url.origin).toBe(window.location.origin)
    expect(url.pathname).toBe('/media-file')
    expect(url.searchParams.get('job')).toBe(ID)
    expect(url.searchParams.get('token')).toBe('tok en')
  })

  it('web: no token yet gives null', () => {
    w.api = { platform: 'web' }
    expect(mediaFileUrl(ID)).toBeNull()
  })

  it('desktop: the claudeui-media protocol', () => {
    w.api = { platform: 'win32' }
    expect(mediaFileUrl(ID)).toBe(`claudeui-media://job/${ID}`)
  })

  it('rejects a malformed id on both clients', () => {
    w.api = { platform: 'win32' }
    expect(mediaFileUrl('../etc')).toBeNull()
    w.api = { platform: 'web' }
    w.__FILE_TOKEN__ = 't'
    expect(mediaFileUrl('nothex')).toBeNull()
  })
})

describe('heldResultTitle', () => {
  it('words a media job without the X-Agent prefix', () => {
    expect(heldResultTitle('Image job finished')).toBe('Image job finished — result waiting')
    expect(heldResultTitle('Video job failed')).toBe('Video job failed — result waiting')
  })
  it('keeps the X-Agent wording', () => {
    expect(heldResultTitle('Scout')).toBe('X-Agent Scout finished — result waiting')
    expect(heldResultTitle(undefined)).toBe('An X-Agent finished — result waiting')
  })
})
