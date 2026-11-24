/**
 * The media cards of a cold-loaded transcript.
 *
 * A media job's lifecycle (`task-started`, `task-notification` with its `media` outcome) is emitted by the
 * job service and written into no transcript, so a session reopened from disk would show its
 * `generate_image` cards with nothing to say how they ended. The ledger knows: one row per job, keyed by
 * the launching tool call. Like `withDispatchTasks`, this puts them back on a cold read. A card carries
 * its `blobId` (the image's hash) and `fileId` (the job id); `blob:get` re-interns the bytes from the saved
 * file on demand (`media-files.ts`), and a file that is gone leaves the existing "unavailable" state.
 */
import {
  MEDIA_TASK_TYPE,
  type MediaJobResult,
  type MediaPlanUsage
} from '../../shared/media-generation'
import type { ActiveTask, ChatMessage, TaskNotification } from '../../shared/types'
import { logger } from './logger'
import { mediaJobLedger, type MediaJobLedgerStore, type MediaJobRow } from './media-job-ledger'
import { noticeText } from './media-job-text'

interface MediaHistoryRead {
  messages: ChatMessage[]
  taskNotifications?: TaskNotification[]
  activeTasks?: Record<string, ActiveTask>
}

interface StoredUsage {
  elapsedMs?: number
  width?: number
  height?: number
  durationSeconds?: number
  revisedPrompt?: string
  inputs?: string[]
  planUsage?: MediaPlanUsage
}

function parseUsage(json: string | null): StoredUsage {
  if (!json) return {}
  try {
    const parsed: unknown = JSON.parse(json)
    return parsed && typeof parsed === 'object' ? (parsed as StoredUsage) : {}
  } catch {
    return {}
  }
}

/** The outcome a completed row's card draws. */
export function mediaResultOf(row: MediaJobRow): MediaJobResult {
  const usage = parseUsage(row.usageJson)
  return {
    kind: row.kind,
    jobId: row.id,
    path: row.path,
    mime: row.mime ?? (row.kind === 'image' ? 'image/png' : 'video/mp4'),
    bytes: row.bytes ?? 0,
    ...(usage.width !== undefined ? { width: usage.width } : {}),
    ...(usage.height !== undefined ? { height: usage.height } : {}),
    ...(usage.durationSeconds !== undefined ? { durationSeconds: usage.durationSeconds } : {}),
    ...(row.blobHash ? { blobId: row.blobHash } : {}),
    fileId: row.id,
    modelLabel: row.modelLabel,
    source: row.source,
    elapsedMs: usage.elapsedMs ?? (row.endedAt && row.startedAt ? row.endedAt - row.startedAt : 0),
    ...(row.costUsd !== null ? { costUsd: row.costUsd } : {}),
    ...(usage.planUsage ? { planUsage: usage.planUsage } : {}),
    ...(usage.revisedPrompt ? { revisedPrompt: usage.revisedPrompt } : {}),
    ...(usage.inputs?.length ? { inputs: usage.inputs } : {})
  }
}

function notificationOf(row: MediaJobRow, toolUseId: string): TaskNotification {
  const inputs = parseUsage(row.usageJson).inputs ?? []
  const job = { id: row.id, kind: row.kind, modelLabel: row.modelLabel, inputPaths: inputs }
  const base = { taskId: row.id, toolUseId, isBackgrounded: true }
  switch (row.status) {
    case 'completed': {
      const result = mediaResultOf(row)
      return {
        ...base,
        status: 'completed',
        outputFile: row.path,
        summary: noticeText(job, { status: 'completed', result }),
        media: result
      }
    }
    case 'stopped':
      return {
        ...base,
        status: 'stopped',
        outputFile: '',
        summary: noticeText(job, { status: 'stopped', error: '' })
      }
    case 'interrupted':
      return {
        ...base,
        status: 'unfinished',
        outputFile: '',
        summary: `${row.kind === 'video' ? 'Video' : 'Image'} job ${row.id} was interrupted before it finished (the app closed).`
      }
    default:
      return {
        ...base,
        status: 'failed',
        outputFile: '',
        summary: noticeText(job, { status: 'failed', error: row.error ?? 'The job failed.' })
      }
  }
}

/**
 * `result` with the session's media cards back: a terminal notification per ended job, an `activeTasks`
 * record per job still queued or running in this process. Only a row whose launching tool call is in the
 * loaded transcript yields anything, and a notification the engine's own reader already made for that
 * call is kept. Never throws: a history read must not fail because the ledger could not be read.
 */
export function withMediaTasks<T extends MediaHistoryRead>(
  sessionId: string,
  result: T,
  ledger: Pick<MediaJobLedgerStore, 'bySession'> = mediaJobLedger
): T & MediaHistoryRead {
  try {
    const rows = ledger.bySession(sessionId)
    if (rows.length === 0) return result
    const uses = new Set<string>()
    for (const message of result.messages) {
      for (const block of message.content) if (block.type === 'tool_use') uses.add(block.toolUseId)
    }
    const existing = result.taskNotifications ?? []
    const notified = new Set(existing.map((n) => n.toolUseId))
    const notifications: TaskNotification[] = []
    const activeTasks: Record<string, ActiveTask> = {}
    for (const row of rows) {
      const toolUseId = row.toolUseId
      if (!toolUseId || !uses.has(toolUseId)) continue
      if (row.status === 'queued' || row.status === 'running') {
        activeTasks[toolUseId] = {
          taskId: row.id,
          taskType: MEDIA_TASK_TYPE,
          isBackgrounded: true,
          wakesParent: true,
          startedAt: row.startedAt ?? row.createdAt,
          description: `${row.kind === 'video' ? 'Video' : 'Image'} generation`
        }
      } else if (!notified.has(toolUseId)) {
        notified.add(toolUseId)
        notifications.push(notificationOf(row, toolUseId))
      }
    }
    const hasActive = Object.keys(activeTasks).length > 0
    if (notifications.length === 0 && !hasActive) return result
    return {
      ...result,
      taskNotifications: [...existing, ...notifications],
      ...(hasActive ? { activeTasks: { ...result.activeTasks, ...activeTasks } } : {})
    }
  } catch (err) {
    logger.warn('MediaHistory', `could not add media cards to ${sessionId}: ${String(err)}`)
    return result
  }
}
