/**
 * @vitest-environment node
 *
 * The media job service: returns at once, queues under the cap, gives up on a timeout, ends on Stop and on
 * the session's removal (never on a replaced session object), writes the file through a temp name, and
 * tells the session. The provider and the model catalog are mocked; files are real, in a temp directory.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import type { MediaGenerateRequest, MediaGenerateResult } from '../media-providers/types'
import { MediaProviderError } from '../media-providers/types'

const mocks = vi.hoisted(() => ({
  resolveModel: vi.fn(),
  generate: vi.fn()
}))
vi.mock('../media-catalog', () => ({ resolveMediaModel: mocks.resolveModel }))
vi.mock('../media-providers', () => ({ mediaProviderFor: () => ({ generate: mocks.generate }) }))
vi.mock('../logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }
}))

import { MediaJobService, MEDIA_VIDEO_BLOB_MAX_BYTES, type MediaStartArgs } from '../media-jobs'
import {
  hasRunningMediaJob,
  resetMediaJobActivityForTests,
  type MediaJobLedgerStore,
  type MediaJobRow
} from '../media-job-ledger'
import { blobStore } from '../blob-store'
import { resolveMediaFile } from '../media-files'
import { resolveMediaGeneration } from '../../../shared/media-generation'

const PNG = Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), Buffer.alloc(32)])

function fakeLedger(): MediaJobLedgerStore & { rows: Map<string, MediaJobRow> } {
  const rows = new Map<string, MediaJobRow>()
  const active = (r: MediaJobRow): boolean => r.status === 'queued' || r.status === 'running'
  return {
    rows,
    create: (row) => void rows.set(row.id, { ...row }),
    get: (id) => (rows.has(id) ? { ...rows.get(id)!, owner: null } : undefined),
    getByBlobHash: () => undefined,
    bySession: (sessionId) => [...rows.values()].filter((r) => r.sessionId === sessionId),
    update(id, patch) {
      const row = rows.get(id)
      if (!row || !active(row)) return
      for (const [k, v] of Object.entries(patch))
        if (v !== undefined) (row as unknown as Record<string, unknown>)[k] = v
    }
  }
}

interface Pending {
  req: MediaGenerateRequest
  resolve: (r: Partial<MediaGenerateResult>) => void
  reject: (e: unknown) => void
}

let dir: string
let cwd: string
let ledger: ReturnType<typeof fakeLedger>
let service: MediaJobService
let events: Array<[string, unknown[]]>
let delivered: Array<{ id: string; item: { from: { key: string; title: string }; text: string } }>
let deliverResult: { result: string; why?: string }
let rearm: ReturnType<typeof vi.fn<() => void>>
let sessionObject: { rearmIdleTimer: () => void } | undefined
let settings = resolveMediaGeneration({})
let pending: Pending[]
let ids: number

beforeEach(() => {
  dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'media-jobs-')))
  cwd = path.join(dir, 'work')
  fs.mkdirSync(cwd)
  ledger = fakeLedger()
  events = []
  delivered = []
  deliverResult = { result: 'delivered' }
  rearm = vi.fn<() => void>()
  sessionObject = { rearmIdleTimer: rearm }
  settings = resolveMediaGeneration({})
  pending = []
  ids = 0
  resetMediaJobActivityForTests()
  blobStore.clearForTests()
  mocks.resolveModel.mockReset()
  mocks.resolveModel.mockResolvedValue({
    ref: 'chatgpt-plan',
    source: 'chatgpt-plan',
    modelId: 'plan',
    label: 'ChatGPT Plan',
    acceptsImages: true
  })
  mocks.generate.mockReset()
  mocks.generate.mockImplementation(
    (req: MediaGenerateRequest) =>
      new Promise<MediaGenerateResult>((resolve, reject) => {
        pending.push({
          req,
          resolve: (r) => resolve({ bytes: PNG, mime: 'image/png', ...r }),
          reject
        })
        req.signal.addEventListener('abort', () => reject(new Error('aborted')))
      })
  )
  service = new MediaJobService()
  service.configure({
    emit: ((channel: string, args: unknown[]) => void events.push([channel, args])) as never,
    deliver: async (id, item) => {
      delivered.push({ id, item })
      return deliverResult as never
    },
    session: () => sessionObject,
    pathContext: (_id, c) => ({ cwd: c }),
    settings: () => settings,
    ledger,
    now: () => Date.now(),
    newId: () => `${(++ids).toString(16).padStart(12, '0')}`
  })
})
afterEach(() => {
  vi.useRealTimers()
  fs.rmSync(dir, { recursive: true, force: true })
})

const call = (over: Partial<MediaStartArgs> = {}): MediaStartArgs => ({
  routingId: 'sess-1',
  cwd,
  engineId: 'claude',
  toolUseId: 'tu-1',
  kind: 'image',
  input: { prompt: 'a cat' },
  foreground: false,
  ...over
})
const eventsOf = (channel: string): unknown[][] =>
  events.filter(([c]) => c === channel).map(([, a]) => a)
const flush = async (): Promise<void> => {
  for (let i = 0; i < 10; i++) await Promise.resolve()
}
async function settle(): Promise<void> {
  await vi.waitFor(() => expect(service.activeCount()).toBe(0))
}

describe('start', () => {
  it('answers at once with the provisional path and the model label, and the card starts', async () => {
    const res = await service.start(call())
    expect(res).toMatchObject({ ok: true, jobId: '000000000001', modelLabel: 'ChatGPT Plan' })
    if (!res.ok) throw new Error('setup')
    expect(res.path).toBe(path.join(cwd, '.claude', 'ui', 'media', 'sess-1', '000000000001.png'))
    expect(ledger.rows.get(res.jobId)).toMatchObject({ status: 'running', toolUseId: 'tu-1' })
    expect(eventsOf('session:task-started')).toEqual([
      [
        'sess-1',
        expect.objectContaining({
          toolUseId: 'tu-1',
          taskId: res.jobId,
          taskType: 'media',
          wakesParent: true,
          isBackgrounded: true
        })
      ]
    ])
    expect(hasRunningMediaJob('sess-1')).toBe(true)
    expect(delivered).toEqual([])
  })

  it('refuses a bad prompt, model, output path or input image without recording a job', async () => {
    expect(await service.start(call({ input: { prompt: '  ' } }))).toMatchObject({ ok: false })
    mocks.resolveModel.mockResolvedValueOnce({ error: 'Nothing is connected.' })
    expect(await service.start(call())).toEqual({ ok: false, error: 'Nothing is connected.' })
    expect(
      await service.start(call({ input: { prompt: 'x', path: '../escape.png' } }))
    ).toMatchObject({ ok: false })
    expect(await service.start(call({ input: { prompt: 'x', path: 'a.txt' } }))).toMatchObject({
      ok: false
    })
    fs.writeFileSync(path.join(dir, 'secret.png'), PNG)
    expect(
      await service.start(call({ input: { prompt: 'x', images: [path.join(dir, 'secret.png')] } }))
    ).toMatchObject({ ok: false })
    expect(ledger.rows.size).toBe(0)
    expect(mocks.generate).not.toHaveBeenCalled()
  })

  it('asks the catalog for a model that takes images when the call has input images', async () => {
    fs.writeFileSync(path.join(cwd, 'in.png'), PNG)
    await service.start(call({ input: { prompt: 'edit', images: ['in.png'] } }))
    expect(mocks.resolveModel).toHaveBeenCalledWith('image', undefined, true)
  })
})

describe('a run', () => {
  it('a changed extension leaves an existing file the agent did not name alone', async () => {
    fs.writeFileSync(path.join(cwd, 'hero.png'), 'precious')
    const res = await service.start(call({ input: { prompt: 'a cat', path: 'hero.jpg' } }))
    if (!res.ok) throw new Error('setup')
    await vi.waitFor(() => expect(pending).toHaveLength(1))
    pending[0].resolve({ mime: 'image/png' })
    await settle()
    expect(fs.readFileSync(path.join(cwd, 'hero.png'), 'utf8')).toBe('precious')
    const saved = path.join(cwd, `hero.${res.jobId}.png`)
    expect(fs.readFileSync(saved)).toEqual(PNG)
    expect(ledger.rows.get(res.jobId)).toMatchObject({ status: 'completed', path: saved })
  })

  it('a job in a worktree outside the spawn cwd records that directory and is still served', async () => {
    const worktree = path.join(dir, 'wt')
    fs.mkdirSync(worktree)
    service.configure({
      emit: (() => {}) as never,
      deliver: async () => ({ result: 'delivered' }) as never,
      session: () => undefined,
      pathContext: (_id, c) => ({
        cwd: c,
        worktree: { worktreePath: worktree } as never
      }),
      settings: () => settings,
      ledger,
      now: () => Date.now(),
      newId: () => 'wtjob0000001'
    })
    const res = await service.start(call())
    if (!res.ok) throw new Error('setup')
    await vi.waitFor(() => expect(pending).toHaveLength(1))
    pending[0].resolve({})
    await settle()
    const row = ledger.rows.get(res.jobId)!
    expect(row.cwd).toBe(worktree)
    expect(row.path.startsWith(worktree)).toBe(true)
    expect(resolveMediaFile(res.jobId, { ledger, additionalDirectories: () => [] })).toMatchObject({
      path: row.path
    })
  })

  it('writes the file under the returned format, keeps a blob, records it, and tells the session', async () => {
    const res = await service.start(call({ input: { prompt: 'a cat', path: 'art/cat.png' } }))
    if (!res.ok) throw new Error('setup')
    await vi.waitFor(() => expect(pending).toHaveLength(1))
    expect(pending[0].req).toMatchObject({ kind: 'image', source: 'chatgpt-plan', prompt: 'a cat' })
    pending[0].resolve({ mime: 'image/webp', width: 8, height: 4, costUsd: 0.02 })
    await settle()

    const final = path.join(cwd, 'art', 'cat.webp')
    expect(fs.readFileSync(final)).toEqual(PNG)
    expect(fs.readdirSync(path.join(cwd, 'art'))).toEqual(['cat.webp'])
    const row = ledger.rows.get(res.jobId)!
    expect(row).toMatchObject({
      status: 'completed',
      path: final,
      mime: 'image/webp',
      bytes: PNG.length
    })
    expect(blobStore.get(row.blobHash!)?.data).toEqual(PNG)

    const [, note] = eventsOf('session:task-notification')[0] as [string, Record<string, unknown>]
    expect(note).toMatchObject({
      toolUseId: 'tu-1',
      status: 'completed',
      media: {
        path: final,
        fileId: res.jobId,
        blobId: row.blobHash,
        modelLabel: 'ChatGPT Plan',
        width: 8
      }
    })
    expect(delivered).toHaveLength(1)
    expect(delivered[0].id).toBe('sess-1')
    expect(delivered[0].item.from).toEqual({
      key: `media-job:${res.jobId}`,
      title: 'Image job finished'
    })
    expect(delivered[0].item.text).toContain(final)
    expect(delivered[0].item.text).toContain('ChatGPT Plan')
    expect(rearm).toHaveBeenCalledTimes(1)
    expect(hasRunningMediaJob('sess-1')).toBe(false)
  })

  it('a provider failure fails the job with truncated words, on the card, in the ledger and in the notice', async () => {
    const res = await service.start(call())
    if (!res.ok) throw new Error('setup')
    await vi.waitFor(() => expect(pending).toHaveLength(1))
    pending[0].reject(new MediaProviderError(`rejected by safety ${'x'.repeat(2000)}`, 400))
    await settle()
    const row = ledger.rows.get(res.jobId)!
    expect(row.status).toBe('failed')
    expect(row.error!.length).toBeLessThanOrEqual(500)
    expect(delivered[0].item.from.title).toBe('Image job failed')
    expect(delivered[0].item.text).toContain('rejected by safety')
    const [, note] = eventsOf('session:task-notification')[0] as [string, Record<string, unknown>]
    expect(note.status).toBe('failed')
    expect(fs.existsSync(path.join(cwd, '.claude'))).toBe(false)
  })

  it('does not save a file that would now land on a non-media file', async () => {
    const res = await service.start(call({ input: { prompt: 'x', path: 'pic2.png' } }))
    if (!res.ok) throw new Error('setup')
    await vi.waitFor(() => expect(pending).toHaveLength(1))
    // The agent's name became a directory while the provider worked.
    fs.mkdirSync(path.join(cwd, 'pic2.png'))
    pending[0].resolve({ mime: 'image/png' })
    await settle()
    expect(ledger.rows.get(res.jobId)?.status).toBe('failed')
  })

  it('keeps a video of at most 25 MB as a blob too and a larger one only as a file', async () => {
    const small = await service.start(call({ kind: 'video', toolUseId: 'tu-v1' }))
    await vi.waitFor(() => expect(pending).toHaveLength(1))
    pending[0].resolve({ bytes: Buffer.alloc(10, 1), mime: 'video/mp4', durationSeconds: 4 })
    await settle()
    if (!small.ok) throw new Error('setup')
    expect(ledger.rows.get(small.jobId)?.blobHash).toMatch(/^[0-9a-f]{64}$/)

    const big = await service.start(call({ kind: 'video', toolUseId: 'tu-v2' }))
    await vi.waitFor(() => expect(pending).toHaveLength(2))
    pending[1].resolve({
      bytes: Buffer.alloc(MEDIA_VIDEO_BLOB_MAX_BYTES + 1, 2),
      mime: 'video/mp4'
    })
    await settle()
    if (!big.ok) throw new Error('setup')
    expect(ledger.rows.get(big.jobId)).toMatchObject({ status: 'completed', blobHash: null })
    expect(fs.existsSync(ledger.rows.get(big.jobId)!.path)).toBe(true)
    expect(delivered[1].item.from.title).toBe('Video job finished')
  })

  it('records the provider job id as soon as it is known', async () => {
    const res = await service.start(call({ kind: 'video' }))
    if (!res.ok) throw new Error('setup')
    await vi.waitFor(() => expect(pending).toHaveLength(1))
    pending[0].req.onProviderJobId?.('or-job-9')
    expect(ledger.rows.get(res.jobId)?.providerJobId).toBe('or-job-9')
    pending[0].resolve({ mime: 'video/mp4' })
    await settle()
  })
})

describe('the concurrency cap', () => {
  it('queues the job past the cap, and starts it (with a fresh task-started) when one ends', async () => {
    settings = resolveMediaGeneration({ concurrency: 2 })
    const a = await service.start(call({ toolUseId: 'tu-a' }))
    await service.start(call({ toolUseId: 'tu-b' }))
    const c = await service.start(call({ toolUseId: 'tu-c' }))
    if (!a.ok || !c.ok) throw new Error('setup')
    await vi.waitFor(() => expect(pending).toHaveLength(2))
    expect(ledger.rows.get(c.jobId)?.status).toBe('queued')
    expect(hasRunningMediaJob('sess-1')).toBe(true)
    const startedBefore = eventsOf('session:task-started').length

    pending[0].resolve({})
    await vi.waitFor(() => expect(pending).toHaveLength(3))
    expect(ledger.rows.get(c.jobId)?.status).toBe('running')
    const started = eventsOf('session:task-started')
    expect(started.length).toBe(startedBefore + 1)
    expect(started.at(-1)).toEqual(['sess-1', expect.objectContaining({ toolUseId: 'tu-c' })])
    pending[1].resolve({})
    pending[2].resolve({})
    await settle()
  })

  it('Stop on a queued job ends it without ever calling the provider', async () => {
    settings = resolveMediaGeneration({ concurrency: 1 })
    await service.start(call({ toolUseId: 'tu-a' }))
    const queued = await service.start(call({ toolUseId: 'tu-b' }))
    if (!queued.ok) throw new Error('setup')
    expect(service.stop('sess-1', 'tu-b')).toBe(true)
    await vi.waitFor(() => expect(ledger.rows.get(queued.jobId)?.status).toBe('stopped'))
    expect(mocks.generate).toHaveBeenCalledTimes(1)
    pending[0].resolve({})
    await settle()
  })
})

describe('ending early', () => {
  it('gives up after the timeout, fails the job and tells the session', async () => {
    vi.useFakeTimers()
    settings = resolveMediaGeneration({ timeoutMinutes: 3 })
    const res = await service.start(call())
    if (!res.ok) throw new Error('setup')
    await flush()
    expect(pending).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(3 * 60_000 + 1)
    expect(pending[0].req.signal.aborted).toBe(true)
    expect(ledger.rows.get(res.jobId)).toMatchObject({ status: 'failed' })
    expect(delivered[0].item.text).toMatch(/within 3 minutes/)
  })

  it('Stop cancels one job by its call id and the agent is told it was stopped', async () => {
    const a = await service.start(call({ toolUseId: 'tu-a' }))
    const b = await service.start(call({ toolUseId: 'tu-b' }))
    if (!a.ok || !b.ok) throw new Error('setup')
    await vi.waitFor(() => expect(pending).toHaveLength(2))
    expect(service.stop('sess-other', 'tu-a')).toBe(false)
    expect(service.stop('sess-1', 'nope')).toBe(false)
    expect(service.stop('sess-1', 'tu-a')).toBe(true)
    await vi.waitFor(() => expect(ledger.rows.get(a.jobId)?.status).toBe('stopped'))
    expect(pending[0].req.signal.aborted).toBe(true)
    expect(pending[1].req.signal.aborted).toBe(false)
    expect(delivered[0].item.from.title).toBe('Image job stopped')
    const [, note] = eventsOf('session:task-notification')[0] as [string, Record<string, unknown>]
    expect(note.status).toBe('stopped')
    pending[1].resolve({})
    await settle()
  })

  it('a late provider answer after Stop does not turn it into a completion', async () => {
    const res = await service.start(call())
    if (!res.ok) throw new Error('setup')
    await vi.waitFor(() => expect(pending).toHaveLength(1))
    service.stop('sess-1', 'tu-1')
    pending[0].resolve({})
    await settle()
    expect(ledger.rows.get(res.jobId)?.status).toBe('stopped')
    expect(fs.existsSync(res.path)).toBe(false)
  })

  it('the session being removed aborts its jobs quietly; another session is untouched', async () => {
    const mine = await service.start(call())
    const other = await service.start(call({ routingId: 'sess-2', toolUseId: 'tu-x' }))
    if (!mine.ok || !other.ok) throw new Error('setup')
    await vi.waitFor(() => expect(pending).toHaveLength(2))
    service.onSessionRemoved('sess-1')
    await vi.waitFor(() => expect(ledger.rows.get(mine.jobId)?.status).toBe('interrupted'))
    expect(pending[0].req.signal.aborted).toBe(true)
    expect(pending[1].req.signal.aborted).toBe(false)
    expect(delivered).toEqual([])
    expect(hasRunningMediaJob('sess-1')).toBe(false)
    pending[1].resolve({})
    await settle()
  })

  it('a replaced session object (idle timeout, effort respawn) does not end a job; the notice follows the id', async () => {
    const res = await service.start(call())
    if (!res.ok) throw new Error('setup')
    await vi.waitFor(() => expect(pending).toHaveLength(1))
    sessionObject = undefined
    service.rekey('sess-1', 'sess-1-durable')
    expect(pending[0].req.signal.aborted).toBe(false)
    pending[0].resolve({})
    await settle()
    expect(ledger.rows.get(res.jobId)?.status).toBe('completed')
    expect(delivered[0].id).toBe('sess-1-durable')
    expect(eventsOf('session:task-notification')[0][0]).toBe('sess-1-durable')
    expect(rearm).not.toHaveBeenCalled()
  })

  it('a quit aborts the runs and leaves the rows active for the next boot’s sweep', async () => {
    const res = await service.start(call())
    if (!res.ok) throw new Error('setup')
    await vi.waitFor(() => expect(pending).toHaveLength(1))
    service.shutdown()
    await settle()
    expect(ledger.rows.get(res.jobId)?.status).toBe('running')
    expect(delivered).toEqual([])
  })
})

describe('notice delivery', () => {
  it('a held notice raises the held event for the session', async () => {
    deliverResult = { result: 'held', why: 'engine-exited' }
    await service.start(call())
    await vi.waitFor(() => expect(pending).toHaveLength(1))
    pending[0].resolve({})
    await settle()
    expect(eventsOf('session:dispatch-result-held')).toEqual([
      ['sess-1', { name: 'Image job finished' }]
    ])
  })

  it('a delivered notice raises no held event', async () => {
    await service.start(call())
    await vi.waitFor(() => expect(pending).toHaveLength(1))
    pending[0].resolve({})
    await settle()
    expect(eventsOf('session:dispatch-result-held')).toEqual([])
  })

  it('the idle timer is re-armed only when the session’s LAST job ends', async () => {
    await service.start(call({ toolUseId: 'tu-a' }))
    await service.start(call({ toolUseId: 'tu-b' }))
    await vi.waitFor(() => expect(pending).toHaveLength(2))
    pending[0].resolve({})
    await vi.waitFor(() => expect(delivered).toHaveLength(1))
    expect(rearm).not.toHaveBeenCalled()
    pending[1].resolve({})
    await settle()
    expect(rearm).toHaveBeenCalledTimes(1)
  })
})

describe('foreground (a subagent caller)', () => {
  it('waits for the outcome, returns it, and sends no notice', async () => {
    const started = service.start(call({ foreground: true }))
    await vi.waitFor(() => expect(pending).toHaveLength(1))
    let done = false
    void started.then(() => (done = true))
    await flush()
    expect(done).toBe(false)
    pending[0].resolve({})
    const res = await started
    expect(res).toMatchObject({ ok: true, final: { status: 'completed' } })
    expect(delivered).toEqual([])
    expect(eventsOf('session:task-notification')).toHaveLength(1)
    expect(eventsOf('session:task-started')[0]).toEqual([
      'sess-1',
      expect.objectContaining({ isBackgrounded: false })
    ])
  })

  it('returns a failure as the final result', async () => {
    const started = service.start(call({ foreground: true }))
    await vi.waitFor(() => expect(pending).toHaveLength(1))
    pending[0].reject(new MediaProviderError('no credit'))
    expect(await started).toMatchObject({
      ok: true,
      final: { status: 'failed', error: 'no credit' }
    })
  })
})
