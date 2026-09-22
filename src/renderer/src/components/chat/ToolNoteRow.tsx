/**
 * Tool note row — a call whose whole meaning is one sentence.
 *
 * Stopping a background task, loading tool schemas, deleting a schedule, leaving
 * a worktree: a header, a chevron, an expandable body and a result area would be
 * chrome around a single fact. This is the shape `SleepRow` already uses for
 * Codex's `clock.sleep`, generalised — which is also what keeps the harnesses
 * looking like one app.
 *
 * A FAILED call is never a quiet grey line: it promotes itself to the error
 * tone and shows what came back, because a row that reads the same whether it
 * worked or not is worse than no row.
 *
 * Purely presentational: props in, DOM out, no store and no IPC.
 */

import type { ContentBlock } from '../../../../shared/types'
import type { ToolView } from '../../../../shared/tool-kinds'

type ToolUseBlock = Extract<ContentBlock, { type: 'tool_use' }>
type ToolResultBlock = Extract<ContentBlock, { type: 'tool_result' }>
type NoteView = Extract<ToolView, { kind: 'note' }>

interface Props {
  block: ToolUseBlock
  result?: ToolResultBlock
  view: NoteView
  /** The card header's name for this tool, so the row says which tool spoke. */
  displayName?: string
}

/** The glyphs a spec may ask for. Unknown names fall back to the neutral dot. */
const ICONS: Record<string, React.JSX.Element> = {
  search: (
    <>
      <circle cx="11" cy="11" r="7" />
      <line x1="16.5" y1="16.5" x2="21" y2="21" />
    </>
  ),
  stop: <rect x="6" y="6" width="12" height="12" rx="1.5" />,
  bell: (
    <>
      <path d="M18 8a6 6 0 10-12 0c0 7-3 8-3 8h18s-3-1-3-8" />
      <path d="M13.7 21a2 2 0 01-3.4 0" />
    </>
  ),
  trash: (
    <>
      <polyline points="3 6 5 6 21 6" />
      <path d="M19 6l-1 14a2 2 0 01-2 2H8a2 2 0 01-2-2L5 6" />
    </>
  ),
  calendar: (
    <>
      <rect x="3" y="5" width="18" height="16" rx="2" />
      <line x1="3" y1="10" x2="21" y2="10" />
    </>
  ),
  exit: (
    <>
      <path d="M9 21H5a2 2 0 01-2-2V5a2 2 0 012-2h4" />
      <polyline points="16 17 21 12 16 7" />
      <line x1="21" y1="12" x2="9" y2="12" />
    </>
  ),
  file: (
    <>
      <path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z" />
      <polyline points="14 2 14 8 20 8" />
    </>
  )
}

export function ToolNoteRow({ result, view, displayName }: Props): React.JSX.Element {
  const resolved = !!result
  const failed = !!result?.isError
  const glyph = view.icon ? ICONS[view.icon] : undefined

  return (
    <div
      data-testid="ToolNoteRow"
      data-failed={failed || undefined}
      className={`flex items-center gap-2 px-2 min-h-7 py-1 text-[12px] rounded-md ${
        failed ? 'bg-danger/5 text-danger' : 'text-text-secondary bg-bg-secondary/50'
      }`}
    >
      {!resolved ? (
        <span className="w-[11px] h-[11px] rounded-full border-[1.5px] border-text-muted border-t-transparent shrink-0 animate-spin-slow" />
      ) : failed ? (
        <svg
          width="11"
          height="11"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2.5"
          className="shrink-0"
        >
          <line x1="18" y1="6" x2="6" y2="18" />
          <line x1="6" y1="6" x2="18" y2="18" />
        </svg>
      ) : glyph ? (
        <svg
          width="11"
          height="11"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          className="text-text-muted shrink-0"
        >
          {glyph}
        </svg>
      ) : (
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
      )}

      {displayName && (
        <span className="font-mono text-text-muted text-[11px] shrink-0">{displayName}</span>
      )}
      <span data-testid="ToolNoteRow.text" className="truncate">
        {view.text}
      </span>
      {failed && result?.toolResult && (
        <span className="truncate text-[11px] opacity-80">— {result.toolResult}</span>
      )}
    </div>
  )
}
