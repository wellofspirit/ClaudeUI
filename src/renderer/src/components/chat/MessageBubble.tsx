import type { ChatMessage, ContentBlock } from '../../../../shared/types'
import { MarkdownRenderer } from './MarkdownRenderer'
import { ToolCallBlock } from './ToolCallBlock'

export function MessageBubble({ message }: { message: ChatMessage }): React.JSX.Element {
  if (message.role === 'user') {
    return (
      <div className="flex justify-end animate-fade-in">
        <div className="max-w-[85%] bg-bg-tertiary rounded-2xl px-4 py-2.5 text-[13px] text-text-primary leading-[1.6] whitespace-pre-wrap">
          {message.content.map((block, i) => (
            <span key={i}>{block.text}</span>
          ))}
        </div>
      </div>
    )
  }

  // Pair tool_use blocks with their tool_result
  const resultMap = new Map<string, ContentBlock>()
  for (const block of message.content) {
    if (block.type === 'tool_result' && block.toolUseId) {
      resultMap.set(block.toolUseId, block)
    }
  }

  return (
    <div className="flex flex-col gap-2 animate-fade-in">
      {message.content.map((block, i) => {
        if (block.type === 'tool_result') return null
        if (block.type === 'tool_use') {
          const result = block.toolUseId ? resultMap.get(block.toolUseId) : undefined
          return <ToolCallBlock key={i} block={block} result={result} />
        }
        return <ContentBlockView key={i} block={block} />
      })}
    </div>
  )
}

function ContentBlockView({ block }: { block: ContentBlock }): React.JSX.Element | null {
  if (block.type === 'text' && block.text) {
    return (
      <div className="text-[13px] text-text-primary leading-[1.6]">
        <MarkdownRenderer content={block.text} />
      </div>
    )
  }

  if (block.type === 'thinking' && block.text) {
    return (
      <details className="group">
        <summary className="text-[11px] text-text-muted cursor-pointer select-none hover:text-text-secondary transition-colors flex items-center gap-1">
          <span className="italic">Thinking</span>
          <svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="transition-transform group-open:rotate-90"><polyline points="9 18 15 12 9 6" /></svg>
        </summary>
        <div className="mt-1 pl-3 border-l border-border text-[11px] text-text-muted leading-[1.5] whitespace-pre-wrap max-h-40 overflow-y-auto">
          {block.text}
        </div>
      </details>
    )
  }

  return null
}
