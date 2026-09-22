/**
 * Injected-context row — Codex `hookPrompt` fragments today; pi
 * `custom_message` entries, and (later) Claude's `attachment` family, reuse it.
 *
 * Context the ENGINE put into the model's prompt that the user never typed. The
 * rule the survey set is "context the model saw is visible": it is in the
 * transcript, collapsed to a count so it does not crowd the conversation, and
 * expandable to the fragments themselves.
 *
 * SECURITY. A fragment is third-party text — a hook is an arbitrary script, and
 * pi's custom messages come from extensions. It is rendered VERBATIM and
 * pre-wrapped, never through the markdown pipeline, exactly like the guardian
 * rows beside it.
 *
 * Purely presentational (component guide): no store, no IPC, so no FC/View split.
 */

import { useState } from 'react'
import type { ContentBlock } from '../../../../shared/types'

type ContextNote = Extract<ContentBlock, { type: 'context_note' }>

export function ContextNoteBlock({ block }: { block: ContextNote }): React.JSX.Element {
  const [expanded, setExpanded] = useState(false)
  const count = block.fragments.length

  return (
    <div
      data-testid="ContextNoteBlock"
      className="rounded-lg border border-border bg-bg-secondary/40 overflow-hidden"
    >
      <button
        data-testid="ContextNoteBlock.toggle"
        onClick={() => setExpanded((prev) => !prev)}
        className="w-full flex items-center gap-2 px-3 h-8 text-[12px] hover:bg-bg-hover transition-colors cursor-pointer text-left"
      >
        <svg
          width="11"
          height="11"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          className="text-text-muted shrink-0"
        >
          <path d="M4 19.5A2.5 2.5 0 016.5 17H20" />
          <path d="M6.5 2H20v20H6.5A2.5 2.5 0 014 19.5v-15A2.5 2.5 0 016.5 2z" />
        </svg>
        <span className="font-mono text-text-secondary">{block.title}</span>
        <span className="text-text-muted text-[11px]">
          {count === 1 ? '1 fragment' : `${count} fragments`}
        </span>
        <span className="flex-1" />
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
      {expanded && (
        <div className="border-t border-border px-3 py-2 flex flex-col gap-2">
          {block.fragments.map((fragment, index) => (
            <div key={index} data-testid="ContextNoteBlock.fragment" data-id={String(index)}>
              <div className="text-[12px] text-text-secondary leading-[1.6] whitespace-pre-wrap break-words">
                {fragment.text}
              </div>
              {fragment.label && (
                <div className="text-[10px] text-text-muted font-mono mt-0.5">{fragment.label}</div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
