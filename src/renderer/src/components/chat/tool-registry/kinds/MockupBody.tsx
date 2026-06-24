/**
 * mockup kind body (custom layout) — mcp__claude-ui-mockup__* + opencode
 * create_mockup/show_mockup. Engine-independent.
 *
 * Moved verbatim from ToolCallBlock/View.tsx's mockup special-case card: custom
 * header (mockup icon + title + failed badge), the MockupPreviewCard (when a
 * directory resolved and no error), the inline error text, and the shared
 * <ApprovalButtons>.
 */

import { MockupPreviewCard } from '../../MockupPreviewCard'
import { ApprovalButtons } from '../../ApprovalButtons'
import type { KindBodyProps } from './types'

export function MockupBody({
  view,
  result,
  isPendingApproval,
  approval,
  permissionMode,
  onApproval,
  borderColor,
  statusIcon
}: KindBodyProps): React.JSX.Element | null {
  if (view.kind !== 'mockup') return null
  const title = view.title
  const directory = view.directory

  return (
    <div
      className={`rounded-lg ${borderColor === 'border-border' ? 'border' : 'border-2'} ${borderColor} bg-bg-secondary overflow-hidden`}
    >
      <div className="flex items-center gap-2 px-3 h-9 text-[13px]">
        {statusIcon}
        <svg
          width="14"
          height="14"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.8"
          className="text-accent shrink-0"
        >
          <rect x="3" y="3" width="18" height="18" rx="2" />
          <line x1="3" y1="9" x2="21" y2="9" />
          <line x1="9" y1="9" x2="9" y2="21" />
        </svg>
        <span className="font-medium text-text-primary">{title || 'UI Mockup'}</span>
        <div className="flex-1" />
        {result?.isError && <span className="text-[11px] text-danger">Failed</span>}
      </div>
      {directory && !result?.isError && (
        <div className="border-t border-border px-3 py-2.5">
          <MockupPreviewCard directory={directory} title={title} />
        </div>
      )}
      {result?.isError && result.toolResult && (
        <div className="border-t border-border px-3 py-2 text-[12px] text-danger whitespace-pre-wrap">
          {result.toolResult}
        </div>
      )}
      {isPendingApproval && approval && (
        <ApprovalButtons
          approval={approval}
          permissionMode={permissionMode}
          onApproval={onApproval}
          showSuggestions={false}
        />
      )}
    </div>
  )
}
