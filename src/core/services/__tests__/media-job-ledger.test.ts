/**
 * @vitest-environment node
 *
 * The media job ledger: migration v42 (`media_job`), the DAO in `db.ts`, the boot sweep with instance
 * owners, the in-memory "session has a job running" set, and the pure helpers.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  MIGRATIONS,
  closeDb,
  heldInboxItems,
  insertMediaJob,
  moveMediaJobSession,
  runMigrations,
  type Db,
  type MediaJobRow
} from '../db'
import {
  hasRunningMediaJob,
  interruptStaleMediaJobs,
  markMediaJobActive,
  markMediaJobDone,
  mediaJobLedger,
  rekeyMediaJobSessions,
  resetMediaJobActivityForTests,
  truncateMediaError,
  MEDIA_ERROR_MAX
} from '../media-job-ledger'
import { currentInstanceOwner } from '../instance-owner'
import { LATEST_SCHEMA_VERSION, openRawDb, userVersion } from '../../../test/helpers/migration-db'

beforeEach(() => {
  closeDb()
  resetMediaJobActivityForTests()
})
afterEach(() => {
  closeDb()
  resetMediaJobActivityForTests()
})

function job(over: Partial<MediaJobRow> = {}): MediaJobRow {
  return {
    id: 'aaaaaaaaaaaa',
    sessionId: 'sess-media-1',
    cwd: '/w',
    toolUseId: 'tu-1',
    kind: 'image',
    status: 'running',
    modelRef: 'chatgpt-plan',
    modelLabel: 'ChatGPT Plan',
    source: 'chatgpt-plan',
    path: '/w/.claude/ui/media/s/aaaaaaaaaaaa.png',
    mime: null,
    bytes: null,
    blobHash: null,
    providerJobId: null,
    error: null,
    createdAt: 1,
    startedAt: 1,
    endedAt: null,
    costUsd: null,
    usageJson: null,
    ...over
  }
}

describe('migration v42', () => {
  it('adds media_job on top of v41 and is a no-op the second time', () => {
    const db: Db = openRawDb()
    runMigrations(
      db,
      MIGRATIONS.filter((m) => m.version <= 41)
    )
    const has = (): boolean =>
      db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='media_job'").get() !==
      undefined
    expect(has()).toBe(false)
    runMigrations(db)
    expect(userVersion(db)).toBe(LATEST_SCHEMA_VERSION)
    expect(has()).toBe(true)
    const cols = (db.prepare('PRAGMA table_info(media_job)').all() as { name: string }[]).map(
      (c) => c.name
    )
    expect(cols).toEqual(
      expect.arrayContaining(['id', 'session_id', 'tool_use_id', 'blob_hash', 'provider_job_id'])
    )
    expect(cols).toEqual(expect.arrayContaining(['owner_pid', 'owner_boot', 'cost_usd']))
    expect(() => runMigrations(db)).not.toThrow()
    db.close()
  })
})

describe('the ledger', () => {
  it('creates a row owned by this instance and reads it back', () => {
    mediaJobLedger.create(job())
    const got = mediaJobLedger.get('aaaaaaaaaaaa')
    expect(got).toMatchObject({ status: 'running', modelLabel: 'ChatGPT Plan', toolUseId: 'tu-1' })
    expect(got?.owner).toEqual(currentInstanceOwner())
  })

  it('an update ends the row and clears its owner; an ended row is never written over', () => {
    mediaJobLedger.create(job())
    mediaJobLedger.update('aaaaaaaaaaaa', { status: 'stopped', endedAt: 5, error: 'Stopped' })
    expect(mediaJobLedger.get('aaaaaaaaaaaa')).toMatchObject({ status: 'stopped', owner: null })
    // A late provider answer must not turn the user's Stop into a completion.
    mediaJobLedger.update('aaaaaaaaaaaa', { status: 'completed', bytes: 9 })
    expect(mediaJobLedger.get('aaaaaaaaaaaa')).toMatchObject({ status: 'stopped', bytes: null })
  })

  it('finds a completed job by its blob hash, and a session’s jobs follow a re-key', () => {
    mediaJobLedger.create(job())
    mediaJobLedger.update('aaaaaaaaaaaa', { status: 'completed', blobHash: 'h'.repeat(64) })
    expect(mediaJobLedger.getByBlobHash('h'.repeat(64))?.id).toBe('aaaaaaaaaaaa')
    expect(mediaJobLedger.getByBlobHash('x'.repeat(64))).toBeUndefined()
    moveMediaJobSession('sess-media-1', 'sess-media-2')
    expect(mediaJobLedger.bySession('sess-media-1')).toEqual([])
    expect(mediaJobLedger.bySession('sess-media-2')).toHaveLength(1)
  })
})

describe('the boot sweep', () => {
  const OTHER_BOOT = { pid: 4_242_424, boot: 'this-boot' }

  it('interrupts the jobs of a gone owner and tells their session; leaves a live owner and this boot alone', () => {
    insertMediaJob(job({ id: 'dead00000001', sessionId: 'sess-dead' }), {
      pid: 777_001,
      boot: 'crashed'
    })
    insertMediaJob(
      job({ id: 'queued000001', sessionId: 'sess-dead', status: 'queued', kind: 'video' }),
      {
        pid: 777_001,
        boot: 'crashed'
      }
    )
    insertMediaJob(job({ id: 'alive0000001', sessionId: 'sess-alive' }), {
      pid: 777_002,
      boot: 'sibling'
    })
    insertMediaJob(job({ id: 'done00000001', sessionId: 'sess-dead', status: 'completed' }), null)
    expect(interruptStaleMediaJobs(OTHER_BOOT, (pid) => pid === 777_002)).toBe(2)
    expect(mediaJobLedger.get('dead00000001')).toMatchObject({ status: 'interrupted', owner: null })
    expect(mediaJobLedger.get('queued000001')?.status).toBe('interrupted')
    expect(mediaJobLedger.get('alive0000001')?.status).toBe('running')
    expect(mediaJobLedger.get('done00000001')?.status).toBe('completed')
    const held = heldInboxItems('sess-dead')
    expect(held.map((h) => h.fromKey).sort()).toEqual([
      'media-job:dead00000001',
      'media-job:queued000001'
    ])
    expect(held.every((h) => h.origin === 'dispatch-result')).toBe(true)
    expect(held.find((h) => h.fromKey.endsWith('queued000001'))?.body).toMatch(/^Video job/)
    // Run again: nothing is told twice.
    expect(interruptStaleMediaJobs(OTHER_BOOT, (pid) => pid === 777_002)).toBe(0)
    expect(heldInboxItems('sess-dead')).toHaveLength(2)
  })

  it('a row of this very boot is left alone', () => {
    mediaJobLedger.create(job())
    expect(interruptStaleMediaJobs(currentInstanceOwner())).toBe(0)
    expect(mediaJobLedger.get('aaaaaaaaaaaa')?.status).toBe('running')
  })
})

describe('the running set', () => {
  it('holds a session until its last job is done, and follows a re-key', () => {
    markMediaJobActive('s1', 'j1')
    markMediaJobActive('s1', 'j2')
    expect(hasRunningMediaJob('s1')).toBe(true)
    expect(markMediaJobDone('s1', 'j1')).toBe(false)
    rekeyMediaJobSessions('s1', 's2')
    expect(hasRunningMediaJob('s1')).toBe(false)
    expect(hasRunningMediaJob('s2')).toBe(true)
    expect(markMediaJobDone('s2', 'j2')).toBe(true)
    expect(hasRunningMediaJob('s2')).toBe(false)
  })
})

describe('truncateMediaError', () => {
  it('flattens, cuts and redacts key-shaped text', () => {
    const out = truncateMediaError(
      `bad\nkey sk-abcdefghijklmnop and Bearer abcdefghijklmnop12 ${'x'.repeat(900)}`
    )
    expect(out).not.toContain('\n')
    expect(out).not.toContain('sk-abcdefghijklmnop')
    expect(out).not.toContain('abcdefghijklmnop12')
    expect(out.length).toBeLessThanOrEqual(MEDIA_ERROR_MAX)
  })
})
