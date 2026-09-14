import { memo, useMemo, useState } from 'react'
import type { ChatMessage, ContentBlock, PendingApproval } from '../../../../shared/types'
import { useSessionStore, useActiveSession } from '../../stores/session-store'
import { MarkdownRenderer } from './MarkdownRenderer'
import { ImageGalleryProvider } from '../shared/ImageViewer'
import { DiagramGalleryProvider } from './DiagramGallery'
import { ToolCallBlock } from './ToolCallBlock'

interface Props {
  messages: ChatMessage[]
  maxHeight?: string
}

// Seeded once from settings.expandThinking (same semantics as
// chat/ThinkingBlock.tsx) — the user can still toggle this individual block
// afterwards; it just no longer ignores the global default.
function ThinkingBlock({ text }: { text: string }): React.JSX.Element {
  const expandThinking = useSessionStore((s) => s.settings.expandThinking)
  const [expanded, setExpanded] = useState(expandThinking)

  return (
    <div>
      <button
        type="button"
        data-testid="SubagentMessages.thinkingToggle"
        onClick={() => setExpanded(!expanded)}
        className="text-[11px] text-text-muted italic cursor-pointer hover:text-text-secondary select-none"
      >
        Thinking...
      </button>
      {expanded && (
        <div className="mt-1 text-[12px] text-text-secondary/60 italic max-h-40 overflow-y-auto whitespace-pre-wrap">
          {text}
        </div>
      )}
    </div>
  )
}

const ContentBlockView = memo(function ContentBlockView({
  block
}: {
  block: ContentBlock
}): React.JSX.Element | null {
  if (block.type === 'text' && block.text) {
    return (
      <div className="text-[12px] text-text-primary/80 leading-[1.6]">
        <MarkdownRenderer content={block.text} />
      </div>
    )
  }
  if (block.type === 'thinking' && block.text) {
    return <ThinkingBlock text={block.text} />
  }
  return null
})

export const SubagentMessages = memo(function SubagentMessages({
  messages,
  maxHeight = '400px'
}: Props): React.JSX.Element {
  const resultMap = useMemo(() => {
    const map = new Map<string, Extract<ContentBlock, { type: 'tool_result' }>>()
    for (const msg of messages) {
      for (const b of msg.content) {
        if (b.type === 'tool_result') {
          map.set(b.toolUseId, b)
        }
      }
    }
    return map
  }, [messages])

  // Bind the session's pending approvals to the NESTED tool calls, by
  // toolUseId, exactly as MessageBubble does for the top-level transcript.
  //
  // An approval raised inside a nested agent carries that agent's OWN inner
  // tool-call id — a Codex child item id (`CodexSession.requestApproval`), a
  // dispatched Claude target's `opts.toolUseId`, a pi target's
  // `payload.toolCallId` (`CrossEngineDispatcher.gatePiTargetToolCall`), an
  // opencode child's `tool.callID` — which is the same id the nested `tool_use`
  // block carries. So the match is the id and nothing else: MessageBubble's
  // legacy (toolName + input) fallback is deliberately NOT mirrored here, since
  // an id-less approval cannot be attributed to a nested transcript at all
  // (both surfaces would show it, on every subagent card at once). Those still
  // float, which is where they have always been answered.
  //
  // The approvals come from the store rather than a prop because this
  // component's callers (TaskCard, TaskEntry) render subagent output for the
  // ACTIVE session and thread no approval state of their own.
  const pendingApprovals = useActiveSession((s) => s.pendingApprovals)
  const approvalMap = useMemo(() => {
    const map = new Map<string, PendingApproval>()
    if (pendingApprovals.length === 0) return map
    for (const msg of messages) {
      for (const b of msg.content) {
        if (b.type !== 'tool_use' || !b.toolUseId) continue
        const match = pendingApprovals.find((a) => a.toolUseId && a.toolUseId === b.toolUseId)
        if (match) map.set(b.toolUseId, match)
      }
    }
    return map
  }, [messages, pendingApprovals])

  return (
    <div
      data-testid="SubagentMessages"
      className="flex flex-col gap-2 overflow-y-auto"
      style={{ maxHeight }}
    >
      {/* Its OWN galleries, scoped to the subagent's messages. A subagent's tool
          results live in `subagentMessages`, outside the chat providers' message
          list, so without these the image thumbnails inside these cards would
          render as clickable-but-dead (openToolResult finds no entry) and a
          diagram card would fall back to its single-entry overlay. Nesting
          shadows the outer providers only within this list, which is exactly the
          scoping we want: paging a subagent's images or diagrams shouldn't walk
          into the parent transcript's. Both render fragments — no extra wrapper
          element. */}
      <ImageGalleryProvider messages={messages}>
        <DiagramGalleryProvider messages={messages}>
          {messages.map((msg) => (
            <div
              key={msg.id}
              data-testid="SubagentMessage"
              data-id={msg.id}
              className="flex flex-col gap-1.5"
            >
              {msg.content.map((block, i) => {
                if (block.type === 'tool_result') return null
                if (block.type === 'tool_use') {
                  return (
                    <ToolCallBlock
                      key={`${msg.id}-${i}`}
                      block={block}
                      result={resultMap.get(block.toolUseId)}
                      approval={approvalMap.get(block.toolUseId)}
                    />
                  )
                }
                return <ContentBlockView key={`${msg.id}-${i}`} block={block} />
              })}
            </div>
          ))}
        </DiagramGalleryProvider>
      </ImageGalleryProvider>
    </div>
  )
})
