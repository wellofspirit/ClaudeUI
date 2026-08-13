/**
 * diagram kind body (custom layout) — mcp__claude-ui__render_mermaid + opencode
 * render_mermaid. Engine-independent: renders the same card regardless of which
 * engine produced the tool call.
 *
 * Moved verbatim from ToolCallBlock/View.tsx's mermaid special-case card: custom
 * header (diagram icon + title + validation-failed badge), an always-visible
 * MermaidDiagram body, and the shared <ApprovalButtons> (no suggestions — same as
 * the old inline buttons).
 *
 * The one thing it adds is `block.toolUseId`, which is how the diagram gallery
 * identifies this card's diagram among the session's.
 */

import { MermaidDiagram } from '../../MermaidDiagram'
import { ApprovalButtons } from '../../ApprovalButtons'
import type { KindBodyProps } from './types'

export function DiagramBody({
  view,
  block,
  result,
  isPendingApproval,
  approval,
  permissionMode,
  onApproval,
  borderColor,
  statusIcon
}: KindBodyProps): React.JSX.Element | null {
  if (view.kind !== 'diagram') return null
  const title = view.title

  return (
    <div
      data-testid="DiagramBody"
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
          <rect x="3" y="3" width="7" height="7" rx="1" />
          <rect x="14" y="3" width="7" height="7" rx="1" />
          <rect x="8.5" y="14" width="7" height="7" rx="1" />
          <line x1="6.5" y1="10" x2="6.5" y2="14" />
          <line x1="17.5" y1="10" x2="17.5" y2="14" />
          <line x1="6.5" y1="14" x2="12" y2="14" />
          <line x1="17.5" y1="14" x2="12" y2="14" />
        </svg>
        <span className="font-medium text-text-primary">{title || 'Mermaid Diagram'}</span>
        <div className="flex-1" />
        {result?.isError && <span className="text-[11px] text-danger">Validation failed</span>}
      </div>
      <div className="border-t border-border px-3 py-2.5">
        {/* toolUseId is the gallery's key: it lets the card open the session-wide
            diagram gallery at ITS diagram instead of a local single-entry viewer. */}
        <MermaidDiagram source={view.source} title={title} toolUseId={block.toolUseId} />
      </div>
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
