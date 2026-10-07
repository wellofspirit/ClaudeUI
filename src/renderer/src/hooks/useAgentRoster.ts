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
 * while they run (§7, "the shell rule"). They are listed in the SAME tree as
 * the agents (§10): a shell sits under the agent whose transcript holds its
 * Bash call, which `findTaskBlocks` reports as `ownerToolUseId`.
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
import { dispatchLabel, type ToolView } from '../../../shared/tool-kinds'
import { useActiveSession } from '../stores/session-store'
import { engineToolMap } from '../components/chat/tool-registry/engine-tool-maps'
import {
  bashMovedToBackground,
  deriveTaskState,
  latestNotification
} from '../components/chat/task-state'
import { findTaskBlocks } from '../components/TaskDetailPanel/utils'

type ToolUseBlock = Extract<ContentBlock, { type: 'tool_use' }>
type ToolResultBlock = Extract<ContentBlock, { type: 'tool_result' }>
type TaskView = Extract<ToolView, { kind: 'task' }>

export interface AgentRosterRow {
  /** The agent's ORIGIN tool_use id — what every other store map is keyed by. */
  toolUseId: string
  kind: 'agent' | 'shell'
  /**
   * The spawn call's name, its type or its model; for a shell the command's first
   * word. The list shows `agentRowLabel`, not this.
   */
  name: string
  /**
   * The spawn call gave this agent a name of its own (or it is a dispatch, whose
   * label is a real identity). When false, `name` is only a type or model
   * fallback ("Explore"), and the list labels the row with its description.
   * Always false for a shell, whose label is its command.
   */
  hasExplicitName: boolean
  /**
   * The agent TYPE the spawn call named (a custom type's tile, ADR-094); absent
   * when it named none, and for a cross-engine dispatch. The default type is
   * carried like any other: the tile decides it has nothing to say.
   */
  type?: string
  /** Set exactly when this row is a cross-engine dispatch: the tile is an X. */
  dispatch?: { engine: string; model?: string }
  description: string
  /**
   * 0 for a spawn in the main transcript; one more per agent it is nested in. A
   * shell is 0 in `shells`, and one deeper than the agent that launched it in `rows`.
   */
  depth: number
  /** The origin id of the agent whose transcript holds the spawn call (a shell: that launched it); absent at depth 0. */
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
  /** A shell's start (ms epoch, from its lifecycle record): what a running shell's clock counts from. */
  startedAt?: number
}

export interface AgentRoster {
  /** Every agent at every depth, depth-first: each row is followed by its descendants. */
  agents: AgentRosterRow[]
  /** Background shells that are running, plus a finished one whose entry is still open. All depth 0. */
  shells: AgentRosterRow[]
  /**
   * What the list draws (§10): the agents and the shells in one depth-first
   * tree. A shell is placed under the agent that launched it, one level deeper,
   * after that agent's child agents; a shell launched by the main session (or
   * by an agent the tree does not hold) closes the list at depth 0.
   */
  rows: AgentRosterRow[]
  /** Running agents (every depth) plus running shells — what the pill and tab show. */
  runningCount: number
  runningAgentCount: number
  runningShellCount: number
  /** Agents at every depth. Shells are not counted: a finished one is not listed. */
  totalCount: number
}

/**
 * What the list calls a row (§10): a shell is its whole command (`name` is only
 * the command's first word), an agent its explicit name, and an unnamed agent
 * its description, because its `name` is only a type or model that many rows
 * share. Shared with the shell entry's "launched by" line, so the two cannot
 * disagree.
 */
export function agentRowLabel(
  row: Pick<AgentRosterRow, 'kind' | 'name' | 'description' | 'hasExplicitName'>
): string {
  if (row.kind === 'shell') return row.description || row.name
  return row.hasExplicitName ? row.name : row.description || row.name
}

/** One spawn call as a bucket walk sees it — no position in the tree yet. */
export interface ScannedEntry {
  toolUseId: string
  kind: 'agent' | 'shell'
  name: string
  hasExplicitName: boolean
  type?: string
  dispatch?: { engine: string; model?: string }
  description: string
  hasResult: boolean
  resultIsError: boolean
  isBackground: boolean
  /**
   * Shells only: the origin id of the agent whose transcript holds the Bash
   * call, or null for the main transcript (`findTaskBlocks`' bucket key).
   */
  ownerToolUseId?: string | null
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
  rows: [],
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
  const results = new Map<string, ToolResultBlock>()
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
        results.set(block.toolUseId, block)
      }
    }
  }

  return spawns
    .filter((block) => !refused.has(block.toolUseId))
    .map((block) => {
      // With the result, as TaskCard does: pi's background flag is decided by it
      // (only a launch acknowledgement is a background run), so a spawn refused
      // before launch must not read as a background run with no notification.
      const result = results.get(block.toolUseId)
      const view = map.normalize('task', block.toolInput, result, block.toolName) as TaskView
      const name =
        view?.name ||
        (view?.dispatch ? dispatchLabel(view.dispatch) : undefined) ||
        view?.subagent ||
        // A Codex v1 spawn names no type and no path, only its model: it has
        // always been listed under that, not as a bare "Agent".
        view?.model ||
        map.displayName(block.toolName)
      return {
        toolUseId: block.toolUseId,
        kind: 'agent' as const,
        name,
        // A name the spawn gave, or a dispatch label, is an identity; the rest
        // of the chain above is a fallback that many agents share. The engines'
        // views fill `name` with the TYPE when the call named no one (Claude
        // `name ?? subagent_type`, opencode's `agent`, pi), so a `name` equal to
        // the type says nothing about this agent either.
        hasExplicitName:
          !!view?.dispatch ||
          (!!view?.name && view.name !== view.subagent) ||
          // Codex v1 only: its normalizer's description is the placeholder "Agent",
          // and a spawn that names no one and has no type carries just its model,
          // which is what these rows have always been listed under. That model IS
          // their identity. On any other engine a `model` is an override on an
          // otherwise anonymous agent, and the description says more.
          (engineId === 'codex' && !view?.name && !view?.subagent && !!view?.model),
        ...(view?.subagent ? { type: view.subagent } : {}),
        ...(view?.dispatch ? { dispatch: view.dispatch } : {}),
        description: view?.description || view?.prompt || '',
        hasResult: !!result,
        resultIsError: !!result?.isError,
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
  const shell = (
    toolUseId: string,
    block: ToolUseBlock,
    hasResult: boolean,
    isError: boolean,
    ownerToolUseId: string | null
  ) => {
    const command = String(block.toolInput?.command ?? '')
    return {
      toolUseId,
      kind: 'shell' as const,
      name: command.split(/\s+/)[0] || 'shell',
      hasExplicitName: false,
      description: command,
      hasResult,
      resultIsError: isError,
      isBackground: true,
      ownerToolUseId
    }
  }

  const out: ScannedEntry[] = []
  for (const [toolUseId, record] of Object.entries(opts.activeTasks)) {
    if (record.taskType !== 'local_bash' || record.isBackgrounded !== true) continue
    const { taskBlock, resultBlock, ownerToolUseId } = findTaskBlocks(
      opts.messages,
      toolUseId,
      opts.subagentMessages
    )
    if (!taskBlock) continue
    out.push(shell(toolUseId, taskBlock, !!resultBlock, !!resultBlock?.isError, ownerToolUseId))
  }

  for (const toolUseId of opts.openedIds) {
    if (opts.activeTasks[toolUseId]) continue
    const notification = latestNotification(opts.notifications, toolUseId)
    if (!notification) continue
    const { taskBlock, resultBlock, ownerToolUseId } = findTaskBlocks(
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
    if (background) {
      out.push(shell(toolUseId, taskBlock, !!resultBlock, !!resultBlock?.isError, ownerToolUseId))
    }
  }
  return out
}

function toRow(
  entry: RosterEntry,
  opts: {
    isHistorical: boolean
    activeTasks: Record<
      string,
      { taskId: string; taskType: string; runIndex?: number; startedAt?: number }
    >
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
    hasExplicitName: entry.hasExplicitName,
    ...(entry.type ? { type: entry.type } : {}),
    ...(entry.dispatch ? { dispatch: entry.dispatch } : {}),
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
    runIndex: active?.runIndex ?? notification?.runIndex ?? 1,
    ...(entry.kind === 'shell' && active?.startedAt ? { startedAt: active.startedAt } : {})
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

/**
 * The unified list (ADR-073 §10): the settled agents depth-first, with each
 * shell placed inside its owner's subtree, one level below it. Within a parent
 * the child agents (each followed by its own subtree) come first, then that
 * parent's shells in `listShells` order. A shell whose owner is the main
 * transcript, or is not an agent row in the tree, closes the list at depth 0.
 *
 * `agents` is already depth-first, so an owner's shells are emitted when the
 * walk leaves its subtree: at the next agent that is not deeper than it, or at
 * the end. A shell may outlive the agent that launched it; its row is still
 * placed under that agent, and the Running filter keeps the agent as context.
 */
function unifyRows(
  agents: AgentRosterRow[],
  shells: { row: AgentRosterRow; owner: string | null }[]
): AgentRosterRow[] {
  const agentById = new Map(agents.map((a) => [a.toolUseId, a]))
  const byOwner = new Map<string, AgentRosterRow[]>()
  const loose: AgentRosterRow[] = []
  for (const { row, owner } of shells) {
    const parent = owner ? agentById.get(owner) : undefined
    if (!parent) {
      loose.push(row)
      continue
    }
    const nested = { ...row, depth: parent.depth + 1, parentToolUseId: parent.toolUseId }
    const list = byOwner.get(parent.toolUseId)
    if (list) list.push(nested)
    else byOwner.set(parent.toolUseId, [nested])
  }
  if (byOwner.size === 0) return [...agents, ...loose]

  const out: AgentRosterRow[] = []
  // Owners whose subtree is still being walked, innermost last.
  const open: AgentRosterRow[] = []
  const leave = (depth: number): void => {
    while (open.length > 0 && open[open.length - 1].depth >= depth) {
      out.push(...byOwner.get(open.pop()!.toolUseId)!)
    }
  }
  for (const agent of agents) {
    leave(agent.depth)
    out.push(agent)
    if (byOwner.has(agent.toolUseId)) open.push(agent)
  }
  leave(0)
  return [...out, ...loose]
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
    const rows = unifyRows(
      agents,
      shellRows.map((row, i) => ({ row, owner: shells[i].ownerToolUseId ?? null }))
    )
    const runningAgentCount = agents.filter((r) => r.isRunning).length
    const runningShellCount = shellRows.filter((r) => r.isRunning).length
    return {
      agents,
      shells: shellRows,
      rows,
      runningCount: runningAgentCount + runningShellCount,
      runningAgentCount,
      runningShellCount,
      totalCount: agents.length
    }
  }, [tree, shells, activeTasks, taskNotifications, taskProgressMap, isHistorical])
}
