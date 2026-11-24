import { describe, expect, it, vi } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import { join } from 'path'

vi.mock('electron', () => ({ protocol: { handle: vi.fn(), registerSchemesAsPrivileged: vi.fn() } }))

import { handleMediaRequest, parseMediaProtocolUrl } from '../media-protocol'

const ID = 'abcdef012345'
const dir = fs.mkdtempSync(join(os.tmpdir(), 'media-proto-'))
const path = join(dir, 'v.mp4')
fs.writeFileSync(path, '0123456789')
const file = { path, mime: 'video/mp4', size: 10 }

const req = (url: string, method = 'GET', range?: string) => ({
  url,
  method,
  headers: new Headers(range ? { range } : {})
})
const found = (id: string) => (id === ID ? file : null)

describe('media protocol', () => {
  it('parses only claudeui-media://job/<12 hex>', () => {
    expect(parseMediaProtocolUrl(`claudeui-media://job/${ID}`)).toBe(ID)
    expect(parseMediaProtocolUrl('claudeui-media://job/../x')).toBeNull()
    expect(parseMediaProtocolUrl(`claudeui-media://other/${ID}`)).toBeNull()
    expect(parseMediaProtocolUrl(`claudeui-media://job/${ID}/extra`)).toBeNull()
    expect(parseMediaProtocolUrl(`https://job/${ID}`)).toBeNull()
    expect(parseMediaProtocolUrl('garbage')).toBeNull()
  })

  it('404 for a bad id and for an id the ledger does not serve', () => {
    expect(handleMediaRequest(req('claudeui-media://job/zz'), found).status).toBe(404)
    expect(handleMediaRequest(req('claudeui-media://job/111111111111'), found).status).toBe(404)
  })

  it('200 whole file, 206 for a range, 416 past the end', async () => {
    const url = `claudeui-media://job/${ID}`
    const full = handleMediaRequest(req(url), found)
    expect(full.status).toBe(200)
    expect(full.headers.get('accept-ranges')).toBe('bytes')
    expect(await full.text()).toBe('0123456789')
    const part = handleMediaRequest(req(url, 'GET', 'bytes=2-4'), found)
    expect(part.status).toBe(206)
    expect(part.headers.get('content-range')).toBe('bytes 2-4/10')
    expect(await part.text()).toBe('234')
    expect(handleMediaRequest(req(url, 'GET', 'bytes=50-'), found).status).toBe(416)
  })

  it('HEAD has headers and no body', async () => {
    const res = handleMediaRequest(req(`claudeui-media://job/${ID}`, 'HEAD'), found)
    expect(res.status).toBe(200)
    expect(res.headers.get('content-length')).toBe('10')
    expect(await res.text()).toBe('')
  })
})
