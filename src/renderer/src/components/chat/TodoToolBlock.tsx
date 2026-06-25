import type { ContentBlock } from '../../../../shared/types'
import type { ToolView } from '../../../../shared/tool-kinds'

type ToolUseBlock = Extract<ContentBlock, { type: 'tool_use' }>
type ToolResultBlock = Extract<ContentBlock, { type: 'tool_result' }>
type TodoView = Extract<ToolView, { kind: 'todo' }>

interface Props {
  block: ToolUseBlock
  result?: ToolResultBlock
  view: TodoView
}

export function TodoToolBlock({ result, view }: Props): React.JSX.Element {
  const hasResult = !!result
  const isError = result?.isError ?? false

  const statusIcon = isError ? (
    <svg
      width="11"
      height="11"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.5"
      className="text-danger shrink-0"
    >
      <line x1="18" y1="6" x2="6" y2="18" />
      <line x1="6" y1="6" x2="18" y2="18" />
    </svg>
  ) : hasResult ? (
    <svg
      width="11"
      height="11"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.5"
      className="text-success shrink-0"
    >
      <polyline points="4 12 10 18 20 6" />
    </svg>
  ) : (
    <span className="w-[11px] h-[11px] rounded-full border-[1.5px] border-text-muted border-t-transparent shrink-0 animate-spin-slow" />
  )

  // Summarize: count of todos by status from the engine-neutral view
  const items = view.items
  const total = items.length
  const completed = items.filter((t) => t.status === 'completed').length
  const cancelled = items.filter((t) => t.status === 'cancelled').length
  // Cancelled items are excluded from active count (they're done/abandoned)
  const activeDenominator = total - cancelled
  const summary =
    total > 0
      ? cancelled > 0 && activeDenominator > 0
        ? `${completed}/${activeDenominator} tasks (${cancelled} cancelled)`
        : `${completed}/${total} tasks`
      : 'update tasks'

  return (
    <div className="flex items-center gap-2 px-2 h-7 text-[12px] text-text-secondary rounded-md bg-bg-secondary/50">
      {statusIcon}
      <span className="font-mono text-text-muted text-[11px]">TodoWrite</span>
      <span className="truncate">{summary}</span>
    </div>
  )
}
