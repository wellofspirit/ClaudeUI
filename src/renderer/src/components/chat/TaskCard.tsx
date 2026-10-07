import { useState, useMemo, useEffect } from 'react'
import type {
  ContentBlock,
  PendingApproval,
  PermissionDenialBlock,
  PermissionSuggestion,
  ToolReviewBlock
} from '../../../../shared/types'
import type { ToolView } from '../../../../shared/tool-kinds'
import { overlayItemStreams } from '../../../../core/shared/sync/item-stream'
import { useSessionStore, useActiveSession } from '../../stores/session-store'
import { MarkdownRenderer } from './MarkdownRenderer'
import { SubagentOutputBody } from './SubagentOutputBody'
import { TOOL_OUTPUT_SCOPE } from './ChatSearch/search-scope'
import { ApprovalButtons } from './ApprovalButtons'
import { PermissionDenialChip, PermissionDenialStrip } from './tool-registry/PermissionDenial'
import { ToolReviewChip, ToolReviewStrip, canApproveBlock } from './tool-registry/ToolReview'
import { deriveTaskState, latestNotification } from './task-state'
import { modelDisplayName } from '../../lib/model-display-name'
import { dispatchLabel } from '../../../../shared/tool-kinds'
import {
  AGENT_CHIP_CLASS,
  AgentTile,
  useAgentTile,
  type AgentTileSpec
} from '../agents/AgentTypeTile'

type ToolUseBlock = Extract<ContentBlock, { type: 'tool_use' }>
type ToolResultBlock = Extract<ContentBlock, { type: 'tool_result' }>
type TaskView = Extract<ToolView, { kind: 'task' }>

interface Props {
  block: ToolUseBlock
  result?: ToolResultBlock
  view: TaskView
  /**
   * Pending approval for THIS task tool call, matched by toolUseId in
   * MessageBubble. opencode (and any engine that gates the subagent-spawning
   * tool) raises a `permission.asked` for the `task` tool itself; without
   * rendering the decision here the subagent is never spawned and the turn
   * hangs forever with no actionable UI (FloatingApproval excludes it because
   * the toolUseId matches a rendered tool_use block). Mirrors the
   * plan/question lifted cards, which also consume `approval`.
   */
  approval?: PendingApproval
  /**
   * A refusal of THIS task call that no judge made — the opencode host's
   * plan-mode refusal of the subagent spawn (ADR-085 §3), or any engine's
   * denial of the task tool (a deny rule, a mode). Shown as ToolCard shows
   * one: a header chip, and a strip when expanded. The card's status is still
   * `failed` — the tool_result is the error.
   */
  denial?: PermissionDenialBlock
  /**
   * The auto-mode judge's verdict on THIS task call — a delegation the judge
   * reviewed (pi `agent` / `dispatch_agent`, opencode `task`). Shown as
   * ToolCard shows one, including the after-the-fact Approve on a block
   * (ADR-091 part 6): a blocked delegation is the commonest subagent block.
   */
  review?: ToolReviewBlock
}

export interface ParsedUsage {
  totalTokens: number | null
  toolUses: number | null
  durationMs: number | null
}

const USAGE_RE = /<usage>\s*([\s\S]*?)\s*<\/usage>/

export function parseUsage(text: string): { body: string; usage: ParsedUsage | null } {
  const match = text.match(USAGE_RE)
  if (!match) return { body: text, usage: null }

  const body = text.replace(USAGE_RE, '').trimEnd()
  const block = match[1]

  const get = (key: string): number | null => {
    const m = block.match(new RegExp(`${key}:\\s*(\\d+)`))
    return m ? Number(m[1]) : null
  }

  return {
    body,
    usage: {
      totalTokens: get('total_tokens'),
      toolUses: get('tool_uses'),
      durationMs: get('duration_ms')
    }
  }
}

export function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`
  const s = ms / 1000
  if (s < 60) return `${s.toFixed(1)}s`
  const m = Math.floor(s / 60)
  const rem = Math.round(s % 60)
  return `${m}m ${rem}s`
}

export function formatElapsed(seconds: number): string {
  if (seconds < 60) return `${Math.round(seconds)}s`
  const m = Math.floor(seconds / 60)
  const s = Math.round(seconds % 60)
  return `${m}m ${s}s`
}

/**
 * What a task card's clock reads.
 *
 * - Running with a known start: live, counted from the run's start. cli.js
 *   sends no elapsed ticks for an agent (`tool_progress` fires only for
 *   Bash/PowerShell under CLAUDE_CODE_REMOTE, for REPL, and as a 30 s
 *   heartbeat keyed `<id>-heartbeat-N`), so a card that waited for one never
 *   moved — and a usage-only `task_progress` left the reducer's default 0 in
 *   the row, which read "0s" for the whole run.
 * - Finished: the run's own duration, when the terminal event or the result
 *   reports one.
 * - Otherwise the last reported elapsed (the cross-engine dispatch heartbeat),
 *   and never a placeholder zero.
 */
export function taskElapsedLabel({
  isRunning,
  startedAt,
  now,
  durationMs,
  progressSeconds
}: {
  isRunning: boolean
  startedAt?: number
  now: number
  durationMs?: number | null
  progressSeconds?: number
}): string | undefined {
  if (isRunning && startedAt !== undefined) {
    return formatElapsed(Math.max(0, (now - startedAt) / 1000))
  }
  if (!isRunning && durationMs != null) return formatDuration(durationMs)
  return progressSeconds ? formatElapsed(progressSeconds) : undefined
}

/** Wall-clock ms, re-read every second while `live` — a running task's clock. */
export function useTicker(live: boolean): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!live) return
    setNow(Date.now())
    const id = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(id)
  }, [live])
  return now
}

export function formatTokens(n: number): string {
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`
  return String(n)
}

/**
 * Narrow card: below this container width the header and footer shed what they
 * can — the review chip's reviewer prefix, the word "Task", the usage text — and
 * "Open in panel" becomes an icon. The header sheds, it never wraps (one row,
 * always); a clock under 300px goes too (`@max-[300px]/taskcard:hidden`).
 */
const NARROW_ONLY_HIDE = '@max-[480px]/taskcard:hidden'

/**
 * The "send to background" glyph, the arrow-into-a-tray path of the harness
 * install pill's DownloadIcon (SettingsDialog/HarnessesInstalled.tsx), at 12px.
 * Shown only on a narrow card, in place of the words.
 */
function BackgroundIcon({
  testId,
  className = ''
}: {
  testId?: string
  className?: string
}): React.JSX.Element {
  return (
    <svg
      data-testid={testId}
      width="12"
      height="12"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={`hidden @max-[480px]/taskcard:block ${className}`}
      aria-hidden="true"
    >
      <path d="M12 4v11m0 0-4-4m4 4 4-4M5 20h14" />
    </svg>
  )
}
/**
 * The footer is one line unless even its whole chips cannot share it (resumed
 * at a large `chatFontScale`): then WHOLE chips wrap, the icon last on its line.
 * Wide cards never wrap.
 */
const NARROW_WRAP = '@max-[480px]/taskcard:flex-wrap @max-[480px]/taskcard:gap-y-1'

/**
 * A model label this many characters or longer gets the 5rem floor; a shorter
 * one (`opus`, `sonnet`, `Opus 5`) is `shrink-0`: it is already narrower than the
 * floor, so a floor would only pad it with blank space. The floor exists so a
 * LONG name cannot be crushed to "D.".
 *
 * Measured at 10px in the browser project (chip = text + 12px padding; the floor
 * is 80px, so the text budget is 68px). Mono is 5.5px a character: 12 chars =
 * 66px, 13 = 71.5px. Sans averages 4.8px (`Sonnet 4.5` 46.8px, `Claude Opus 5`
 * 64.7px, `DeepSeek V4.1 Flash` 91px) but runs to 9.3px for capitals (9 `W`s =
 * 84px). 11 errs toward the floor: it covers every mono label from 11 characters
 * (60.5px + 12 = 72.5px, 7.5px of slack under the floor) and the sans ones that
 * can reach 68px; only a label under 11 characters that is all wide capitals
 * could exceed the floor unfloored, and `shrink-0` keeps even that whole.
 */
const MODEL_FLOOR_MIN_CHARS = 11

/**
 * The card's footer row, left to right: type, background, model, then resumed,
 * usage and Open in panel at the right. The collapsed card and the expanded card
 * both end in it; only the wrapper differs (`className`).
 *
 * The type (ADR-094) is its tile: the engine's default type has none, and
 * neither a chip nor a tile is drawn. Below 480px it is the 16px letter tile
 * alone; wide, one element draws a chip in the type's colour, led by that same
 * tile and followed by the name, so phone and desktop read alike. A dispatch is
 * the X tile.
 *
 * Every chip is `whitespace-nowrap shrink-0` except the model, the one that
 * gives way: at phone width a chip breaking mid-token is worse than a truncated
 * model id. But it gives way to a floor (5rem): a model of "D." tells nobody
 * anything. Wide, the usage text and the model both give way; narrow, the usage
 * is gone, "Open in panel" is an icon and so is "background", so the row stays
 * one line wherever it can. Narrow, the footer can wrap, and `flex-wrap` breaks
 * a line on the items' BASIS sizes before anything shrinks, so the model's
 * natural width (about 130px, or 246px for a raw id) would push the chips after
 * it onto a second row even though shrinking it to its floor fits them all.
 * Hence `basis-[5rem]` (the floor, so line-breaking sees 5rem) with `grow` and
 * `max-w-fit` (it takes the leftover space, never more than its own text).
 */
function TaskFooter({
  className,
  tile,
  model,
  modelName,
  isBackground,
  runIndex,
  usage,
  openTestId,
  onOpenPanel
}: {
  className: string
  /** The type tile's spec; `null` for the default type (no tile, no chip). */
  tile: AgentTileSpec | null
  /** The raw model id, or a dispatch's "<engine> · <model>". */
  model: string | null
  /** The model's catalog name, when the picker has one; the raw id otherwise. */
  modelName: string | undefined
  isBackground: boolean
  runIndex: number
  usage: ParsedUsage | null | undefined
  openTestId: string
  onOpenPanel: () => void
}): React.JSX.Element {
  return (
    <div className={`${className} ${NARROW_WRAP}`}>
      {tile && (
        // One element, two faces (ADR-094): the tile alone below 480px, a chip in
        // the type's colour wide. The chip's padding and tint drop away narrow.
        <span
          data-testid="TaskCard.type"
          className={`inline-flex items-center gap-1 text-[10px] font-mono pl-0.5 pr-1.5 py-px rounded whitespace-nowrap shrink-0 @max-[480px]/taskcard:p-0 @max-[480px]/taskcard:bg-transparent ${AGENT_CHIP_CLASS[tile.colorId]}`}
        >
          <AgentTile
            testId="TaskCard.typeTile"
            letter={tile.letter}
            colorId={tile.colorId}
            title={tile.title}
          />
          <span className={NARROW_ONLY_HIDE}>{tile.label}</span>
        </span>
      )}
      {isBackground && (
        // One chip, two faces: the word wide, the tray icon below 480px (a word-only chip
        // left the ↗ alone on row 2 at chat ~1.22). The glyph is shared with Send to
        // background on purpose: that button shows only on FOREGROUND tasks, this chip
        // only on BACKGROUND ones, so the two never share a card.
        <span
          data-testid="TaskCard.background"
          title="Running in the background"
          aria-label="Running in the background"
          className="text-[10px] font-mono px-1.5 py-0.5 @max-[480px]/taskcard:p-1 rounded bg-warning/10 text-warning whitespace-nowrap shrink-0"
        >
          <span className={NARROW_ONLY_HIDE}>background</span>
          <BackgroundIcon testId="TaskCard.background.icon" />
        </span>
      )}
      {model && (
        <span
          data-testid="TaskCard.model"
          title={model}
          className={`text-[10px] px-1.5 py-0.5 rounded bg-bg-tertiary text-text-secondary ${
            (modelName ?? model).length >= MODEL_FLOOR_MIN_CHARS
              ? 'min-w-[5rem] truncate @max-[480px]/taskcard:basis-[5rem] @max-[480px]/taskcard:grow @max-[480px]/taskcard:max-w-fit'
              : 'shrink-0 whitespace-nowrap'
          } ${modelName ? '' : 'font-mono'}`}
        >
          {modelName ?? model}
        </span>
      )}
      {runIndex > 1 && (
        <span
          data-testid="TaskCard.resumed"
          className="text-[10px] font-mono px-1.5 py-0.5 rounded bg-accent/10 text-accent whitespace-nowrap shrink-0"
          title="This agent was sent a message after it finished, and ran again"
        >
          resumed ×{runIndex - 1}
        </span>
      )}
      {usage && (
        <span
          {...TOOL_OUTPUT_SCOPE}
          className={`text-[10px] font-mono text-text-secondary truncate min-w-0 ${NARROW_ONLY_HIDE}`}
        >
          {[
            usage.totalTokens != null && `${formatTokens(usage.totalTokens)} tokens`,
            usage.toolUses != null && `${usage.toolUses} tools`,
            usage.durationMs != null && formatDuration(usage.durationMs)
          ]
            .filter(Boolean)
            .join(' · ')}
        </span>
      )}
      {/* One button, two faces: the words wide, the ↗ icon (as ExitPlanModeCard's) narrow. */}
      <button
        data-testid={openTestId}
        onClick={onOpenPanel}
        title="Open in panel"
        aria-label="Open in panel"
        className="text-[11px] text-accent hover:underline @max-[480px]/taskcard:p-1 cursor-pointer whitespace-nowrap shrink-0 ml-auto"
      >
        <span className={NARROW_ONLY_HIDE}>Open in panel</span>
        <svg
          data-testid="TaskCard.openInPanel.icon"
          width="12"
          height="12"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          className="hidden @max-[480px]/taskcard:block"
          aria-hidden="true"
        >
          <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
          <polyline points="15 3 21 3 21 9" />
          <line x1="10" y1="14" x2="21" y2="3" />
        </svg>
      </button>
    </div>
  )
}

export function TaskCard({
  block,
  result,
  view,
  approval,
  denial,
  review
}: Props): React.JSX.Element {
  const activeSessionId = useSessionStore((s) => s.activeSessionId)
  const taskProgressMap = useActiveSession((s) => s.taskProgressMap)
  const dismissApproval = useSessionStore((s) => s.dismissApproval)
  const permissionMode = useActiveSession((s) => s.permissionMode)
  const openTaskPanel = useSessionStore((s) => s.openTaskPanel)
  const itemStreams = useActiveSession((s) => s.itemStreams)
  const subagentMsgs = useActiveSession((s) => s.subagentMessages)
  const taskNotifications = useActiveSession((s) => s.taskNotifications)
  const activeTasks = useActiveSession((s) => s.activeTasks)
  const stoppingTaskIds = useActiveSession((s) => s.stoppingTaskIds)
  const setTaskStopping = useSessionStore((s) => s.setTaskStopping)
  const clearTaskStopping = useSessionStore((s) => s.clearTaskStopping)
  const backgroundTasksEnabled = useActiveSession((s) => s.status.capabilities.backgroundTasks)
  const engineId = useActiveSession((s) => s.status.engineId)
  const availableModels = useSessionStore((s) => s.availableModels)
  const [expanded, setExpanded] = useState(false)

  const toolUseId = block.toolUseId
  const isHistorical = useActiveSession((s) => s.isHistorical)
  // ADR-091 part 6 — the host grants, marks and nudges; the marked review it
  // re-sends is what hides the button, on every client.
  const approveBlocked = canApproveBlock(review, { isHistorical, pending: !!approval })
    ? (): void => {
        if (!activeSessionId) return
        window.api.approveBlocked(activeSessionId, toolUseId).catch((err: unknown) => {
          window.api.logError('TaskCard', `Failed to approve blocked call: ${String(err)}`)
        })
      }
    : undefined
  const hasResult = !!result
  const msgs = useMemo(
    () => overlayItemStreams(subagentMsgs[toolUseId] || [], itemStreams, toolUseId),
    [subagentMsgs, itemStreams, toolUseId]
  )
  const bgNotification = latestNotification(taskNotifications, toolUseId)
  const hasSubagentOutput = msgs.length > 0
  // Has this task received a task_started wire event with no matching
  // task_notification yet? If so it is DEFINITELY still running, regardless
  // of tool_result/background-flag state — see PerSessionState.activeTasks.
  // Claude 2.1.219+ makes Agent/Task background-by-default and usually omits
  // `run_in_background` on the tool_use input (so `isBackground` above reads
  // false), while an immediate "Async agent launched successfully"
  // tool_result arrives (so `hasResult` reads true) — the pre-existing
  // `!hasResult` check alone would flip the card to "complete" instantly.
  // opencode/pi child sessions and historical transcripts never emit
  // task_started, so they have no activeTasks record and fall through to the
  // unchanged legacy heuristic below.
  const activeTask = isHistorical ? undefined : activeTasks[toolUseId]
  const hasActiveTask = !!activeTask
  // The input asked for the background, or cli.js reports the running task
  // there: from the start, or since a "Send to background" flip.
  const isBackground = !!view.background || activeTask?.isBackgrounded === true
  // cli.js has registered this task as running in the FOREGROUND — the only
  // state `background_tasks` can act on. Before task_started it answers "no
  // such task", and a background task has nothing to move.
  const isForegroundTask = activeTask?.isBackgrounded === false
  // Background tasks get a tool_result immediately ("agent launched") but keep
  // running until task_notification. In historical mode, tasks without results
  // show as "loaded" (neutral state) rather than running.
  const { isRunning, isError, isStopped, isLoaded } = deriveTaskState({
    isHistorical,
    hasActiveTask,
    isBackground,
    hasResult,
    notification: bgNotification,
    resultIsError: result?.isError ?? false
  })

  // Read display fields from the engine-neutral view (not block.toolInput)
  const description = (view.description || view.prompt || '').slice(0, 120)
  const prompt = view.prompt
  // The type tile (ADR-094): a dispatch is an X, the engine's default type has
  // none. `view.subagent` is a TYPE on every engine, and a Codex spawn has none.
  const tile = useAgentTile(engineId, view.subagent, view.dispatch)
  // A dispatch has no model of its own to name: its chip says where it went.
  const model = view.dispatch ? dispatchLabel(view.dispatch) : (view.model ?? null)
  const modelName =
    model && !view.dispatch ? modelDisplayName(availableModels, engineId, model) : undefined

  const progress = taskProgressMap[toolUseId]
  const startedAt = isRunning ? activeTasks[toolUseId]?.startedAt : undefined
  const now = useTicker(startedAt !== undefined)
  // How many times this agent has been started. The live record carries it
  // while it runs; the notification carries it afterwards, because activeTasks
  // drops the task at terminal (ADR-073).
  const runIndex = activeTasks[toolUseId]?.runIndex ?? bgNotification?.runIndex ?? 1

  const { body: resultBody, usage: parsedUsage } = useMemo(
    () => parseUsage(result?.toolResult || ''),
    [result?.toolResult]
  )

  // For background tasks, usage comes from the task notification, not the tool result
  const usage = bgNotification?.usage
    ? {
        totalTokens: bgNotification.usage.totalTokens,
        toolUses: bgNotification.usage.toolUses,
        durationMs: bgNotification.usage.durationMs
      }
    : parsedUsage
  const elapsed = taskElapsedLabel({
    isRunning,
    startedAt,
    now,
    durationMs: usage?.durationMs,
    progressSeconds: progress?.elapsedTimeSeconds
  })

  const isPendingApproval = !!approval
  const borderColor = isPendingApproval
    ? 'border-warning/40'
    : isRunning
      ? 'border-accent/30'
      : isError
        ? 'border-danger/30'
        : isStopped
          ? 'border-warning/30'
          : isLoaded
            ? 'border-border'
            : 'border-success/30'
  const status = isRunning
    ? 'running'
    : isError
      ? 'failed'
      : isStopped
        ? 'stopped'
        : isLoaded
          ? 'loaded'
          : 'completed'

  const isCompleted = !isRunning && !isError
  // Why the task failed. The tool_result's error text is the result body, but
  // the body shows the subagent's own output whenever it streamed any — the
  // usual case — which hid the reason (an opencode subagent that ran out of
  // context read as a bare "failed"), so show it alongside that output.
  // `isError` is already false for a stopped task (task-state.ts).
  const failureSummary = isError && hasSubagentOutput && result?.isError ? resultBody : ''
  const isStopping = stoppingTaskIds.includes(toolUseId)
  // Cross-engine dispatch cards (ADR-033 M3, M4b) reuse this component via the
  // 'task' kind but have no backgrounding concept — cli.js's backgroundTask
  // control targets native Task/Agent tool calls, not an in-flight MCP/bridge
  // dispatch. Detected by tool name (all three engines' dispatch tool names),
  // not a ToolView discriminator. Stop stays available (routed to
  // crossEngineDispatcher.stopDispatch via session:stop-task). The bare
  // 'dispatch_agent' name is pi's (pi.registerTool() has no mcp__/claudeui_
  // prefix to sanitize) — safe to match unconditionally since only pi ever
  // emits that exact bare name (Claude/opencode use their own prefixed names).
  const isDispatch =
    block.toolName === 'mcp__claude-ui-collab__dispatch_agent' ||
    block.toolName === 'claudeui_dispatch_agent' ||
    block.toolName === 'dispatch_agent'
  // Gated on capabilities.backgroundTasks — engines without background execution
  // never offer "Send to background" — and on a registered foreground task:
  // an agent launched in the background (the 2.1.219+ default) and a task
  // cli.js has not registered yet both answer `background_tasks` with
  // `{backgrounded:false}`, so the button would only ever produce a warning.
  const canBackground = isForegroundTask && !isStopping && backgroundTasksEnabled && !isDispatch
  const [isBackgrounding, setIsBackgrounding] = useState(false)

  const handleBackgroundTask = async (): Promise<void> => {
    if (!activeSessionId) return
    setIsBackgrounding(true)
    const bgResult = await window.api.backgroundTask(activeSessionId, toolUseId)
    // Success needs no local state: the task's record flips to the background
    // (ClaudeSession relays cli.js's task_updated), which hides the button on
    // every client. A failure also arrives as a session warning.
    setIsBackgrounding(false)
    if (!bgResult.success) {
      window.api.logError('TaskCard', `Failed to background task: ${bgResult.error}`)
    }
  }

  const handleApproval = async (
    decision: 'allow' | 'deny',
    selectedSuggestions?: PermissionSuggestion[]
  ): Promise<void> => {
    if (!approval || !activeSessionId) return
    await window.api.respondApproval(
      activeSessionId,
      approval.requestId,
      decision,
      undefined,
      selectedSuggestions
    )
    dismissApproval(activeSessionId, approval.requestId)
  }

  const handleStopTask = async (): Promise<void> => {
    if (!activeSessionId) return
    // Capture the session id: switching sessions within the 10s fallback window
    // must still clear THIS session's stop pill, not whichever is active later.
    const rid = activeSessionId
    setTaskStopping(rid, toolUseId)
    // isDispatch: routes to the dispatcher with a durable stop-intent — a
    // dispatch card can show "running" before the dispatch has even reached
    // the main process (ADR-033 M3), so the plain toolUseId lookup can miss.
    const result = await window.api.stopTask(rid, toolUseId, isDispatch)

    if (!result.success) {
      window.api.logError('TaskCard', `Failed to stop task: ${result.error}`)
      clearTaskStopping(rid, toolUseId)
      return
    }

    // Set timeout to clear state if notification doesn't arrive within 10s
    setTimeout(() => {
      clearTaskStopping(rid, toolUseId)
    }, 10000)
  }

  // Both footers (collapsed, expanded) say the same thing; only the wrapper differs.
  const footerProps = {
    tile,
    model,
    modelName,
    isBackground,
    runIndex,
    usage,
    onOpenPanel: () => activeSessionId && openTaskPanel(activeSessionId, toolUseId)
  }

  const statusIcon = isError ? (
    <svg
      width="12"
      height="12"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      className="text-danger shrink-0"
    >
      <circle cx="12" cy="12" r="10" />
      <line x1="15" y1="9" x2="9" y2="15" />
      <line x1="9" y1="9" x2="15" y2="15" />
    </svg>
  ) : isStopped ? (
    <svg
      width="12"
      height="12"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      className="text-warning shrink-0"
    >
      <circle cx="12" cy="12" r="10" />
      <rect x="9" y="9" width="6" height="6" />
    </svg>
  ) : isLoaded ? (
    <svg
      width="12"
      height="12"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      className="text-text-muted shrink-0"
    >
      <circle cx="12" cy="12" r="10" />
      <line x1="8" y1="12" x2="16" y2="12" />
    </svg>
  ) : isCompleted ? (
    <svg
      width="12"
      height="12"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      className="text-success shrink-0"
    >
      <circle cx="12" cy="12" r="10" />
      <polyline points="8 12 11 15 16 9" />
    </svg>
  ) : (
    <span className="w-3 h-3 rounded-full border-2 border-accent border-t-transparent shrink-0 animate-spin-slow" />
  )

  return (
    <div
      data-testid="TaskCard"
      data-status={status}
      className={`@container/taskcard rounded-lg border ${borderColor} bg-bg-secondary overflow-hidden`}
    >
      {/* Header — always visible, clickable to expand/collapse */}
      <button
        data-testid="TaskCard.expand"
        onClick={() => setExpanded(!expanded)}
        className="w-full flex items-center gap-2 @max-[300px]/taskcard:gap-1.5 px-3 h-9 border-b border-border hover:bg-bg-hover transition-colors cursor-pointer"
      >
        {statusIcon}
        <span className={`font-medium text-[13px] text-accent shrink-0 ${NARROW_ONLY_HIDE}`}>
          Task
        </span>
        <span className="text-text-secondary text-[12px] truncate flex-1 min-w-[3rem] @max-[300px]/taskcard:min-w-[2rem] text-left">
          {description}
        </span>
        {denial && <PermissionDenialChip denial={denial} testIdPrefix="TaskCard" />}
        {review && (
          <ToolReviewChip
            review={review}
            onApprove={expanded ? undefined : approveBlocked}
            testIdPrefix="TaskCard"
            prefixClassName={NARROW_ONLY_HIDE}
          />
        )}
        {elapsed !== undefined && (
          <span
            data-testid="TaskCard.elapsed"
            className="text-[11px] text-text-muted font-mono shrink-0 @max-[300px]/taskcard:hidden"
          >
            {elapsed}
          </span>
        )}
        {isStopped && <span className="text-[10px] text-warning shrink-0">stopped</span>}
        {isLoaded && (
          <span className="text-[10px] text-text-muted shrink-0">
            {bgNotification?.status === 'unfinished' ? 'unfinished' : 'loaded'}
          </span>
        )}
        {canBackground && !isBackgrounding && !isHistorical && (
          <button
            data-testid="TaskCard.sendToBackground"
            onClick={(e) => {
              e.stopPropagation()
              handleBackgroundTask()
            }}
            title="Send to background"
            aria-label="Send to background"
            className="text-[11px] px-2 py-0.5 @max-[480px]/taskcard:p-1 rounded bg-accent/10 text-accent hover:bg-accent/20 transition-colors shrink-0"
          >
            <span className={NARROW_ONLY_HIDE}>Send to background</span>
            <BackgroundIcon testId="TaskCard.sendToBackground.icon" />
          </button>
        )}
        {isBackgrounding && isForegroundTask && (
          <span
            title="Sending to background…"
            aria-label="Sending to background…"
            className="text-[10px] font-mono px-1.5 py-0.5 @max-[480px]/taskcard:p-1 rounded bg-accent/10 text-accent shrink-0"
          >
            {/* Narrow: the same tray glyph, pulsing, instead of the words. */}
            <span className={NARROW_ONLY_HIDE}>sending to background…</span>
            <BackgroundIcon className="animate-pulse" />
          </span>
        )}
        {isRunning && !isStopping && !isHistorical && !isPendingApproval && (
          <button
            data-testid="TaskCard.stop"
            onClick={(e) => {
              e.stopPropagation()
              handleStopTask()
            }}
            className="text-[11px] px-2 py-0.5 rounded bg-danger/10 text-danger hover:bg-danger/20 transition-colors shrink-0"
          >
            Stop
          </button>
        )}
        {isStopping && !isHistorical && (
          <span className="text-[10px] font-mono px-1.5 py-0.5 rounded bg-warning/10 text-warning shrink-0">
            stopping...
          </span>
        )}
        <svg
          width="10"
          height="10"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          className="text-text-secondary shrink-0 transition-transform duration-150"
          style={{ transform: expanded ? 'rotate(180deg)' : 'rotate(0deg)' }}
        >
          <polyline points="6 9 12 15 18 9" />
        </svg>
      </button>

      {/* Collapsed footer */}
      {!expanded && (hasResult || isRunning) && (
        <TaskFooter
          {...footerProps}
          className="flex items-center px-3 py-1.5 gap-1.5"
          openTestId="TaskCard.openInPanel"
        />
      )}

      {/* Expanded content */}
      {expanded && (
        <>
          {denial && <PermissionDenialStrip denial={denial} testIdPrefix="TaskCard" />}
          {review && (
            <ToolReviewStrip review={review} onApprove={approveBlocked} testIdPrefix="TaskCard" />
          )}
          {/* Instructions */}
          {prompt && (
            <div className="border-t border-border px-3 py-2">
              <div className="text-[10px] uppercase tracking-wider text-text-muted font-semibold mb-1">
                Instructions
              </div>
              <div className="text-[12px] text-text-secondary leading-[1.5] max-h-[200px] overflow-y-auto whitespace-pre-wrap">
                {prompt}
              </div>
            </div>
          )}

          {/* Result / running state */}
          <div {...TOOL_OUTPUT_SCOPE} className="border-t border-border">
            {hasSubagentOutput ? (
              <div className="px-3 py-2 max-h-[300px] overflow-y-auto">
                <SubagentOutputBody
                  msgs={msgs}
                  isRunning={isRunning}
                  isBackground={isBackground}
                  elapsedLabel={elapsed}
                  size="sm"
                />
              </div>
            ) : resultBody && !isBackground ? (
              <div className="px-3 py-2 text-[12px] text-text-primary/70">
                <div className="leading-[1.5] max-h-[300px] overflow-y-auto">
                  <MarkdownRenderer content={resultBody} />
                </div>
              </div>
            ) : isRunning ? (
              <div className="px-3 py-2 flex items-center gap-2 text-[12px] text-text-muted">
                <span className="w-2.5 h-2.5 rounded-full border-[1.5px] border-accent border-t-transparent animate-spin-slow" />
                <span>{isBackground ? 'Running in background...' : 'Running...'}</span>
                {elapsed !== undefined && <span className="font-mono text-[11px]">{elapsed}</span>}
              </div>
            ) : null}
          </div>

          {failureSummary && (
            <div
              data-testid="TaskCard.failureSummary"
              className="border-t border-border px-3 py-2 text-[12px] text-danger whitespace-pre-wrap break-words"
            >
              {failureSummary}
            </div>
          )}

          {/* Footer — badges + usage + open in panel */}
          {(hasResult || isRunning) && (
            <TaskFooter
              {...footerProps}
              className="border-t border-border px-3 py-1.5 flex items-center gap-1.5"
              openTestId="TaskCard.expanded.openInPanel"
            />
          )}
        </>
      )}

      {/* Pending approval — opencode (ask mode) gates the `task` tool itself.
          Render the decision inline so the subagent can actually be spawned;
          without this the turn hangs with no actionable UI. */}
      {isPendingApproval && (
        <ApprovalButtons
          approval={approval!}
          permissionMode={permissionMode}
          onApproval={handleApproval}
        />
      )}
    </div>
  )
}
