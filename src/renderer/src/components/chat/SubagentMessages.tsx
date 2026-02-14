import { memo } from 'react'
import type { ChatMessage, ContentBlock } from '../../../../shared/types'
import { MarkdownRenderer } from './MarkdownRenderer'
import { ToolCallBlock } from './ToolCallBlock'

interface Props {
  messages: ChatMessage[]
  maxHeight?: string
}

function ThinkingBlock({ text }: { text: string }): React.JSX.Element {
  return (
    <details className="group">
      <summary className="text-[11px] text-text-muted italic cursor-pointer hover:text-text-secondary select-none">
        Thinking...
      </summary>
      <div className="mt-1 text-[12px] text-text-secondary/60 italic max-h-40 overflow-y-auto">
        {text}
      </div>
    </details>
  )
}

const ContentBlockView = memo(function ContentBlockView({ block }: { block: ContentBlock }): React.JSX.Element | null {
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

export const SubagentMessages = memo(function SubagentMessages({ messages, maxHeight = '400px' }: Props): React.JSX.Element {
  return (
    <div className="flex flex-col gap-2 overflow-y-auto" style={{ maxHeight }}>
      {messages.map((msg) => {
        // Build a result map for tool_use → tool_result pairing
        const resultMap = new Map<string, ContentBlock>()
        for (const b of msg.content) {
          if (b.type === 'tool_result' && b.toolUseId) {
            resultMap.set(b.toolUseId, b)
          }
        }

        return (
          <div key={msg.id} className="flex flex-col gap-1.5">
            {msg.content.map((block, i) => {
              if (block.type === 'tool_result') return null
              if (block.type === 'tool_use') {
                return (
                  <ToolCallBlock
                    key={`${msg.id}-${i}`}
                    block={block}
                    result={resultMap.get(block.toolUseId!)}
                  />
                )
              }
              return <ContentBlockView key={`${msg.id}-${i}`} block={block} />
            })}
          </div>
        )
      })}
    </div>
  )
})
