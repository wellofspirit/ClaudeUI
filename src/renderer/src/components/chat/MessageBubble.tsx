import type { ChatMessage, ContentBlock, PendingApproval } from '../../../../shared/types'
import { useSessionStore } from '../../stores/session-store'
import { MarkdownRenderer } from './MarkdownRenderer'
import { ToolCallBlock } from './ToolCallBlock'
import { ExitPlanModeCard } from './ExitPlanModeCard'
import { AskUserQuestionBlock } from './AskUserQuestionBlock'
import { ThinkingBlock } from './ThinkingBlock'
import { TodoToolBlock } from './TodoToolBlock'
import { TaskCard } from './TaskCard'

const TODO_TOOLS = new Set(['TodoWrite'])

export function MessageBubble({ message }: { message: ChatMessage }): React.JSX.Element {
  const pendingApprovals = useSessionStore((s) => s.pendingApprovals)
  const messages = useSessionStore((s) => s.messages)
  const thinkingStartedAt = useSessionStore((s) => s.thinkingStartedAt)

  if (message.role === 'user') {
    // User message with planContent: show plan block instead of raw text
    if (message.planContent) {
      const planBlock: ContentBlock = {
        type: 'tool_use',
        toolName: 'ExitPlanMode',
        toolInput: { plan: message.planContent },
        toolUseId: `plan-${message.id}`
      }
      return (
        <div className="animate-fade-in">
          <ExitPlanModeCard block={planBlock} />
        </div>
      )
    }

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

  // Match pending approvals to tool_use blocks by toolName + input
  const approvalMap = new Map<string, PendingApproval>()
  const matchedApprovalIds = new Set<string>()
  for (const block of message.content) {
    if (block.type !== 'tool_use' || !block.toolUseId) continue
    const match = pendingApprovals.find(
      (a) =>
        !matchedApprovalIds.has(a.requestId) &&
        a.toolName === block.toolName &&
        JSON.stringify(a.input) === JSON.stringify(block.toolInput)
    )
    if (match) {
      approvalMap.set(block.toolUseId, match)
      matchedApprovalIds.add(match.requestId)
    }
  }

  // Determine if this is the last assistant message (for active thinking indicator)
  const lastAssistantMsg = [...messages].reverse().find((m) => m.role === 'assistant')
  const isLastAssistant = lastAssistantMsg?.id === message.id

  // Group consecutive tool_use blocks so we can wrap them in a bordered container
  type RenderItem =
    | { kind: 'tool_group'; blocks: { block: ContentBlock; index: number }[] }
    | { kind: 'thinking'; block: ContentBlock; index: number }
    | { kind: 'other'; block: ContentBlock; index: number }
  const items: RenderItem[] = []

  const HIDDEN_TOOLS = new Set(['EnterPlanMode'])
  const visible = message.content.filter(
    (b) => b.type !== 'tool_result' && !(b.type === 'tool_use' && b.toolName && HIDDEN_TOOLS.has(b.toolName))
  )
  for (let i = 0; i < visible.length; i++) {
    const block = visible[i]
    if (block.type === 'tool_use') {
      const last = items[items.length - 1]
      if (last?.kind === 'tool_group') {
        last.blocks.push({ block, index: i })
      } else {
        items.push({ kind: 'tool_group', blocks: [{ block, index: i }] })
      }
    } else if (block.type === 'thinking') {
      items.push({ kind: 'thinking', block, index: i })
    } else {
      items.push({ kind: 'other', block, index: i })
    }
  }

  // Find the last thinking item so only it can be "active"
  const lastThinkingGi = items.reduce(
    (acc, item, i) => (item.kind === 'thinking' ? i : acc),
    -1
  )

  return (
    <div className="flex flex-col gap-2 animate-fade-in">
      {items.map((item, gi) => {
        if (item.kind === 'thinking') {
          const isLast = gi === lastThinkingGi
          // Only hide if this message was updated during the current thinking session
          // (meaning the SDK sent a partial with this thinking block for the active turn)
          const isActive =
            isLast &&
            isLastAssistant &&
            !!thinkingStartedAt &&
            message.timestamp >= thinkingStartedAt
          // Active thinking is rendered by the standalone ThinkingBlock in ChatPanel
          if (isActive) return null
          return (
            <ThinkingBlock
              key={item.index}
              text={item.block.text || ''}
              isActive={false}
            />
          )
        }
        if (item.kind === 'other') {
          return <ContentBlockView key={item.index} block={item.block} />
        }
        // Single tool call — render directly
        if (item.blocks.length === 1) {
          const { block, index } = item.blocks[0]
          const result = block.toolUseId ? resultMap.get(block.toolUseId) : undefined
          const approval = block.toolUseId ? approvalMap.get(block.toolUseId) : undefined
          if (block.toolName === 'ExitPlanMode') {
            return <ExitPlanModeCard key={index} block={block} approval={approval} />
          }
          if (block.toolName === 'AskUserQuestion') {
            return <AskUserQuestionBlock key={index} block={block} result={result} approval={approval} />
          }
          if (block.toolName && TODO_TOOLS.has(block.toolName)) {
            return <TodoToolBlock key={index} block={block} result={result} />
          }
          if (block.toolName === 'Task') {
            return <TaskCard key={index} block={block} result={result} />
          }
          return <ToolCallBlock key={index} block={block} result={result} approval={approval} />
        }
        // Multiple tool calls — wrap in bordered group
        return (
          <div key={`group-${gi}`} className="rounded-xl border border-border p-2 flex flex-col gap-2">
            {item.blocks.map(({ block, index }) => {
              const result = block.toolUseId ? resultMap.get(block.toolUseId) : undefined
              const approval = block.toolUseId ? approvalMap.get(block.toolUseId) : undefined
              if (block.toolName === 'ExitPlanMode') {
                return <ExitPlanModeCard key={index} block={block} approval={approval} />
              }
              if (block.toolName === 'AskUserQuestion') {
                return <AskUserQuestionBlock key={index} block={block} result={result} approval={approval} />
              }
              if (block.toolName && TODO_TOOLS.has(block.toolName)) {
                return <TodoToolBlock key={index} block={block} result={result} />
              }
              if (block.toolName === 'Task') {
                return <TaskCard key={index} block={block} result={result} />
              }
              return <ToolCallBlock key={index} block={block} result={result} approval={approval} />
            })}
          </div>
        )
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

  return null
}
