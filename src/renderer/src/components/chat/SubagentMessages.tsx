import { memo, useMemo, useState } from 'react'
import type { ChatMessage, ContentBlock } from '../../../../shared/types'
import { useSessionStore } from '../../stores/session-store'
import { MarkdownRenderer } from './MarkdownRenderer'
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

  return (
    <div data-testid="SubagentMessages" className="flex flex-col gap-2 overflow-y-auto" style={{ maxHeight }}>
      {messages.map((msg) => (
        <div key={msg.id} data-testid="SubagentMessage" data-id={msg.id} className="flex flex-col gap-1.5">
          {msg.content.map((block, i) => {
            if (block.type === 'tool_result') return null
            if (block.type === 'tool_use') {
              return (
                <ToolCallBlock
                  key={`${msg.id}-${i}`}
                  block={block}
                  result={resultMap.get(block.toolUseId)}
                />
              )
            }
            return <ContentBlockView key={`${msg.id}-${i}`} block={block} />
          })}
        </div>
      ))}
    </div>
  )
})
