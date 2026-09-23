/**
 * Every agent and background shell this session has spawned, in transcript
 * order (ADR-073).
 *
 * Built from the `task` ToolView kind rather than from Claude's `activeTasks`,
 * so it is engine-neutral by construction: all four engines normalize their
 * spawn tools to that kind (Claude `Task`/`Agent`, opencode `task`, pi
 * `subagent`, Codex `collab:spawnAgent`, and `dispatch_agent` on every engine).
 * Claude contributes exact lifecycle events; the others fall through to
 * ADR-040's legacy heuristic inside `deriveTaskState`, exactly as the cards do.
 *
 * Scanning the transcript is the expensive part, so it is memoized on the
 * message list alone — a `task_progress` tick every few seconds, times N
 * running agents, must not re-walk a long session. The live join happens in a
 * second, cheap pass.
 */
import { useMemo } from 'react'
import type { ChatMessage, ContentBlock, EngineId, TaskNotification } from '../../../shared/types'
import type { ToolView } from '../../../shared/tool-kinds'
import { useActiveSession } from '../stores/session-store'
import { engineToolMap } from '../components/chat/tool-registry/engine-tool-maps'
import { deriveTaskState, latestNotification } from '../components/chat/task-state'

type ToolUseBlock = Extract<ContentBlock, { type: 'tool_use' }>
type TaskView = Extract<ToolView, { kind: 'task' }>

export interface AgentRosterRow {
  /** The agent's ORIGIN tool_use id — what every other store map is keyed by. */
  toolUseId: string
  kind: 'agent' | 'shell'
  /** What to call it: the spawn call's name, its type, or the command. */
  name: string
  /** The type/model chip beside the name; absent when it would repeat `name`. */
  badge?: string
  description: string
  isRunning: boolean
  isError: boolean
  elapsedSeconds?: number
  lastToolName?: string
  usage?: { totalTokens: number; toolUses: number; durationMs: number }
  /** 1 unless the agent was resumed (ADR-073). */
  runIndex: number
}

export interface AgentRoster {
  agents: AgentRosterRow[]
  shells: AgentRosterRow[]
  /** Running agents AND shells — what the pill and tab count. */
  runningCount: number
  totalCount: number
}

export interface ScannedEntry {
  toolUseId: string
  kind: 'agent' | 'shell'
  name: string
  badge?: string
  description: string
  hasResult: boolean
  resultIsError: boolean
  isBackground: boolean
}

const EMPTY: AgentRoster = { agents: [], shells: [], runningCount: 0, totalCount: 0 }

/**
 * The transcript walk, shared across every mounted surface. The pill, the tab
 * and the panel all call the hook, and a `useMemo` inside it is per component —
 * so without this a streaming delta would walk the transcript three times. The
 * cache is keyed by the message array's identity (the store replaces it on
 * every change), so it invalidates exactly when the walk would have re-run.
 */
const scanCache = new WeakMap<ChatMessage[], { engineId: EngineId; entries: ScannedEntry[] }>()

export function scanTranscriptCached(messages: ChatMessage[], engineId: EngineId): ScannedEntry[] {
  const hit = scanCache.get(messages)
  if (hit && hit.engineId === engineId) return hit.entries
  const entries = scanTranscript(messages, engineId)
  scanCache.set(messages, { engineId, entries })
  return entries
}

/**
 * One pass over the transcript: every task/background-shell tool_use block, and
 * which tool_use ids already have a result. tool_use blocks live on assistant
 * messages; tool_result blocks live on synthetic user messages (the same split
 * `findTaskBlocks` documents).
 */
function scanTranscript(messages: ChatMessage[], engineId: EngineId): ScannedEntry[] {
  const map = engineToolMap(engineId)
  const spawns: ToolUseBlock[] = []
  const results = new Map<string, boolean>() // toolUseId → isError

  for (const msg of messages) {
    for (const block of msg.content) {
      if (block.type === 'tool_use' && msg.role === 'assistant') {
        const kind = map.kindOf(block.toolName)
        const isShell = kind === 'command' && !!block.toolInput?.run_in_background
        if (kind === 'task' || isShell) spawns.push(block)
      } else if (block.type === 'tool_result') {
        results.set(block.toolUseId, !!block.isError)
      }
    }
  }

  return spawns.map((block) => {
    const kind = map.kindOf(block.toolName)
    const isAgent = kind === 'task'
    const view = isAgent
      ? (map.normalize('task', block.toolInput, undefined, block.toolName) as TaskView)
      : null
    const command = String(block.toolInput?.command ?? '')
    const name = isAgent
      ? view?.name || view?.subagent || map.displayName(block.toolName)
      : command.split(/\s+/)[0] || 'shell'
    const badge = isAgent && view?.subagent !== name ? view?.subagent : undefined

    return {
      toolUseId: block.toolUseId,
      kind: isAgent ? ('agent' as const) : ('shell' as const),
      name,
      ...(badge ? { badge } : {}),
      description: isAgent ? view?.description || view?.prompt || '' : command,
      hasResult: results.has(block.toolUseId),
      resultIsError: results.get(block.toolUseId) ?? false,
      // A shell in this list is background by definition; an agent says so via
      // its view (and, since 2.1.219, usually does not — hence the lifecycle).
      isBackground: isAgent ? !!view?.background : true
    }
  })
}

function toRow(
  entry: ScannedEntry,
  opts: {
    isHistorical: boolean
    activeTasks: Record<string, { taskId: string; taskType: string; runIndex?: number }>
    notifications: TaskNotification[]
    progress: Record<
      string,
      { elapsedTimeSeconds: number; lastToolName?: string; usage?: AgentRosterRow['usage'] }
    >
  }
): AgentRosterRow {
  const notification = latestNotification(opts.notifications, entry.toolUseId)
  const active = opts.activeTasks[entry.toolUseId]
  const { isRunning, isError } = deriveTaskState({
    isHistorical: opts.isHistorical,
    hasActiveTask: !opts.isHistorical && !!active,
    isBackground: entry.isBackground,
    hasResult: entry.hasResult,
    notification,
    resultIsError: entry.resultIsError
  })
  const progress = opts.progress[entry.toolUseId]

  return {
    toolUseId: entry.toolUseId,
    kind: entry.kind,
    name: entry.name,
    ...(entry.badge ? { badge: entry.badge } : {}),
    description: entry.description,
    isRunning,
    isError,
    ...(progress?.elapsedTimeSeconds ? { elapsedSeconds: progress.elapsedTimeSeconds } : {}),
    ...(progress?.lastToolName ? { lastToolName: progress.lastToolName } : {}),
    ...(progress?.usage || notification?.usage
      ? { usage: progress?.usage ?? notification?.usage }
      : {}),
    runIndex: active?.runIndex ?? notification?.runIndex ?? 1
  }
}

export function useAgentRoster(): AgentRoster {
  const messages = useActiveSession((s) => s.messages)
  const engineId = useActiveSession((s) => s.status.engineId)
  const activeTasks = useActiveSession((s) => s.activeTasks)
  const taskNotifications = useActiveSession((s) => s.taskNotifications)
  const taskProgressMap = useActiveSession((s) => s.taskProgressMap)
  const isHistorical = useActiveSession((s) => s.isHistorical)

  // The transcript walk — deliberately NOT dependent on the live maps, and
  // shared with the other surfaces through scanTranscriptCached.
  const scanned = useMemo(
    () => (messages ? scanTranscriptCached(messages, engineId ?? 'claude') : []),
    [messages, engineId]
  )

  return useMemo(() => {
    if (scanned.length === 0) return EMPTY
    const rows = scanned.map((entry) =>
      toRow(entry, {
        isHistorical: !!isHistorical,
        activeTasks: activeTasks ?? {},
        notifications: taskNotifications ?? [],
        progress: taskProgressMap ?? {}
      })
    )
    return {
      agents: rows.filter((r) => r.kind === 'agent'),
      shells: rows.filter((r) => r.kind === 'shell'),
      runningCount: rows.filter((r) => r.isRunning).length,
      totalCount: rows.length
    }
  }, [scanned, activeTasks, taskNotifications, taskProgressMap, isHistorical])
}
