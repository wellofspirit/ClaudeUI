/**
 * Pure business logic for ToolCallBlock — visual state machine and display helpers.
 */

import type { ContentBlock } from '../../../../../shared/types'
import { isAgentTool } from '../../../../../shared/types'

type ToolUseBlock = Extract<ContentBlock, { type: 'tool_use' }>

export type ToolVisualState = 'pending' | 'error' | 'running' | 'success' | 'loaded' | 'idle'

export interface ToolStateContext {
  toolName: string
  hasResult: boolean
  isHistorical: boolean
  hasApproval: boolean
  isBackgroundBash: boolean
  bgNotificationStatus: 'completed' | 'failed' | 'stopped' | null
  resultIsError: boolean
}

/**
 * Derive the visual state of a tool call from its execution state.
 * Determines border color and status icon.
 */
export function resolveToolVisualState(ctx: ToolStateContext): ToolVisualState {
  const isPendingApproval = !ctx.isHistorical && ctx.hasApproval

  if (isPendingApproval) return 'pending'

  // Error determination depends on tool type
  const isError = ctx.isBackgroundBash
    ? ctx.bgNotificationStatus === 'failed'
    : ctx.resultIsError

  if (isError) return 'error'

  // Running: foreground bash or background bash without notification
  const bgRunning = ctx.isBackgroundBash && ctx.bgNotificationStatus === null && !ctx.isHistorical
  const isForegroundBashRunning = ctx.toolName === 'Bash' && !ctx.isBackgroundBash && !ctx.hasResult && !isPendingApproval && !ctx.isHistorical

  if (bgRunning || isForegroundBashRunning) return 'running'

  // Success
  const isSuccess = ctx.isBackgroundBash
    ? (ctx.bgNotificationStatus !== null && ctx.bgNotificationStatus !== 'failed')
    : (ctx.hasResult && !isError)

  if (isSuccess) return 'success'

  // Historical mode: tools without results show neutral
  if (ctx.isHistorical && !ctx.hasResult) return 'loaded'

  return 'idle'
}

export const TOOL_BORDER_CLASSES: Record<ToolVisualState, string> = {
  pending: 'border-warning/40',
  error: 'border-danger/30',
  running: 'border-accent/30',
  success: 'border-success/30',
  loaded: 'border-border',
  idle: 'border-border',
}

// ---------------------------------------------------------------------------
// Display helpers
// ---------------------------------------------------------------------------

export function shorten(path: string): string {
  const parts = path.split('/')
  return parts.length <= 3 ? path : '.../' + parts.slice(-2).join('/')
}

export function trunc(s: string, n: number): string {
  return s.length > n ? s.slice(0, n) + '...' : s
}

export function getSummary(block: ToolUseBlock): string {
  const input = block.toolInput
  if (!input) return ''

  if (block.toolName === 'Read' && input.file_path) return shorten(String(input.file_path))
  if (block.toolName === 'Write' && input.file_path) return shorten(String(input.file_path))
  if (block.toolName === 'Edit' && input.file_path) return shorten(String(input.file_path))
  if (block.toolName === 'Bash' && input.command) return String(input.command)
  if (block.toolName === 'Glob' && input.pattern) return String(input.pattern)
  if (block.toolName === 'Grep' && input.pattern) return String(input.pattern)
  if (block.toolName === 'AskUserQuestion' && Array.isArray(input.questions)) {
    const n = input.questions.length
    return `${n} question${n !== 1 ? 's' : ''}`
  }
  if (block.toolName === 'TodoWrite' && Array.isArray(input.todos)) {
    const completed = input.todos.filter((t: Record<string, unknown>) => t.status === 'completed').length
    return `${completed}/${input.todos.length} tasks`
  }
  if (block.toolName === 'mcp__claude-ui__render_mermaid') {
    return input.title ? String(input.title) : 'diagram'
  }
  if (isAgentTool(block.toolName) && input.description) return String(input.description)
  if (block.toolName === 'TaskOutput' && input.task_id) return `task ${String(input.task_id).slice(0, 8)}…`
  if (block.toolName === 'TaskStop' && input.task_id) return `stop ${String(input.task_id).slice(0, 8)}…`

  return JSON.stringify(input)
}
