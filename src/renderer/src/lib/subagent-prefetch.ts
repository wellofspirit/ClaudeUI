/**
 * The background phase of a Claude session load (ADR-102 Arc 2): the status line
 * (cost, tokens) and the subagent transcripts, which load AFTER the conversation
 * has painted.
 *
 * The content-first load commits the main transcript and leaves two things
 * pending on the entry: `backgroundLoad.statusPending` and `subagentIndex` (what
 * is on disk, by origin tool_use id). This module is everything that finishes them:
 *
 *  - a per-session JOB, started by ACTIVATION and never by the click path (R2): one
 *    reconciler on the store looks at the active session and ensures a job when it
 *    is historical, idle, holds its transcript, and has something pending. Anything
 *    else cancels the previous session's job. That one place covers the click, the
 *    rename / watch loads (`ensureTranscriptLoaded`) and re-activating a resident
 *    session — whose job restarts for exactly what is still missing;
 *  - the job runs the status pass concurrently with at most {@link MAX_BUCKET_FETCHES}
 *    bucket fetches. Order: a PARENT of a nested agent first (so the roster tree
 *    completes), then newest transcript first (`order` is the file's mtime). A bucket
 *    an on-demand request names jumps the queue ({@link requestSubagentTranscript}:
 *    a card or panel entry the user opened);
 *  - every write goes through a replica fill (`fillSubagentBucket`, `replaceStatusLine`)
 *    guarded by R1 (the entry still holds its transcript) and by the entry's
 *    GENERATION (R4): every commit and eviction of a transcript bumps it, so a result
 *    that was planned against a transcript that is gone writes nothing. Cancelling a
 *    job only stops NEW fetches — one already in flight still lands, if its generation
 *    holds and its bucket is still empty;
 *  - the bar (`backgroundLoad`) is planned up front (C5): total = the status pass
 *    (M + the index's S, from the commit) + the bytes of every bucket queued; status
 *    frames fill their share proportionally and each fetch adds its index bytes. It
 *    never goes backwards within a job and is cleared when everything is done. A job
 *    restarted by reactivation plans only what is still missing, so the bar starts
 *    again from 0% (by design);
 *  - a job needs nothing from the sidebar listing: the commit records where the
 *    transcript files are (`transcriptSource`), so a pinned or recent session the
 *    listing does not name still loads.
 *
 * Deliberately NOT here: the content load's own progress (`transcript-load-progress`),
 * and anything `awaitReloadBeforeSpawn` waits for — a send never waits on this.
 */

import { isInvokeTimeout } from '../utils/ipc-error'
import {
  markSubagentUnavailable,
  setBackgroundLoad,
  useSessionStore,
  type PerSessionState
} from '../stores/session-store'
import { fillSubagentBucket, replaceStatusLine } from '../stores/replica'

/** Bucket fetches in flight at once: each is a structured clone of a whole transcript. */
export const MAX_BUCKET_FETCHES = 2

interface Job {
  routingId: string
  /** The entry's `backgroundGeneration` this job was planned against (R4). */
  generation: number
  /** Where the transcript files are (recorded by the commit, never looked up in the listing). */
  source: { sessionId: string; projectKey: string }
  /** False for a job an on-demand request created: it fetches what was asked for and nothing else. */
  background: boolean
  statusWanted: boolean
  statusStarted: boolean
  statusDone: boolean
  /** The status pass's planned bytes, from the commit. */
  statusWeight: number
  /** 0..1 progress of the status pass itself. */
  statusFraction: number
  /** toolUseId -> index bytes, for every bucket the bar counts. */
  planned: Map<string, number>
  settled: Set<string>
  inFlight: Set<string>
  /** On-demand requests, the most recent first. */
  onDemand: string[]
  doneBytes: number
  fraction: number
}

const jobs = new Map<string, Job>()

const store = (): ReturnType<typeof useSessionStore.getState> => useSessionStore.getState()

function warn(message: string): void {
  window.api?.logRelay?.('warn', 'SubagentPrefetch', message)
}

function isLive(s: PerSessionState): boolean {
  return s.sdkActive || s.status.state === 'running'
}

function hasBucket(s: PerSessionState, toolUseId: string): boolean {
  return (s.subagentMessages[toolUseId]?.length ?? 0) > 0
}

/** Index entries whose transcript is on disk and whose bucket is not loaded. */
function missingBuckets(s: PerSessionState): string[] {
  const out: string[] = []
  for (const [toolUseId, entry] of Object.entries(s.subagentIndex ?? {})) {
    if (entry.bytes > 0 && !hasBucket(s, toolUseId)) out.push(toolUseId)
  }
  return out
}

/** The entry is still the transcript this job was planned against. */
function sessionOf(job: Job): PerSessionState | undefined {
  const s = store().sessions[job.routingId]
  return s && s.backgroundGeneration === job.generation ? s : undefined
}

// ---------------------------------------------------------------------------
// The bar
// ---------------------------------------------------------------------------

function label(job: Job, statusPending: boolean): string {
  const n = job.planned.size
  const subagents = `${n} subagent${n === 1 ? '' : 's'}`
  const what =
    statusPending && n > 0
      ? `Loading usage and ${subagents}`
      : statusPending
        ? 'Loading usage'
        : `Loading ${subagents}`
  return `${what} · ${Math.floor(job.fraction * 100)}%`
}

function publish(job: Job, finished = false): void {
  // Only the registered job draws: a cancelled one (cancel() unregisters it; its session was left and came
  // back) must not overwrite the bar of the job that replaced it.
  if (jobs.get(job.routingId) !== job) return
  const s = sessionOf(job)
  if (!s) return
  // A job that did not plan the status pass leaves its flag as the commit set it.
  const statusPending = job.statusWanted
    ? !job.statusDone
    : (s.backgroundLoad?.statusPending ?? false)
  if (finished && !statusPending) {
    setBackgroundLoad(job.routingId, job.generation, null)
    return
  }
  let total = job.statusWanted ? job.statusWeight : 0
  for (const bytes of job.planned.values()) total += bytes
  const done =
    (job.statusWanted ? job.statusWeight * (job.statusDone ? 1 : job.statusFraction) : 0) +
    job.doneBytes
  // Monotonic: a bucket requested later can grow the total, never shrink the bar.
  job.fraction = Math.max(job.fraction, total > 0 ? Math.min(1, done / total) : 0)
  setBackgroundLoad(job.routingId, job.generation, {
    fraction: job.fraction,
    label: label(job, statusPending),
    statusPending,
    statusBytes: s.backgroundLoad?.statusBytes ?? job.statusWeight
  })
}

// ---------------------------------------------------------------------------
// The job
// ---------------------------------------------------------------------------

/**
 * The next bucket to fetch, or null. An on-demand request wins (the most recent
 * first); then, for a background job, parents of nested agents (their buckets hold
 * the spawn that names the child, so the roster tree needs them first), then the
 * newest transcript.
 */
function nextBucket(job: Job): string | null {
  const s = sessionOf(job)
  if (!s) return null
  const candidates = new Set(
    missingBuckets(s).filter((id) => !job.inFlight.has(id) && !job.settled.has(id))
  )
  for (const id of job.onDemand) if (candidates.has(id)) return id
  if (!job.background || candidates.size === 0) return null
  const index = s.subagentIndex ?? {}
  const parents = new Set<string>()
  for (const entry of Object.values(index)) {
    if (entry.parentToolUseId) parents.add(entry.parentToolUseId)
  }
  return (
    [...candidates].sort(
      (a, b) => Number(parents.has(b)) - Number(parents.has(a)) || index[b].order - index[a].order
    )[0] ?? null
  )
}

function newJob(
  routingId: string,
  s: PerSessionState,
  source: { sessionId: string; projectKey: string },
  background: boolean
): Job {
  const job: Job = {
    routingId,
    generation: s.backgroundGeneration,
    source,
    background,
    statusWanted: false,
    statusStarted: false,
    statusDone: false,
    statusWeight: 0,
    statusFraction: 0,
    planned: new Map(),
    settled: new Set(),
    inFlight: new Set(),
    onDemand: [],
    doneBytes: 0,
    fraction: 0
  }
  if (background) enableBackground(job, s)
  jobs.set(job.routingId, job)
  return job
}

/** Plan the status pass and every missing bucket into the bar. */
function enableBackground(job: Job, s: PerSessionState): void {
  job.background = true
  job.statusWanted = !!s.backgroundLoad?.statusPending
  job.statusWeight = job.statusWanted ? (s.backgroundLoad?.statusBytes ?? 0) : 0
  for (const toolUseId of missingBuckets(s)) {
    job.planned.set(toolUseId, s.subagentIndex?.[toolUseId]?.bytes ?? 0)
  }
}

function pump(job: Job): void {
  // Cancelled (unregistered) or replaced: a fetch still in flight lands, but starts nothing.
  if (jobs.get(job.routingId) !== job) return
  const s = sessionOf(job)
  if (!s) {
    // The transcript this job was planned against is gone (reload / eviction).
    jobs.delete(job.routingId)
    return
  }
  if (job.background && job.statusWanted && !job.statusStarted) void runStatus(job)
  for (
    let next = nextBucket(job);
    next !== null && job.inFlight.size < MAX_BUCKET_FETCHES;
    next = nextBucket(job)
  ) {
    void fetchBucket(job, next)
  }
  const statusBusy = job.statusWanted && !job.statusDone
  if (job.inFlight.size === 0 && !statusBusy && nextBucket(job) === null) {
    publish(job, true)
    jobs.delete(job.routingId)
  }
}

async function withTimeoutRetry<T>(call: () => Promise<T>, what: string): Promise<T | null> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await call()
    } catch (err) {
      // The remote client gave up waiting, but the host may well have finished: once.
      if (attempt === 0 && isInvokeTimeout(err)) continue
      warn(`${what} failed: ${err instanceof Error ? err.message : String(err)}`)
      return null
    }
  }
}

async function runStatus(job: Job): Promise<void> {
  job.statusStarted = true
  publish(job)
  const status = await withTimeoutRetry(
    () =>
      window.api.loadSessionStatusLine(job.source.sessionId, job.source.projectKey, (p) => {
        if (!p.total) return
        job.statusFraction = Math.max(job.statusFraction, Math.min(1, p.done / p.total))
        publish(job)
      }),
    `loading the status line of ${job.routingId}`
  )
  // A reload or an eviction made this result stale: write nothing.
  if (!sessionOf(job)) return
  // `replaceStatusLine` drops it for a session that went live meanwhile (R3): the
  // live session seeds its own figures. Either way the wait is over.
  if (status) replaceStatusLine(job.routingId, status)
  job.statusDone = true
  if (jobs.get(job.routingId) === job) {
    publish(job)
    pump(job)
  } else {
    // The job was cancelled (its session was left) while the pass ran: the reading
    // still landed, so reactivation must not run the pass again.
    clearStatusPending(job)
  }
}

/** The status pass is over for the entry this job was planned against; keep any bar that has buckets left. */
function clearStatusPending(job: Job): void {
  const s = sessionOf(job)
  const bar = s?.backgroundLoad
  if (!s || !bar || !bar.statusPending) return
  setBackgroundLoad(
    job.routingId,
    job.generation,
    missingBuckets(s).length > 0 ? { ...bar, statusPending: false } : null
  )
}

async function fetchBucket(job: Job, toolUseId: string): Promise<void> {
  const entry = sessionOf(job)?.subagentIndex?.[toolUseId]
  if (!entry) return
  job.inFlight.add(toolUseId)
  if (!job.planned.has(toolUseId)) job.planned.set(toolUseId, entry.bytes)
  publish(job)
  const messages = await withTimeoutRetry(
    () =>
      window.api.loadSubagentHistory(job.source.sessionId, job.source.projectKey, entry.agentId),
    `loading subagent ${entry.agentId} of ${job.routingId}`
  )
  job.inFlight.delete(toolUseId)
  job.settled.add(toolUseId)
  if (!sessionOf(job)) return
  if (messages && messages.length > 0) {
    fillSubagentBucket(job.routingId, toolUseId, messages)
  } else {
    // Failed twice, or the file read back empty: stop treating a transcript as on its way.
    markSubagentUnavailable(job.routingId, job.generation, toolUseId)
  }
  job.doneBytes += job.planned.get(toolUseId) ?? 0
  publish(job)
  pump(job)
}

// ---------------------------------------------------------------------------
// Entry points
// ---------------------------------------------------------------------------

/**
 * Ask for one subagent transcript NOW (a TaskCard the user expanded, a panel entry
 * they opened): it jumps the queue. A no-op when the index lists no transcript for
 * it, when its bucket is loaded, or when it is already being fetched.
 */
export function requestSubagentTranscript(routingId: string, toolUseId: string): void {
  const s = store().sessions[routingId]
  const entry = s?.subagentIndex?.[toolUseId]
  if (!s || !entry || entry.bytes === 0 || hasBucket(s, toolUseId)) return
  let job = jobs.get(routingId)
  if (job && job.generation !== s.backgroundGeneration) job = undefined
  if (!job) {
    if (!s.transcriptSource) return
    job = newJob(routingId, s, s.transcriptSource, false)
  }
  if (job.inFlight.has(toolUseId)) return
  job.onDemand = [toolUseId, ...job.onDemand.filter((id) => id !== toolUseId)]
  pump(job)
}

/** Stop starting work for `job`: unregister it. A fetch already in flight still lands (generation permitting). */
function cancel(job: Job): void {
  if (jobs.get(job.routingId) === job) jobs.delete(job.routingId)
}

/**
 * The reconciler (R2): decide, from the store alone, which session's background
 * phase should be running. Idempotent — it is called on every change that could
 * alter the answer.
 */
function reconcile(): void {
  const state = store()
  const activeId = state.activeSessionId
  for (const [id, job] of [...jobs]) {
    if (id !== activeId && job.background) cancel(job)
  }
  if (!activeId) return
  const s = state.sessions[activeId]
  if (!s) return
  const existing = jobs.get(activeId)

  // "Nothing should run" exits all leave the entry with no stale wait: a bar or a
  // "Loading usage…" left behind here would never be cleared by anything else.
  const clearWait = (): void => {
    if (s.backgroundLoad) setBackgroundLoad(activeId, s.backgroundGeneration, null)
  }

  if (isLive(s)) {
    // A live session seeds its own status line and fills its own buckets; the wait
    // for a disk reading is over (the late one is dropped by the fill).
    if (existing?.background) cancel(existing)
    clearWait()
    return
  }
  if (!s.isHistorical || s.evicted || s.subagentIndex === null) {
    // E.g. a session that went live while inactive and came back idle.
    if (existing?.background) cancel(existing)
    clearWait()
    return
  }
  if (s.messages.length === 0) {
    // Loaded and empty (or the read failed and resolved empty): nothing to wait for.
    if (existing?.background) cancel(existing)
    clearWait()
    return
  }
  if (!s.backgroundLoad?.statusPending && missingBuckets(s).length === 0) {
    clearWait()
    return
  }

  if (existing && existing.generation === s.backgroundGeneration) {
    if (!existing.background) {
      enableBackground(existing, s)
      pump(existing)
    }
    return
  }
  if (!s.transcriptSource) {
    clearWait()
    return
  }
  pump(newJob(activeId, s, s.transcriptSource, true))
}

/**
 * Start reconciling. Called once per app (the renderer and the web client both run
 * it, from `useClaudeEvents`); returns the stop function.
 */
export function startBackgroundLoad(): () => void {
  let previous: unknown[] | null = null
  const check = (): void => {
    const state = store()
    const id = state.activeSessionId
    const s = id ? state.sessions[id] : undefined
    // Only what the decision reads: the store changes on every streamed token.
    const key = [
      id,
      s?.subagentIndex,
      s?.backgroundGeneration,
      s?.backgroundLoad?.statusPending,
      s?.sdkActive,
      s?.status.state,
      s?.isHistorical,
      s?.evicted,
      (s?.messages.length ?? 0) > 0,
      s?.transcriptSource
    ]
    const prev = previous
    if (prev && key.every((v, i) => Object.is(v, prev[i]))) return
    previous = key
    reconcile()
  }
  const unsubscribe = useSessionStore.subscribe(check)
  check()
  return () => {
    unsubscribe()
    for (const job of [...jobs.values()]) cancel(job)
  }
}

/** Test seam: forget every job (module state outlives a test). */
export function resetBackgroundLoadForTests(): void {
  for (const job of [...jobs.values()]) cancel(job)
  jobs.clear()
}
