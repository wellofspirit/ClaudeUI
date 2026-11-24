/**
 * @vitest-environment node
 *
 * Saved media by job id: what the file route may serve, the lazy blob re-intern after a restart, HTTP Range,
 * and the cold-load card rebuild from the ledger.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createHash } from 'node:crypto'
import * as fs from 'node:fs'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import * as os from 'node:os'
import * as path from 'node:path'
import { blobStore } from '../blob-store'
import {
  parseByteRange,
  reinternMediaBlob,
  resolveMediaFile,
  serveMediaFile,
  type MediaFileDeps
} from '../media-files'
import type { ActiveMediaJob, MediaJobRow } from '../media-job-ledger'
import { withMediaTasks } from '../media-task-history'
import type { ChatMessage } from '../../../shared/types'

let root: string
let cwd: string
let outside: string
let rows: Map<string, ActiveMediaJob>
let deps: MediaFileDeps

const PNG = Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), Buffer.alloc(100, 7)])
const hash = (b: Buffer): string => createHash('sha256').update(b).digest('hex')

function addRow(over: Partial<MediaJobRow> & { id: string }): ActiveMediaJob {
  const row: ActiveMediaJob = {
    sessionId: 's1',
    cwd,
    toolUseId: 'tu-1',
    kind: 'image',
    status: 'completed',
    modelRef: 'chatgpt-plan',
    modelLabel: 'ChatGPT Plan',
    source: 'chatgpt-plan',
    path: path.join(cwd, 'a.png'),
    mime: 'image/png',
    bytes: PNG.length,
    blobHash: null,
    providerJobId: null,
    error: null,
    createdAt: 1,
    startedAt: 1,
    endedAt: 2,
    costUsd: null,
    usageJson: null,
    owner: null,
    ...over
  }
  rows.set(row.id, row)
  return row
}

beforeEach(() => {
  root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'media-files-')))
  cwd = path.join(root, 'work')
  outside = path.join(root, 'outside')
  fs.mkdirSync(cwd)
  fs.mkdirSync(outside)
  rows = new Map()
  blobStore.clearForTests()
  deps = {
    ledger: {
      get: (id) => rows.get(id),
      getByBlobHash: (h) => [...rows.values()].find((r) => r.blobHash === h)
    },
    additionalDirectories: () => []
  }
})
afterEach(() => fs.rmSync(root, { recursive: true, force: true }))

describe('resolveMediaFile', () => {
  it('serves only a completed, ledger-known file that is still a regular file inside the roots', () => {
    fs.writeFileSync(path.join(cwd, 'a.png'), PNG)
    addRow({ id: 'aaaaaaaaaaaa' })
    expect(resolveMediaFile('aaaaaaaaaaaa', deps)).toEqual({
      path: path.join(cwd, 'a.png'),
      mime: 'image/png',
      size: PNG.length
    })
    expect(resolveMediaFile('bbbbbbbbbbbb', deps)).toBeNull()
  })

  it('refuses a job that did not complete, a missing file and a directory', () => {
    addRow({ id: 'run000000001', status: 'running' })
    addRow({ id: 'gone00000001', path: path.join(cwd, 'gone.png') })
    fs.mkdirSync(path.join(cwd, 'dir.png'))
    addRow({ id: 'dir000000001', path: path.join(cwd, 'dir.png') })
    for (const id of ['run000000001', 'gone00000001', 'dir000000001']) {
      expect(resolveMediaFile(id, deps)).toBeNull()
    }
  })

  it('refuses a ledger path outside the session roots, also through a link', () => {
    fs.writeFileSync(path.join(outside, 'o.png'), PNG)
    addRow({ id: 'out000000001', path: path.join(outside, 'o.png') })
    expect(resolveMediaFile('out000000001', deps)).toBeNull()
    fs.symlinkSync(outside, path.join(cwd, 'link'), 'junction')
    addRow({ id: 'lnk000000001', path: path.join(cwd, 'link', 'o.png') })
    expect(resolveMediaFile('lnk000000001', deps)).toBeNull()
    // The user's additional directories widen the roots, as they did for the write.
    deps = { ...deps, additionalDirectories: () => [outside] }
    expect(resolveMediaFile('out000000001', deps)).not.toBeNull()
  })

  it('serves a video under its own type', () => {
    fs.writeFileSync(path.join(cwd, 'v.mp4'), Buffer.alloc(10))
    addRow({ id: 'vid000000001', kind: 'video', path: path.join(cwd, 'v.mp4'), mime: 'video/mp4' })
    expect(resolveMediaFile('vid000000001', deps)?.mime).toBe('video/mp4')
  })
})

describe('reinternMediaBlob', () => {
  it('puts the bytes back from the saved file when they still hash to the blob id', () => {
    fs.writeFileSync(path.join(cwd, 'a.png'), PNG)
    addRow({ id: 'aaaaaaaaaaaa', blobHash: hash(PNG) })
    expect(blobStore.get(hash(PNG))).toBeUndefined()
    expect(reinternMediaBlob(hash(PNG), deps)).toBe(true)
    expect(blobStore.get(hash(PNG))).toMatchObject({ mediaType: 'image/png', data: PNG })
  })

  it('refuses a file that changed, a missing file and an unknown hash', () => {
    fs.writeFileSync(path.join(cwd, 'a.png'), PNG)
    addRow({ id: 'aaaaaaaaaaaa', blobHash: hash(PNG) })
    fs.writeFileSync(path.join(cwd, 'a.png'), Buffer.concat([PNG, Buffer.from('x')]))
    expect(reinternMediaBlob(hash(PNG), deps)).toBe(false)
    fs.rmSync(path.join(cwd, 'a.png'))
    expect(reinternMediaBlob(hash(PNG), deps)).toBe(false)
    expect(reinternMediaBlob('f'.repeat(64), deps)).toBe(false)
    expect(blobStore.stats().entries).toBe(0)
  })

  it('does not re-intern from a path outside the roots', () => {
    fs.writeFileSync(path.join(outside, 'o.png'), PNG)
    addRow({ id: 'out000000001', path: path.join(outside, 'o.png'), blobHash: hash(PNG) })
    expect(reinternMediaBlob(hash(PNG), deps)).toBe(false)
  })
})

describe('parseByteRange', () => {
  it.each([
    ['bytes=0-9', 100, { start: 0, end: 9 }],
    ['bytes=90-', 100, { start: 90, end: 99 }],
    ['bytes=-10', 100, { start: 90, end: 99 }],
    ['bytes=50-500', 100, { start: 50, end: 99 }],
    ['bytes=100-', 100, 'invalid'],
    ['bytes=9-5', 100, 'invalid'],
    ['bytes=-0', 100, 'invalid'],
    ['bytes=0-1,5-6', 100, null],
    ['items=0-1', 100, null],
    [undefined, 100, null]
  ] as const)('%s of %i', (header, size, expected) => {
    expect(parseByteRange(header, size)).toEqual(expected)
  })
})

describe('serveMediaFile', () => {
  let server: http.Server
  let base: string
  const file = (): { path: string; mime: string; size: number } => ({
    path: path.join(cwd, 'v.mp4'),
    mime: 'video/mp4',
    size: 100
  })

  beforeEach(async () => {
    fs.writeFileSync(path.join(cwd, 'v.mp4'), Buffer.from(Array.from({ length: 100 }, (_, i) => i)))
    server = http.createServer((req, res) => serveMediaFile(req, res, file(), { 'X-Test': '1' }))
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`
  })
  afterEach(() => new Promise<void>((r) => server.close(() => r())))

  it('serves the whole file with its type and Accept-Ranges', async () => {
    const res = await fetch(base)
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('video/mp4')
    expect(res.headers.get('accept-ranges')).toBe('bytes')
    expect(res.headers.get('x-test')).toBe('1')
    expect(res.headers.get('content-security-policy')).toContain('sandbox')
    expect((await res.arrayBuffer()).byteLength).toBe(100)
  })

  it('answers a range with 206 and exactly those bytes', async () => {
    const res = await fetch(base, { headers: { Range: 'bytes=10-19' } })
    expect(res.status).toBe(206)
    expect(res.headers.get('content-range')).toBe('bytes 10-19/100')
    expect(res.headers.get('content-length')).toBe('10')
    expect([...new Uint8Array(await res.arrayBuffer())]).toEqual([
      10, 11, 12, 13, 14, 15, 16, 17, 18, 19
    ])
  })

  it('answers an unsatisfiable range with 416 and the size', async () => {
    const res = await fetch(base, { headers: { Range: 'bytes=500-' } })
    expect(res.status).toBe(416)
    expect(res.headers.get('content-range')).toBe('bytes */100')
  })

  it('answers HEAD without a body', async () => {
    const res = await fetch(base, { method: 'HEAD' })
    expect(res.status).toBe(200)
    expect(res.headers.get('content-length')).toBe('100')
  })
})

describe('withMediaTasks (cold load)', () => {
  const messages = (...ids: string[]): ChatMessage[] => [
    {
      id: 'm1',
      role: 'assistant',
      timestamp: 0,
      content: ids.map((toolUseId) => ({
        type: 'tool_use',
        toolUseId,
        toolName: 'mcp__claude-ui-media__generate_image',
        toolInput: {}
      }))
    } as ChatMessage
  ]
  const ledgerOf = (list: MediaJobRow[]): { bySession: () => MediaJobRow[] } => ({
    bySession: () => list
  })

  it('rebuilds a completed card with its blob id, file id and stored outcome', () => {
    const row = addRow({
      id: 'aaaaaaaaaaaa',
      blobHash: hash(PNG),
      usageJson: JSON.stringify({ elapsedMs: 4200, width: 8, height: 4, revisedPrompt: 'a tabby' }),
      costUsd: 0.03
    })
    const out = withMediaTasks('s1', { messages: messages('tu-1') }, ledgerOf([row]))
    expect(out.taskNotifications).toEqual([
      expect.objectContaining({
        taskId: 'aaaaaaaaaaaa',
        toolUseId: 'tu-1',
        status: 'completed',
        media: expect.objectContaining({
          blobId: hash(PNG),
          fileId: 'aaaaaaaaaaaa',
          path: row.path,
          width: 8,
          elapsedMs: 4200,
          costUsd: 0.03,
          revisedPrompt: 'a tabby',
          modelLabel: 'ChatGPT Plan'
        })
      })
    ])
  })

  it('maps failed, stopped and interrupted rows, and a running one becomes an active task', () => {
    const list = [
      addRow({ id: 'f00000000001', toolUseId: 'tu-f', status: 'failed', error: 'no credit' }),
      addRow({ id: 's00000000001', toolUseId: 'tu-s', status: 'stopped' }),
      addRow({ id: 'i00000000001', toolUseId: 'tu-i', status: 'interrupted' }),
      addRow({ id: 'r00000000001', toolUseId: 'tu-r', status: 'running', startedAt: 77 })
    ]
    const out = withMediaTasks(
      's1',
      { messages: messages('tu-f', 'tu-s', 'tu-i', 'tu-r') },
      ledgerOf(list)
    )
    expect(out.taskNotifications?.map((n) => n.status)).toEqual(['failed', 'stopped', 'unfinished'])
    expect(out.taskNotifications?.[0].summary).toContain('no credit')
    expect(out.activeTasks).toEqual({
      'tu-r': expect.objectContaining({ taskType: 'media', wakesParent: true, startedAt: 77 })
    })
  })

  it('ignores a job whose call is not in the loaded transcript, and keeps an existing notification', () => {
    const row = addRow({ id: 'aaaaaaaaaaaa' })
    const same = { messages: messages('other') }
    expect(withMediaTasks('s1', same, ledgerOf([row]))).toBe(same)
    const existing = {
      taskId: 'x',
      toolUseId: 'tu-1',
      status: 'completed',
      outputFile: '',
      summary: 'x'
    }
    const kept = withMediaTasks(
      's1',
      { messages: messages('tu-1'), taskNotifications: [existing as never] },
      ledgerOf([row])
    )
    expect(kept.taskNotifications).toEqual([existing])
  })
})
