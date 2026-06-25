/**
 * ToolCard — the shared shell for passive tool cards.
 *
 * Decomposed from ToolCallBlock/View.tsx (behavior-preserving for Claude). Owns:
 *  - the card div + the header (status icon, displayName, summarizeTool, the
 *    background-task controls: Send-to-background / Stop / stopping pills, and
 *    the expand chevron);
 *  - the expand-region wrapper, with the kind body (TOOL_RENDERERS[kind].Body)
 *    rendering the input/result content;
 *  - the foreground/background bash extras (BackgroundBashOutput + the
 *    streaming/background "Open in panel" footers);
 *  - the shared <ApprovalButtons>.
 *
 * For custom-layout kinds (diagram/mockup), the body renders its own full card
 * (header + content + its own ApprovalButtons); ToolCard renders just the body.
 *
 * Streaming wiring is unchanged: `block.toolUseId` flows to the bash output
 * components and the body via props.
 */

import { useState, useEffect } from 'react'
import type {
  ContentBlock,
  PendingApproval,
  PermissionMode,
  PermissionSuggestion,
  TaskNotification
} from '../../../../../shared/types'
import type { ToolKind, ToolView } from '../../../../../shared/tool-kinds'
import type { ThemeId } from '../../../stores/session-store'
import { resolveToolVisualState, TOOL_BORDER_CLASSES } from '../ToolCallBlock/utils'
import { summarizeTool } from './summary'
import { ApprovalButtons } from '../ApprovalButtons'
import { TOOL_RENDERERS, type PassiveToolKind } from './kinds'
import { GenericBody } from './kinds/GenericBody'
import { BackgroundBashOutput } from './kinds/bash-output'
import type { BashOutputSlice, BgOutputSlice } from './kinds/types'

type ToolUseBlock = Extract<ContentBlock, { type: 'tool_use' }>
type ToolResultBlock = Extract<ContentBlock, { type: 'tool_result' }>

export type { BashOutputSlice, BgOutputSlice }

export interface ToolCardProps {
  kind: ToolKind
  view: ToolView
  block: ToolUseBlock
  result?: ToolResultBlock
  approval?: PendingApproval
  isHistorical: boolean
  permissionMode: PermissionMode
  expandToolCalls: boolean
  expandReadResults: boolean
  hideToolInput: boolean
  theme: ThemeId
  isBackgroundBash: boolean
  bashOutput?: BashOutputSlice
  bgOutput?: BgOutputSlice
  bgNotification: TaskNotification | null
  isStopping: boolean
  isBackgrounding: boolean
  hasActiveSession: boolean
  /** Show the "Send to background" affordance. Gated on capabilities.backgroundTasks. */
  backgroundTasksEnabled: boolean
  /**
   * Human-readable display name for the card header. Precomputed by the caller
   * from `engineToolMap(engineId).displayName(block.toolName)`. Defaults to
   * `block.toolName` when omitted (safety fallback).
   */
  displayName?: string
  /** Max chars to show in expandable text before truncation. From AppSettings. */
  toolOutputMaxChars?: number
  onApproval: (
    decision: 'allow' | 'deny',
    selectedSuggestions?: PermissionSuggestion[]
  ) => Promise<void>
  onBackgroundTask: () => Promise<void>
  onStopTask: () => Promise<void>
  onOpenTaskPanel: () => void
}

export function ToolCard({
  kind,
  view,
  block,
  result,
  approval,
  isHistorical,
  permissionMode,
  expandToolCalls,
  expandReadResults,
  hideToolInput,
  theme,
  isBackgroundBash,
  bashOutput,
  bgOutput,
  bgNotification,
  isStopping,
  isBackgrounding,
  hasActiveSession,
  backgroundTasksEnabled,
  displayName,
  toolOutputMaxChars,
  onApproval,
  onBackgroundTask,
  onStopTask,
  onOpenTaskPanel
}: ToolCardProps): React.JSX.Element {
  const isReadKind = kind === 'fileRead'
  const [expanded, setExpanded] = useState(
    isReadKind ? expandToolCalls && expandReadResults : expandToolCalls
  )
  useEffect(() => {
    if (isReadKind) {
      setExpanded(expandToolCalls && expandReadResults)
    } else {
      setExpanded(expandToolCalls)
    }
  }, [expandToolCalls, expandReadResults, isReadKind])

  const toolUseId = block.toolUseId || ''

  useEffect(() => {
    if ((bashOutput || bgOutput) && !expanded) setExpanded(true)
  }, [bashOutput, bgOutput]) // eslint-disable-line react-hooks/exhaustive-deps

  const summary = summarizeTool(kind, view)
  const headerName = displayName ?? block.toolName
  const hasResult = !!result
  const isPendingApproval = !isHistorical && !!approval

  const bgRunning = isBackgroundBash && !bgNotification && !isHistorical

  const visualState = resolveToolVisualState({
    toolName: block.toolName,
    hasResult,
    isHistorical,
    hasApproval: !!approval,
    isBackgroundBash,
    bgNotificationStatus: bgNotification?.status ?? null,
    resultIsError: result?.isError ?? false
  })
  const borderColor = TOOL_BORDER_CLASSES[visualState]
  const isError = visualState === 'error'
  const isSuccess = visualState === 'success'
  const isLoaded = visualState === 'loaded'
  const isForegroundBashRunning = visualState === 'running' && !isBackgroundBash
  const isCommand = kind === 'command'

  const statusIcon = isPendingApproval ? (
    <svg
      width="12"
      height="12"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      className="text-warning shrink-0"
    >
      <path d="M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z" />
      <line x1="12" y1="9" x2="12" y2="13" />
      <line x1="12" y1="17" x2="12.01" y2="17" />
    </svg>
  ) : isError ? (
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
  ) : isSuccess ? (
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
  ) : bgRunning ? (
    <span className="w-3 h-3 rounded-full border-2 border-accent border-t-transparent shrink-0 animate-spin-slow" />
  ) : (
    <span className="w-3 h-3 rounded-full border-2 border-text-muted border-t-transparent shrink-0 animate-spin-slow" />
  )

  // Lifted kinds (plan/question/todo/task) are normally routed away from ToolCard
  // by renderToolBlock. But SubagentMessages renders ToolCard directly for ALL
  // tool_use blocks, so a subagent's lifted-kind tool can land here — fall back to
  // the generic body (JSON input + result), matching the old generic switch.
  const renderer = TOOL_RENDERERS[kind as PassiveToolKind]
  const Body = renderer?.Body ?? GenericBody
  const bodyProps = {
    view,
    block,
    result,
    expanded,
    hideToolInput,
    theme,
    isError,
    isBackgroundBash,
    isForegroundBashRunning,
    bashOutput,
    bgOutput,
    isPendingApproval,
    approval,
    permissionMode,
    onApproval,
    borderColor,
    statusIcon,
    toolOutputMaxChars
  }

  // Custom-layout kinds (diagram/mockup) render their own full card.
  if (renderer?.layout === 'custom') {
    return Body(bodyProps) ?? <></>
  }

  return (
    <div
      className={`rounded-lg ${borderColor === 'border-border' ? 'border' : 'border-2'} ${borderColor} bg-bg-secondary overflow-hidden`}
    >
      <button
        onClick={() => setExpanded(!expanded)}
        className="w-full flex items-center gap-2 px-3 h-9 text-[13px] hover:bg-bg-hover transition-colors cursor-pointer"
      >
        {statusIcon}
        <span className="font-mono font-medium text-accent">{headerName}</span>
        <span className="text-text-secondary truncate flex-1 text-left font-mono text-[12px]">
          {summary}
        </span>
        {isPendingApproval && (
          <span className="text-[11px] font-semibold text-warning uppercase tracking-wider mr-1">
            Permission
          </span>
        )}
        {isLoaded && <span className="text-[10px] text-text-muted shrink-0">loaded</span>}
        {isForegroundBashRunning && !isBackgrounding && backgroundTasksEnabled && (
          <button
            onClick={(e) => {
              e.stopPropagation()
              onBackgroundTask()
            }}
            className="text-[11px] px-2 py-0.5 rounded bg-accent/10 text-accent hover:bg-accent/20 transition-colors shrink-0"
          >
            Send to background
          </button>
        )}
        {isBackgrounding && (
          <span className="text-[10px] font-mono px-1.5 py-0.5 rounded bg-accent/10 text-accent shrink-0">
            sending to background…
          </span>
        )}
        {bgRunning && !isStopping && !isHistorical && (
          <button
            onClick={(e) => {
              e.stopPropagation()
              onStopTask()
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
          className={`text-text-secondary transition-transform shrink-0 ${expanded ? 'rotate-180' : ''}`}
        >
          <polyline points="6 9 12 15 18 9" />
        </svg>
      </button>

      {expanded && <div className="border-t border-border">{Body(bodyProps)}</div>}

      {expanded && isCommand && (isBackgroundBash || isForegroundBashRunning) && (
        <BackgroundBashOutput toolUseId={toolUseId} />
      )}

      {isPendingApproval && (
        <ApprovalButtons
          approval={approval!}
          permissionMode={permissionMode}
          onApproval={onApproval}
        />
      )}

      {isForegroundBashRunning && bashOutput && !isPendingApproval && (
        <div className="border-t border-border px-3 py-1.5 flex items-center gap-1.5">
          <span className="text-[10px] font-mono px-1.5 py-0.5 rounded bg-accent/10 text-accent">
            streaming
          </span>
          <div className="flex-1" />
          <button
            onClick={() => hasActiveSession && onOpenTaskPanel()}
            className="text-[11px] text-accent hover:underline cursor-pointer"
          >
            Open in panel
          </button>
        </div>
      )}

      {isBackgroundBash && !isPendingApproval && (
        <div className="border-t border-border px-3 py-1.5 flex items-center gap-1.5">
          <span className="text-[10px] font-mono px-1.5 py-0.5 rounded bg-warning/10 text-warning">
            background
          </span>
          <div className="flex-1" />
          <button
            onClick={() => hasActiveSession && onOpenTaskPanel()}
            className="text-[11px] text-accent hover:underline cursor-pointer"
          >
            Open in panel
          </button>
        </div>
      )}
    </div>
  )
}
