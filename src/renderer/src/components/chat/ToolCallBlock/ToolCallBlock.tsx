/**
 * ToolCallBlock — the stateful host for a passive tool card.
 *
 * Phase 6: this FC now computes the tool's `kind` (via the session's
 * EngineToolMap + engine-independent hostedMcpKind) and the neutral `ToolView`,
 * then renders the shared <ToolCard> shell. It still wires every store/IPC
 * handler (approval, background-task, stop, open-panel, background-watch) exactly
 * as before — only the presentational layer changed (ToolCallBlockView → ToolCard
 * + kind bodies).
 *
 * Kept as the public entry point so MessageBubble's renderToolBlock and
 * SubagentMessages keep importing `ToolCallBlock` unchanged.
 */

import { memo, useEffect, useState } from 'react'
import type {
  ContentBlock,
  PendingApproval,
  PermissionSuggestion,
  ToolReviewBlock
} from '../../../../../shared/types'
import { useSessionStore, useActiveSession } from '../../../stores/session-store'
import { hostedMcpKind } from '../../../../../shared/tool-kinds'
import { backgroundBashTaskId } from '../../../../../shared/claude-background-bash'
import { engineToolMap } from '../tool-registry/engine-tool-maps'
import { ToolCard } from '../tool-registry/ToolCard'
import { latestNotification } from '../task-state'

type ToolUseBlock = Extract<ContentBlock, { type: 'tool_use' }>
type ToolResultBlock = Extract<ContentBlock, { type: 'tool_result' }>

interface Props {
  block: ToolUseBlock
  result?: ToolResultBlock
  approval?: PendingApproval
  /** A permission judge's verdict on this call (F18) — the caller pairs it by id. */
  review?: ToolReviewBlock
}

export const ToolCallBlock = memo(function ToolCallBlock({
  block,
  result,
  approval,
  review
}: Props): React.JSX.Element {
  const activeSessionId = useSessionStore((s) => s.activeSessionId)
  const dismissApproval = useSessionStore((s) => s.dismissApproval)
  const openTaskPanel = useSessionStore((s) => s.openTaskPanel)
  const stoppingTaskIds = useActiveSession((s) => s.stoppingTaskIds)
  const setTaskStopping = useSessionStore((s) => s.setTaskStopping)
  const clearTaskStopping = useSessionStore((s) => s.clearTaskStopping)
  const isHistorical = useActiveSession((s) => s.isHistorical)
  const permissionMode = useActiveSession((s) => s.permissionMode)
  const engineId = useActiveSession((s) => s.status.engineId)
  const backgroundTasksEnabled = useActiveSession((s) => s.status.capabilities.backgroundTasks)
  const expandToolCalls = useSessionStore((s) => s.settings.expandToolCalls)
  const expandReadResults = useSessionStore((s) => s.settings.expandReadResults)
  const hideToolInput = useSessionStore((s) => s.settings.hideToolInput)
  const theme = useSessionStore((s) => s.settings.theme)
  const toolOutputMaxChars = useSessionStore((s) => s.settings.toolOutputMaxChars)

  const toolUseId = block.toolUseId || ''
  const isBash = block.toolName === 'Bash'
  const bashOutput = useActiveSession((s) => s.bashOutputs[toolUseId])
  const bgOutput = useActiveSession((s) => s.backgroundOutputs[toolUseId])
  // The live task record (session:task-started), when cli.js has registered this
  // call as a task — a foreground Bash does so a few seconds after it starts.
  const activeTask = useActiveSession((s) => (isHistorical ? undefined : s.activeTasks[toolUseId]))
  const taskNotifications = useActiveSession((s) => s.taskNotifications)
  const watchBackgroundOutput = useSessionStore((s) => s.watchBackgroundOutput)
  const unwatchBackgroundOutput = useSessionStore((s) => s.unwatchBackgroundOutput)

  const notification = isBash ? (latestNotification(taskNotifications, toolUseId) ?? null) : null
  // A foreground command cli.js moved to the background ("Send to background",
  // a timeout, a message that arrived while it ran) is a background command from
  // then on; its tool_result only says where the output goes. The record's flip
  // says so while the task runs; the terminal event drops the record, and from
  // then the tool_result's wording plus that event do. A transcript has neither
  // (history maps no shell's notification to its call), so a reopened session
  // keeps showing the tool_result.
  const movedToBackground =
    !isHistorical &&
    (activeTask?.isBackgrounded === true ||
      (notification !== null &&
        result !== undefined &&
        backgroundBashTaskId(result.toolResult) !== undefined))
  const isBackgroundBash = isBash && (!!block.toolInput?.run_in_background || movedToBackground)
  const bgNotification = isBackgroundBash ? notification : null

  const isStopping = stoppingTaskIds.includes(toolUseId)
  const [isBackgrounding, setIsBackgrounding] = useState(false)

  // Compute the semantic kind + neutral view from the session's engine tool map.
  // hostedMcpKind (mermaid/mockup/mcp) is engine-independent and resolves first.
  const toolMap = engineToolMap(engineId)
  const kind = hostedMcpKind(block.toolName) ?? toolMap.kindOf(block.toolName)
  const view = toolMap.normalize(kind, block.toolInput, result, block.toolName)
  const toolDisplayName = toolMap.displayName(block.toolName)

  // Start file polling as soon as a background bash tool_use renders, independent of
  // expanded state. BackgroundBashOutput only mounts when expanded, but auto-expand
  // waits for bgOutput to populate — moving the watch up here breaks that deadlock.
  useEffect(() => {
    if (!isBackgroundBash || isHistorical || !activeSessionId || !toolUseId) return
    watchBackgroundOutput(activeSessionId, toolUseId)
    return () => {
      unwatchBackgroundOutput(activeSessionId, toolUseId)
    }
  }, [
    isBackgroundBash,
    isHistorical,
    activeSessionId,
    toolUseId,
    watchBackgroundOutput,
    unwatchBackgroundOutput
  ])

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

  const handleBackgroundTask = async (): Promise<void> => {
    if (!activeSessionId) return
    setIsBackgrounding(true)
    const bgResult = await window.api.backgroundTask(activeSessionId, toolUseId)
    // Success needs no local state: the task's record flips to the background,
    // which hides the button on every client. A failure also arrives as a
    // session warning.
    setIsBackgrounding(false)
    if (!bgResult.success) {
      window.api.logError('ToolCallBlock', `Failed to background task: ${bgResult.error}`)
    }
  }

  const handleStopTask = async (): Promise<void> => {
    if (!activeSessionId) return
    // Capture the session id: switching sessions within the 10s fallback window
    // must still clear THIS session's stop pill, not whichever is active later.
    const rid = activeSessionId
    setTaskStopping(rid, toolUseId)
    const stopResult = await window.api.stopTask(rid, toolUseId)

    if (!stopResult.success) {
      window.api.logError('ToolCallBlock', `Failed to stop task: ${stopResult.error}`)
      clearTaskStopping(rid, toolUseId)
      return
    }

    setTimeout(() => {
      clearTaskStopping(rid, toolUseId)
    }, 10000)
  }

  const handleOpenTaskPanel = (): void => {
    if (activeSessionId) openTaskPanel(activeSessionId, toolUseId)
  }

  return (
    <ToolCard
      kind={kind}
      view={view}
      block={block}
      result={result}
      approval={approval}
      review={review}
      isHistorical={isHistorical}
      permissionMode={permissionMode}
      expandToolCalls={expandToolCalls}
      expandReadResults={expandReadResults}
      hideToolInput={hideToolInput}
      theme={theme}
      isBackgroundBash={isBackgroundBash}
      bashOutput={bashOutput}
      bgOutput={bgOutput}
      bgNotification={bgNotification}
      isStopping={isStopping}
      activeTask={activeTask}
      isBackgrounding={isBackgrounding}
      hasActiveSession={activeSessionId !== null}
      backgroundTasksEnabled={backgroundTasksEnabled}
      displayName={toolDisplayName}
      toolOutputMaxChars={toolOutputMaxChars}
      onApproval={handleApproval}
      onBackgroundTask={handleBackgroundTask}
      onStopTask={handleStopTask}
      onOpenTaskPanel={handleOpenTaskPanel}
    />
  )
})
