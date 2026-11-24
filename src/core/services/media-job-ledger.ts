/**
 * The media job ledger: `media_job` (operational.db, via `db.ts`) as the job service and the cold load
 * see it, the boot sweep, and the in-memory "this session has a job running" set the idle timer asks.
 *
 * A LEAF over `db.ts`: `BaseSession` asks {@link hasRunningMediaJob} on every idle-timer reset, so this
 * module may not import the session manager or the job service (the dispatch registry's precedent,
 * `hasRunningDispatch`).
 */
import {
  activeMediaJobs,
  getMediaJob,
  getMediaJobByBlobHash,
  insertMediaJob,
  interruptMediaJobs,
  mediaJobsBySession,
  addInboxItem,
  updateMediaJob,
  type ActiveMediaJob,
  type MediaJobPatch,
  type MediaJobRow,
  type MediaJobStatus
} from './db'
import { currentInstanceOwner, ownerIsGone, type InstanceOwner } from './instance-owner'
import { logger } from './logger'
import { MEDIA_JOB_KEY_PREFIX } from '../../shared/media-generation'

export type { ActiveMediaJob, MediaJobPatch, MediaJobRow, MediaJobStatus }

const LOG = 'MediaJobLedger'

/** Longest provider error text kept on a card, in the ledger and in a notice. */
export const MEDIA_ERROR_MAX = 500

/** A provider's error as it may be shown or stored: one line, cut short, nothing that looks like a key. */
export function truncateMediaError(text: string): string {
  const flat = text
    .replace(/\s+/g, ' ')
    .replace(/\b(sk|rk|pk)-[A-Za-z0-9_-]{8,}/g, '[redacted]')
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi, 'Bearer [redacted]')
    .trim()
  return flat.length > MEDIA_ERROR_MAX ? `${flat.slice(0, MEDIA_ERROR_MAX - 1)}…` : flat
}

export interface MediaJobLedgerStore {
  /** Insert a `queued` or `running` row owned by this instance. */
  create(row: MediaJobRow): void
  get(id: string): ActiveMediaJob | undefined
  getByBlobHash(hash: string): ActiveMediaJob | undefined
  /** A session's jobs, oldest first (empty when the ledger cannot be read). */
  bySession(sessionId: string): MediaJobRow[]
  /** Update a row still `queued`/`running`; an ended row keeps what ended it. */
  update(id: string, patch: MediaJobPatch): void
}

export const mediaJobLedger: MediaJobLedgerStore = {
  create: (row) => insertMediaJob(row, currentInstanceOwner()),
  get: (id) => getMediaJob(id),
  getByBlobHash: (hash) => getMediaJobByBlobHash(hash),
  bySession(sessionId) {
    try {
      return mediaJobsBySession(sessionId)
    } catch (err) {
      logger.warn(LOG, `could not read the media jobs of ${sessionId}: ${String(err)}`)
      return []
    }
  },
  update: (id, patch) => updateMediaJob(id, patch)
}

// ── Sessions with a job running ─────────────────────────────────────────────

const activeBySession = new Map<string, Set<string>>()

/** Record a job as running for a session (its idle timer must outlast it). */
export function markMediaJobActive(sessionId: string, jobId: string): void {
  const set = activeBySession.get(sessionId) ?? new Set<string>()
  set.add(jobId)
  activeBySession.set(sessionId, set)
}

/** The job ended. Returns true when it was the session's last one. */
export function markMediaJobDone(sessionId: string, jobId: string): boolean {
  const set = activeBySession.get(sessionId)
  if (!set?.delete(jobId)) return false
  if (set.size > 0) return false
  activeBySession.delete(sessionId)
  return true
}

/** Does this process run a media job for the session (durable id)? Its idle timer must not fire under it. */
export function hasRunningMediaJob(sessionId: string): boolean {
  return (activeBySession.get(sessionId)?.size ?? 0) > 0
}

/** A session's durable id changed: its active jobs follow. */
export function rekeyMediaJobSessions(oldId: string, newId: string): void {
  const set = activeBySession.get(oldId)
  if (!set || oldId === newId) return
  activeBySession.delete(oldId)
  const target = activeBySession.get(newId)
  if (target) for (const id of set) target.add(id)
  else activeBySession.set(newId, set)
}

/** Test seam. */
export function resetMediaJobActivityForTests(): void {
  activeBySession.clear()
}

// ── Boot sweep ──────────────────────────────────────────────────────────────

/** The notice text for a job the quit cut off. */
export function interruptedMediaText(row: Pick<MediaJobRow, 'id' | 'kind' | 'path'>): string {
  return (
    `${row.kind === 'video' ? 'Video' : 'Image'} job ${row.id} was interrupted before it finished ` +
    `(the app closed). Nothing was saved to ${row.path}. Ask for it again if it is still needed.`
  )
}

/**
 * Boot, once per process: a `queued`/`running` row whose owner is gone becomes `interrupted` and its
 * session is told through its inbox (no session object exists at boot; the item is delivered ahead of the
 * session's next turn, like any held item). A row owned by another live instance sharing the DB, or by
 * this boot, is left alone. `me` and `alive` are for tests.
 */
export function interruptStaleMediaJobs(
  me: InstanceOwner = currentInstanceOwner(),
  alive?: (pid: number) => boolean
): number {
  try {
    const stale = activeMediaJobs().filter((row) => ownerIsGone(row.owner, me, alive))
    const changed = new Set(interruptMediaJobs(stale.map((row) => row.id)))
    // Only the rows this pass changed: another instance booting over the same dead owner tells once.
    for (const row of stale) {
      if (!changed.has(row.id)) continue
      try {
        addInboxItem({
          target: row.sessionId,
          origin: 'dispatch-result',
          fromKey: `${MEDIA_JOB_KEY_PREFIX}${row.id}`,
          fromTitle: row.kind === 'video' ? 'Video job' : 'Image job',
          senderModeClass: null,
          body: interruptedMediaText(row)
        })
      } catch (err) {
        logger.warn(
          LOG,
          `could not tell ${row.sessionId} that ${row.id} was interrupted: ${String(err)}`
        )
      }
    }
    return changed.size
  } catch (err) {
    logger.warn(LOG, `boot pass over the media job ledger failed: ${String(err)}`)
    return 0
  }
}
