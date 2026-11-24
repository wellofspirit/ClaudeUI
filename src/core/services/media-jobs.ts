/**
 * The media job service: ClaudeUI-hosted `generate_image` / `generate_video` as BACKGROUND jobs.
 *
 * `start` validates the paths and the model, records the job in the ledger, emits the card's
 * `session:task-started`, queues it under the concurrency cap and answers at once; a run reads the input
 * images, calls the provider, writes the file (temp + rename), keeps the bytes in the blob store, updates
 * the ledger, emits `session:task-notification` with the outcome and puts a notice into the session that
 * asked (origin `dispatch-result`, sender `media-job:<id>`, so a held notice, the wake cap and the flush
 * edge are the X-Agent's). A caller that is itself a subagent runs in the FOREGROUND: `start` waits and
 * returns the outcome as the tool result, and no notice is sent.
 *
 * Lifetime. A job outlives the MCP call that started it (Esc must not kill it) and the session object
 * (an idle timeout or an effort respawn replaces it): events go out under the session's durable id, which
 * follows `rekey`, and the notice goes through the session manager at the moment it is delivered. It ends on
 * the card's Stop (`stop`), the give-up timeout, or the session being removed (`onSessionRemoved`: the user's
 * Disconnect/close/delete, never `cancel()`). A quit leaves the rows active: the next boot's sweep marks
 * them `interrupted` and tells the session.
 *
 * Collaborators come in through `configure` (the composition root's wiring), so this module imports no
 * session manager; the model catalog and the provider factory are imported directly.
 */
import { randomBytes } from 'node:crypto'
import {
  MEDIA_JOB_KEY_PREFIX,
  MEDIA_TASK_TYPE,
  resolveMediaGeneration,
  type MediaJobResult,
  type MediaKind,
  type MediaModelRef,
  type MediaGenerationSettings
} from '../../shared/media-generation'
import type { TaskNotification } from '../../shared/types'
import type {
  EmitArgs,
  EmitEvent,
  SessionEventChannel,
  SessionEventData
} from '../shared/sync/events'
import { blobStore } from './blob-store'
import type { DispatchResultItem, DispatchResultOutcome } from './dispatch-parent'
import { logger } from './logger'
import { resolveMediaModel } from './media-catalog'
import {
  hasRunningMediaJob,
  markMediaJobActive,
  markMediaJobDone,
  mediaJobLedger,
  rekeyMediaJobSessions,
  truncateMediaError,
  type MediaJobLedgerStore
} from './media-job-ledger'
import {
  finalOutputPath,
  mediaRoots,
  readMediaInput,
  resolveMediaOutput,
  writeMediaFile,
  type MediaPathContext
} from './media-path'
import { mediaProviderFor } from './media-providers'
import { noticeText, type MediaFinal } from './media-job-text'
import { MediaProviderError, type MediaInputImage } from './media-providers/types'

const LOG = 'MediaJobs'

/** A video this size or smaller is also kept as a blob; a larger one is played from its saved file. */
export const MEDIA_VIDEO_BLOB_MAX_BYTES = 25 * 1024 * 1024

export interface MediaJobInput {
  prompt: string
  /** Local input image paths (edits; a video's first/last frame). */
  images?: string[]
  /** A catalog ref; absent: the setting, then Automatic. */
  model?: MediaModelRef
  /** Where to save; absent: the default under the working directory. */
  path?: string
  duration?: number
  aspect?: '16:9' | '9:16' | '1:1'
}

export interface MediaStartArgs {
  /** The session's routing id at the call (re-keys are followed afterwards). */
  routingId: string
  cwd: string
  engineId: string
  /** The call's tool-use id: the card is keyed by it. */
  toolUseId: string | null
  kind: MediaKind
  input: MediaJobInput
  /** Wait for the job and return its outcome (a subagent caller); no notice is sent. */
  foreground: boolean
}

export type MediaStartResult =
  | { ok: false; error: string }
  | {
      ok: true
      jobId: string
      /** Provisional: the completion notice carries the final path (the extension follows the provider's format). */
      path: string
      modelLabel: string
      /** Foreground only. */
      final?: MediaFinal
    }

export interface MediaJobDeps {
  /** `emitEvent`: emit under a session's durable routing id. */
  emit: EmitEvent
  /** Put a notice into the session's inbox (`deliverDispatchResult`); a hold arms the flush edge. */
  deliver(sessionId: string, item: DispatchResultItem): Promise<DispatchResultOutcome>
  /** The session object that answers to the id now, if any (idle timer re-arm). */
  session(sessionId: string): { rearmIdleTimer?(): void } | undefined
  /** The working directory the session is in now and the user's additional directories. */
  pathContext(sessionId: string, cwd: string): MediaPathContext
  settings(): MediaGenerationSettings
  ledger: MediaJobLedgerStore
  now(): number
  newId(): string
}

type Reason = 'stop' | 'timeout' | 'close' | 'quit'

interface Job {
  id: string
  sessionId: string
  toolUseId: string | null
  kind: MediaKind
  input: MediaJobInput
  foreground: boolean
  ctx: MediaPathContext
  source: MediaJobResult['source']
  modelId: string
  modelLabel: string
  provisionalPath: string
  agentGiven: boolean
  inputPaths: string[]
  controller: AbortController
  reason?: Reason
  settle: (final: MediaFinal) => void
  settled: Promise<MediaFinal>
}

function defaultDeps(): MediaJobDeps {
  return {
    emit: () => {},
    deliver: async () => ({ result: 'held', why: 'not-configured' }),
    session: () => undefined,
    pathContext: (_id, cwd) => ({ cwd }),
    settings: () => resolveMediaGeneration(undefined),
    ledger: mediaJobLedger,
    now: () => Date.now(),
    newId: () => randomBytes(6).toString('hex')
  }
}

function kindWord(kind: MediaKind): string {
  return kind === 'video' ? 'Video' : 'Image'
}

export class MediaJobService {
  private deps: MediaJobDeps = defaultDeps()
  private readonly jobs = new Map<string, Job>()
  private queue: Job[] = []
  private running = 0
  private down = false

  configure(deps: Partial<MediaJobDeps>): void {
    this.deps = { ...defaultDeps(), ...deps }
    this.down = false
  }

  /** The immediate answer of `generate_image` / `generate_video`. */
  async start(args: MediaStartArgs): Promise<MediaStartResult> {
    const { deps } = this
    const prompt = typeof args.input.prompt === 'string' ? args.input.prompt.trim() : ''
    if (!prompt) return { ok: false, error: 'A prompt is required.' }
    const settings = deps.settings()
    const ctx = deps.pathContext(args.routingId, args.cwd)
    const images = args.input.images ?? []
    const limit = args.kind === 'video' ? 2 : 8
    if (images.length > limit) {
      return {
        ok: false,
        error: `At most ${limit} input images are allowed for ${args.kind} generation.`
      }
    }
    for (const given of images) {
      const checked = readMediaInput(ctx, given)
      if (!checked.ok) return { ok: false, error: checked.error }
    }
    const model = await resolveMediaModel(args.kind, args.input.model, images.length > 0)
    if ('error' in model) return { ok: false, error: model.error }

    const id = deps.newId()
    const output = resolveMediaOutput(ctx, {
      requested: args.input.path,
      kind: args.kind,
      saveTo: settings.saveTo,
      sessionKey: args.routingId,
      jobId: id
    })
    if (!output.ok) return { ok: false, error: output.error }

    let resolveFinal!: (final: MediaFinal) => void
    const settled = new Promise<MediaFinal>((resolve) => {
      resolveFinal = resolve
    })
    const job: Job = {
      id,
      sessionId: args.routingId,
      toolUseId: args.toolUseId,
      kind: args.kind,
      input: { ...args.input, prompt },
      foreground: args.foreground,
      ctx,
      source: model.source,
      modelId: model.modelId,
      modelLabel: model.label,
      provisionalPath: output.path,
      agentGiven: output.agentGiven,
      inputPaths: images,
      controller: new AbortController(),
      settle: resolveFinal,
      settled
    }

    const now = deps.now()
    const willRunAtOnce = this.running < settings.concurrency
    try {
      deps.ledger.create({
        id,
        sessionId: job.sessionId,
        // The working directory the job resolved to (a worktree, not the spawn cwd): the file route and
        // a cold load check the saved file against the roots of THIS directory.
        cwd: mediaRoots(ctx).workdir,
        toolUseId: job.toolUseId,
        kind: job.kind,
        status: willRunAtOnce ? 'running' : 'queued',
        modelRef: model.ref,
        modelLabel: model.label,
        source: model.source,
        path: output.path,
        mime: null,
        bytes: null,
        blobHash: null,
        providerJobId: null,
        error: null,
        createdAt: now,
        startedAt: willRunAtOnce ? now : null,
        endedAt: null,
        costUsd: null,
        usageJson: null
      })
    } catch (err) {
      logger.warn(LOG, `could not record media job ${id}: ${String(err)}`)
      return { ok: false, error: 'The media job could not be recorded.' }
    }
    this.jobs.set(id, job)
    markMediaJobActive(job.sessionId, id)
    this.emitStarted(job, now)
    if (willRunAtOnce) this.launch(job)
    else this.queue.push(job)

    const base = { ok: true as const, jobId: id, path: output.path, modelLabel: model.label }
    return args.foreground ? { ...base, final: await settled } : base
  }

  /** The card's Stop: cancel the job this call started. False when no job of the session has that call id. */
  stop(sessionId: string, toolUseId: string): boolean {
    for (const job of this.jobs.values()) {
      if (job.sessionId === sessionId && job.toolUseId === toolUseId) {
        this.abort(job, 'stop')
        return true
      }
    }
    return false
  }

  /** The session was removed (the user's Disconnect, close or delete): its jobs end; nobody is told. */
  onSessionRemoved(sessionId: string): void {
    for (const job of [...this.jobs.values()]) {
      if (job.sessionId === sessionId) this.abort(job, 'close')
    }
  }

  /** The session's durable id changed: its jobs and idle hold follow. */
  rekey(oldId: string, newId: string): void {
    if (oldId === newId) return
    for (const job of this.jobs.values()) if (job.sessionId === oldId) job.sessionId = newId
    rekeyMediaJobSessions(oldId, newId)
  }

  /**
   * Quit: abort what runs and drop the queue. The rows stay active on purpose: the next boot's sweep
   * marks them `interrupted` and tells each session (no notice is possible from a process that is leaving).
   */
  shutdown(): void {
    this.down = true
    for (const job of [...this.jobs.values()]) this.abort(job, 'quit')
  }

  /** Test seam: jobs the service still holds. */
  activeCount(): number {
    return this.jobs.size
  }

  private abort(job: Job, reason: Reason): void {
    if (job.reason) return
    job.reason = reason
    const queuedAt = this.queue.indexOf(job)
    if (queuedAt >= 0) {
      this.queue.splice(queuedAt, 1)
      // Never started: no run will settle it.
      void this.finish(job, reason === 'stop' ? 'stopped' : 'closed')
      return
    }
    job.controller.abort()
  }

  private launch(job: Job): void {
    this.running++
    void this.run(job)
  }

  private pump(): void {
    const cap = this.deps.settings().concurrency
    while (!this.down && this.running < cap && this.queue.length > 0) {
      const next = this.queue.shift()!
      const now = this.deps.now()
      try {
        this.deps.ledger.update(next.id, { status: 'running', startedAt: now })
      } catch (err) {
        logger.warn(LOG, `could not mark ${next.id} running: ${String(err)}`)
      }
      // The card's clock moves from the queue time to now.
      this.emitStarted(next, now)
      this.launch(next)
    }
  }

  private emitStarted(job: Job, startedAt: number): void {
    if (!job.toolUseId) return
    this.safeEmit(job, 'session:task-started', {
      toolUseId: job.toolUseId,
      taskId: job.id,
      taskType: MEDIA_TASK_TYPE,
      startedAt,
      wakesParent: true,
      isBackgrounded: !job.foreground,
      description: `${kindWord(job.kind)} generation`
    })
  }

  private safeEmit<C extends SessionEventChannel>(
    job: Job,
    channel: C,
    data: SessionEventData<C>
  ): void {
    try {
      this.deps.emit(channel, [job.sessionId, data] as EmitArgs<C>)
    } catch (err) {
      logger.warn(LOG, `"${channel}" event for ${job.id} failed: ${String(err)}`)
    }
  }

  private async run(job: Job): Promise<void> {
    const { deps } = this
    const timeoutMs = deps.settings().timeoutMinutes * 60_000
    const timer = setTimeout(() => this.abort(job, 'timeout'), timeoutMs)
    const startedAt = deps.now()
    try {
      const images: MediaInputImage[] = []
      for (const given of job.inputPaths) {
        const read = readMediaInput(job.ctx, given)
        if (!read.ok) throw new MediaProviderError(read.error)
        images.push({ bytes: read.bytes, mime: read.mime })
      }
      const settings = deps.settings()
      const generated = await mediaProviderFor(job.source).generate({
        kind: job.kind,
        source: job.source,
        modelId: job.modelId,
        prompt: job.input.prompt,
        images,
        ...(job.kind === 'image' ? { quality: settings.imageQuality } : {}),
        ...(job.input.duration !== undefined ? { durationSeconds: job.input.duration } : {}),
        ...(job.input.aspect ? { aspect: job.input.aspect } : {}),
        signal: job.controller.signal,
        onProviderJobId: (providerJobId) => {
          try {
            deps.ledger.update(job.id, { providerJobId })
          } catch (err) {
            logger.warn(LOG, `could not record the provider job id of ${job.id}: ${String(err)}`)
          }
        }
      })
      if (job.reason) throw new Error('aborted')
      const target = finalOutputPath(
        job.ctx,
        job.provisionalPath,
        generated.mime,
        job.kind,
        job.agentGiven,
        job.id
      )
      if (!target.ok) throw new MediaProviderError(target.error)
      writeMediaFile(job.ctx, target.path, generated.bytes)
      const ref =
        job.kind === 'image' || generated.bytes.length <= MEDIA_VIDEO_BLOB_MAX_BYTES
          ? blobStore.putBytes(generated.mime, generated.bytes)
          : null
      const result: MediaJobResult = {
        kind: job.kind,
        jobId: job.id,
        path: target.path,
        mime: generated.mime,
        bytes: generated.bytes.length,
        ...(generated.width !== undefined ? { width: generated.width } : {}),
        ...(generated.height !== undefined ? { height: generated.height } : {}),
        ...(generated.durationSeconds !== undefined
          ? { durationSeconds: generated.durationSeconds }
          : {}),
        ...(ref ? { blobId: ref.blobId } : {}),
        fileId: job.id,
        modelLabel: job.modelLabel,
        source: job.source,
        elapsedMs: deps.now() - startedAt,
        ...(generated.costUsd !== undefined ? { costUsd: generated.costUsd } : {}),
        ...(generated.planUsage ? { planUsage: generated.planUsage } : {}),
        ...(generated.revisedPrompt ? { revisedPrompt: generated.revisedPrompt } : {}),
        ...(job.inputPaths.length > 0 ? { inputs: job.inputPaths } : {})
      }
      await this.finish(job, 'completed', { result, ref: ref?.blobId ?? null })
    } catch (err) {
      await this.finish(job, 'error', { error: err })
    } finally {
      clearTimeout(timer)
      this.running--
      this.pump()
    }
  }

  /** The one place a job ends: ledger, card, notice, idle timer, registry. Never throws. */
  private async finish(
    job: Job,
    how: 'completed' | 'error' | 'stopped' | 'closed',
    detail: { result?: MediaJobResult; ref?: string | null; error?: unknown } = {}
  ): Promise<void> {
    try {
      let outcome: 'completed' | 'failed' | 'stopped' | 'interrupted' | 'quit'
      let error = ''
      if (job.reason === 'quit') outcome = 'quit'
      else if (job.reason === 'close') outcome = 'interrupted'
      else if (job.reason === 'stop') outcome = 'stopped'
      else if (job.reason === 'timeout') {
        outcome = 'failed'
        error = `The job did not finish within ${this.deps.settings().timeoutMinutes} minutes and was given up.`
      } else if (how === 'completed') outcome = 'completed'
      else {
        outcome = 'failed'
        error = truncateMediaError(
          detail.error instanceof Error ? detail.error.message : String(detail.error ?? 'failed')
        )
      }

      this.jobs.delete(job.id)
      const lastOfSession = markMediaJobDone(job.sessionId, job.id)
      if (outcome === 'quit') {
        // The row stays active: the next boot's sweep tells the session.
        job.settle({ status: 'failed', error: 'The app is closing.' })
        return
      }
      const now = this.deps.now()
      const result = outcome === 'completed' ? detail.result : undefined
      try {
        this.deps.ledger.update(job.id, {
          status: outcome === 'completed' ? 'completed' : outcome,
          endedAt: now,
          ...(result
            ? {
                path: result.path,
                mime: result.mime,
                bytes: result.bytes,
                blobHash: detail.ref ?? undefined,
                costUsd: result.costUsd,
                usageJson: JSON.stringify({
                  elapsedMs: result.elapsedMs,
                  width: result.width,
                  height: result.height,
                  durationSeconds: result.durationSeconds,
                  revisedPrompt: result.revisedPrompt,
                  inputs: result.inputs,
                  planUsage: result.planUsage
                })
              }
            : { error: outcome === 'stopped' ? 'Stopped by the user.' : error || undefined })
        })
      } catch (err) {
        logger.warn(LOG, `could not record the end of ${job.id}: ${String(err)}`)
      }

      if (outcome === 'interrupted') {
        job.settle({ status: 'stopped', error: 'The session was closed.' })
        return
      }
      const final: MediaFinal = result
        ? { status: 'completed', result }
        : {
            status: outcome === 'stopped' ? 'stopped' : 'failed',
            error: outcome === 'stopped' ? 'Stopped by the user.' : error
          }
      const text = noticeText(job, final)
      this.emitEnded(job, final, text)
      job.settle(final)
      // A foreground caller gets the outcome as its tool result: no notice.
      if (!job.foreground) await this.notify(job, final, text)
      if (lastOfSession) this.deps.session(job.sessionId)?.rearmIdleTimer?.()
    } catch (err) {
      logger.warn(LOG, `ending media job ${job.id} failed: ${String(err)}`)
      job.settle({ status: 'failed', error: 'The media job failed.' })
    }
  }

  private emitEnded(job: Job, final: MediaFinal, text: string): void {
    if (!job.toolUseId) return
    const note: TaskNotification = {
      taskId: job.id,
      toolUseId: job.toolUseId,
      status: final.status === 'completed' ? 'completed' : final.status,
      outputFile: final.status === 'completed' ? final.result.path : '',
      summary: text,
      isBackgrounded: !job.foreground,
      ...(final.status === 'completed' ? { media: final.result } : {})
    }
    this.safeEmit(job, 'session:task-notification', note)
  }

  private async notify(job: Job, final: MediaFinal, text: string): Promise<void> {
    const word = kindWord(job.kind)
    const title = `${word} job ${final.status === 'completed' ? 'finished' : final.status === 'stopped' ? 'stopped' : 'failed'}`
    let handed = false
    try {
      const outcome = await this.deps.deliver(job.sessionId, {
        from: { key: `${MEDIA_JOB_KEY_PREFIX}${job.id}`, title },
        text
      })
      handed = outcome.result === 'delivered' || outcome.result === 'queued'
    } catch (err) {
      logger.warn(LOG, `delivering the notice of ${job.id} failed: ${String(err)}`)
    }
    if (handed) return
    // Waiting in the inbox: its `wakesParent` record has left, so say so (as a held X-Agent result does).
    try {
      this.safeEmit(job, 'session:dispatch-result-held', { name: title })
    } catch (err) {
      logger.warn(LOG, `held-notice event failed: ${String(err)}`)
    }
  }
}

export const mediaJobs = new MediaJobService()

export { hasRunningMediaJob, noticeText }
export type { MediaFinal }
