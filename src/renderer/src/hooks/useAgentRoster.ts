/**
 * Every agent this session has spawned, at every depth, and the background
 * shells that are running now (ADR-073, §7).
 *
 * Agents come from the `task` ToolView kind rather than from Claude's
 * `activeTasks`, so they are engine-neutral by construction: all four engines
 * normalize their spawn tools to that kind (Claude `Task`/`Agent`, opencode
 * `task`, pi `subagent`, Codex `collab:spawnAgent`, and `dispatch_agent` on
 * every engine). Claude contributes exact lifecycle events; the others fall
 * through to ADR-040's legacy heuristic inside `deriveTaskState`, exactly as
 * the cards do.
 *
 * A nested agent's spawn call lives in its parent's bucket
 * (`subagentMessages[<parent origin id>]`), so the scan walks the main
 * transcript and then, depth-first, the bucket of every agent it finds. Each
 * child row follows its parent, in the parent's spawn order.
 *
 * Shells are the opposite: they come from the live lifecycle records, and only
 * while they run (§7, "the shell rule").
 *
 * Scanning is the expensive part, so it is memoized per message array — one
 * walk per bucket, shared by every surface. A streaming delta in one agent's
 * bucket re-walks that bucket alone (the reducer replaces only the array it
 * touched). Assembling the tree from the cached buckets, and the live join,
 * are cheap passes that may run every time.
 */
import { useMemo } from 'react'
import type {
  ActiveTask,
  ChatMessage,
  ContentBlock,
  EngineId,
  TaskNotification
} from '../../../shared/types'
import type { ToolView } from '../../../shared/tool-kinds'
import { useActiveSession } from '../stores/session-store'
import { engineToolMap } from '../components/chat/tool-registry/engine-tool-maps'
import {
  bashMovedToBackground,
  deriveTaskState,
  latestNotification
} from '../components/chat/task-state'
import { findTaskBlocks } from '../components/TaskDetailPanel/utils'

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
  /** 0 for a spawn in the main transcript; one more per agent it is nested in. Shells are 0. */
  depth: number
  /** The origin id of the agent whose transcript holds the spawn call; absent at depth 0. */
  parentToolUseId?: string
  isRunning: boolean
  isError: boolean
  /** Ended by a stop rather than finishing — see `deriveTaskState`. */
  isStopped: boolean
  /** Neither running nor settled (historical, or `unfinished`) — see `deriveTaskState`. */
  isLoaded: boolean
  elapsedSeconds?: number
  lastToolName?: string
  usage?: { totalTokens: number; toolUses: number; durationMs: number }
  /** 1 unless the agent was resumed (ADR-073). */
  runIndex: number
}

export interface AgentRoster {
  /** Every agent at every depth, depth-first: each row is followed by its descendants. */
  agents: AgentRosterRow[]
  /** Background shells that are running, plus a finished one whose entry is still open. */
  shells: AgentRosterRow[]
  /** Running agents (every depth) plus running shells — what the pill and tab show. */
  runningCount: number
  runningAgentCount: number
  runningShellCount: number
  /** Agents at every depth. Shells are not counted: a finished one is not listed. */
  totalCount: number
}

/** One spawn call as a bucket walk sees it — no position in the tree yet. */
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

/** A scanned entry placed in the tree. */
export interface RosterEntry extends ScannedEntry {
  depth: number
  parentToolUseId?: string
}

type Buckets = Readonly<Record<string, ChatMessage[]>>

const EMPTY: AgentRoster = {
  agents: [],
  shells: [],
  runningCount: 0,
  runningAgentCount: 0,
  runningShellCount: 0,
  totalCount: 0
}

/**
 * Bucket walks performed so far. Read by the cache test only: it is how a test
 * proves that a new array for one bucket re-walks that bucket and no other.
 */
export const rosterScanStats = { walks: 0 }

/**
 * The bucket walk, shared across every mounted surface. The pill, the tab and
 * the panel all call the hook, and a `useMemo` inside it is per component — so
 * without this a streaming delta would walk the transcript three times. The
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
 * One pass over one message list (the main transcript, or one agent's bucket):
 * every agent spawn call in it, and which of them already have a result.
 * tool_use blocks live on assistant messages; tool_result blocks live on
 * synthetic user messages in the main transcript and on the calling message in
 * a bucket (the same split `findTaskBlocks` documents).
 *
 * Agents only: a shell is listed from its lifecycle record, not from the
 * transcript (see {@link listShells}).
 */
function scanTranscript(messages: ChatMessage[], engineId: EngineId): ScannedEntry[] {
  rosterScanStats.walks++
  const map = engineToolMap(engineId)
  const spawns: ToolUseBlock[] = []
  const results = new Map<string, boolean>() // toolUseId → isError
  // Calls refused before they ran (a `permission_denial` block): the opencode
  // host's plan-mode refusal of a subagent spawn (ADR-085 §3), or a Claude
  // `Task` a deny rule refused. A refused spawn never became an agent, so it is
  // no row. (A refused shell needs no filter: it never registers a lifecycle
  // record, which is the only way a shell is listed.)
  const refused = new Set<string>()

  for (const msg of messages) {
    for (const block of msg.content) {
      if (block.type === 'tool_use' && msg.role === 'assistant') {
        if (map.kindOf(block.toolName) === 'task') spawns.push(block)
      } else if (block.type === 'permission_denial' && msg.role === 'assistant') {
        refused.add(block.toolUseId)
      } else if (block.type === 'tool_result') {
        results.set(block.toolUseId, !!block.isError)
      }
    }
  }

  return spawns
    .filter((block) => !refused.has(block.toolUseId))
    .map((block) => {
      const view = map.normalize('task', block.toolInput, undefined, block.toolName) as TaskView
      const name = view?.name || view?.subagent || map.displayName(block.toolName)
      const badge = view?.subagent !== name ? view?.subagent : undefined
      return {
        toolUseId: block.toolUseId,
        kind: 'agent' as const,
        name,
        ...(badge ? { badge } : {}),
        description: view?.description || view?.prompt || '',
        hasResult: results.has(block.toolUseId),
        resultIsError: results.get(block.toolUseId) ?? false,
        // Since 2.1.219 an agent's input usually omits it — hence the lifecycle.
        isBackground: !!view?.background
      }
    })
}

/**
 * The agent tree, depth-first: the main transcript's spawns in order, each
 * followed by the spawns in its own bucket, recursively. A call is placed once
 * (the visited set), so a malformed bucket that repeats or contains its own
 * spawn cannot loop.
 */
export function scanAgentTree(
  messages: ChatMessage[],
  subagentMessages: Buckets,
  engineId: EngineId
): RosterEntry[] {
  const out: RosterEntry[] = []
  const placed = new Set<string>()
  const walk = (entries: ScannedEntry[], depth: number, parent?: string): void => {
    for (const entry of entries) {
      if (placed.has(entry.toolUseId)) continue
      placed.add(entry.toolUseId)
      out.push({ ...entry, depth, ...(parent ? { parentToolUseId: parent } : {}) })
      const bucket = subagentMessages[entry.toolUseId]
      if (bucket?.length) {
        walk(scanTranscriptCached(bucket, engineId), depth + 1, entry.toolUseId)
      }
    }
  }
  walk(scanTranscriptCached(messages, engineId), 0)
  return out
}

/**
 * The background shells to list (ADR-073 §7, "the shell rule"): a live
 * `local_bash` record whose `isBackgrounded` is true, at any depth. That flag
 * is exactly "running in the background" — `run_in_background`, or a command
 * moved there later — because a foreground Bash registers `false` whatever its
 * depth (cli.js 2.1.280, S0 probe). Only Claude reports shell lifecycles, so
 * only Claude lists shells, and a reopened session lists none.
 *
 * The one exception keeps a finished shell while its entry is open in the
 * panel (§6: clicking its row again is how the entry is put away). Its record
 * is gone by then, so it is recognized the way the panel recognizes a
 * background Bash: a terminal event, plus `run_in_background` or the
 * moved-to-background result.
 */
function listShells(opts: {
  isHistorical: boolean
  activeTasks: Record<string, ActiveTask>
  openedIds: readonly string[]
  notifications: TaskNotification[]
  messages: ChatMessage[]
  subagentMessages: Buckets
}): ScannedEntry[] {
  if (opts.isHistorical) return []
  const shell = (toolUseId: string, block: ToolUseBlock, hasResult: boolean, isError: boolean) => {
    const command = String(block.toolInput?.command ?? '')
    return {
      toolUseId,
      kind: 'shell' as const,
      name: command.split(/\s+/)[0] || 'shell',
      description: command,
      hasResult,
      resultIsError: isError,
      isBackground: true
    }
  }

  const out: ScannedEntry[] = []
  for (const [toolUseId, record] of Object.entries(opts.activeTasks)) {
    if (record.taskType !== 'local_bash' || record.isBackgrounded !== true) continue
    const { taskBlock, resultBlock } = findTaskBlocks(
      opts.messages,
      toolUseId,
      opts.subagentMessages
    )
    if (!taskBlock) continue
    out.push(shell(toolUseId, taskBlock, !!resultBlock, !!resultBlock?.isError))
  }

  for (const toolUseId of opts.openedIds) {
    if (opts.activeTasks[toolUseId]) continue
    const notification = latestNotification(opts.notifications, toolUseId)
    if (!notification) continue
    const { taskBlock, resultBlock } = findTaskBlocks(
      opts.messages,
      toolUseId,
      opts.subagentMessages
    )
    if (taskBlock?.toolName !== 'Bash') continue
    const background =
      !!taskBlock.toolInput?.run_in_background ||
      bashMovedToBackground({
        isHistorical: false,
        notification,
        resultText: resultBlock?.toolResult
      })
    if (background) out.push(shell(toolUseId, taskBlock, !!resultBlock, !!resultBlock?.isError))
  }
  return out
}

function toRow(
  entry: RosterEntry,
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
  const { isRunning, isError, isStopped, isLoaded } = deriveTaskState({
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
    depth: entry.depth,
    ...(entry.parentToolUseId ? { parentToolUseId: entry.parentToolUseId } : {}),
    isRunning,
    isError,
    isStopped,
    isLoaded,
    ...(progress?.elapsedTimeSeconds ? { elapsedSeconds: progress.elapsedTimeSeconds } : {}),
    ...(progress?.lastToolName ? { lastToolName: progress.lastToolName } : {}),
    // A live run's freshest figure is its progress tick; a finished run's is
    // its terminal notification — cli.js's last tick lands before the run's
    // final turns, so preferring it froze the row below the card's total. A
    // stop reported for a dead process carries no usage and keeps the tick.
    ...(progress?.usage || notification?.usage
      ? {
          usage: isRunning
            ? (progress?.usage ?? notification?.usage)
            : (notification?.usage ?? progress?.usage)
        }
      : {}),
    runIndex: active?.runIndex ?? notification?.runIndex ?? 1
  }
}

/**
 * Rows for the tree, top-down, with one engine-neutral rule (ADR-073 §7): a
 * nested row that no lifecycle event describes — no record, no terminal event
 * — cannot outlive its parent. Once the parent is not running, neither is it,
 * and without a result it settles as `isLoaded` (neutral), not as finished: a
 * row nothing reported on must not claim it completed.
 *
 * That row is running only by ADR-040's legacy heuristic (no result yet), and
 * on some engines the result never comes: a refused Codex v2 grandchild's
 * `started` card, or a pi/opencode child aborted mid-call. A row WITH a record
 * is never touched — a Claude agent that runs on after its parent went idle is
 * exactly what §7 exists to show. The tree is depth-first, so a parent's final
 * state is known before its children are settled.
 */
function settleOrphans(
  tree: RosterEntry[],
  row: (entry: RosterEntry) => AgentRosterRow,
  opts: { activeTasks: Record<string, unknown>; notifications: TaskNotification[] }
): AgentRosterRow[] {
  const running = new Map<string, boolean>()
  return tree.map((entry) => {
    let r = row(entry)
    if (
      r.isRunning &&
      entry.parentToolUseId !== undefined &&
      running.get(entry.parentToolUseId) === false &&
      !opts.activeTasks[entry.toolUseId] &&
      !latestNotification(opts.notifications, entry.toolUseId)
    ) {
      r = { ...r, isRunning: false, isStopped: false, isLoaded: !entry.hasResult }
    }
    running.set(entry.toolUseId, r.isRunning)
    return r
  })
}

const NO_BUCKETS: Buckets = {}
const NO_IDS: readonly string[] = []

export function useAgentRoster(): AgentRoster {
  const messages = useActiveSession((s) => s.messages)
  const subagentMessages = useActiveSession((s) => s.subagentMessages)
  const engineId = useActiveSession((s) => s.status.engineId)
  const activeTasks = useActiveSession((s) => s.activeTasks)
  const taskNotifications = useActiveSession((s) => s.taskNotifications)
  const taskProgressMap = useActiveSession((s) => s.taskProgressMap)
  const openedTaskToolUseIds = useActiveSession((s) => s.openedTaskToolUseIds)
  const isHistorical = useActiveSession((s) => s.isHistorical)

  // The tree — deliberately NOT dependent on the live maps. Each bucket's walk
  // is shared with the other surfaces through scanTranscriptCached.
  const tree = useMemo(
    () =>
      messages ? scanAgentTree(messages, subagentMessages ?? NO_BUCKETS, engineId ?? 'claude') : [],
    [messages, subagentMessages, engineId]
  )

  const shells = useMemo(
    () =>
      messages
        ? listShells({
            isHistorical: !!isHistorical,
            activeTasks: activeTasks ?? {},
            openedIds: openedTaskToolUseIds ?? NO_IDS,
            notifications: taskNotifications ?? [],
            messages,
            subagentMessages: subagentMessages ?? NO_BUCKETS
          })
        : [],
    [messages, subagentMessages, activeTasks, openedTaskToolUseIds, taskNotifications, isHistorical]
  )

  return useMemo(() => {
    if (tree.length === 0 && shells.length === 0) return EMPTY
    const opts = {
      isHistorical: !!isHistorical,
      activeTasks: activeTasks ?? {},
      notifications: taskNotifications ?? [],
      progress: taskProgressMap ?? {}
    }
    const agents = settleOrphans(tree, (entry) => toRow(entry, opts), opts)
    const shellRows = shells.map((entry) => toRow({ ...entry, depth: 0 }, opts))
    const runningAgentCount = agents.filter((r) => r.isRunning).length
    const runningShellCount = shellRows.filter((r) => r.isRunning).length
    return {
      agents,
      shells: shellRows,
      runningCount: runningAgentCount + runningShellCount,
      runningAgentCount,
      runningShellCount,
      totalCount: agents.length
    }
  }, [tree, shells, activeTasks, taskNotifications, taskProgressMap, isHistorical])
}
