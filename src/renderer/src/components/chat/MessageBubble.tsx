import { memo, useState } from 'react'
import type { ChatMessage, ContentBlock, PendingApproval } from '../../../../shared/types'
import { MarkdownRenderer } from './MarkdownRenderer'
import { ToolCallBlock } from './ToolCallBlock'
import { ExitPlanModeCard } from './ExitPlanModeCard'
import { AskUserQuestionBlock } from './AskUserQuestionBlock'
import { ThinkingBlock } from './ThinkingBlock'
import { TodoToolBlock } from './TodoToolBlock'
import { TaskCard } from './TaskCard'

const TODO_TOOLS = new Set(['TodoWrite'])
const HIDDEN_TOOLS = new Set(['EnterPlanMode', 'TaskCreate', 'TaskUpdate', 'TaskList', 'TaskGet'])

interface MessageBubbleProps {
  message: ChatMessage
  pendingApprovals: PendingApproval[]
  isLastAssistant: boolean
  thinkingStartedAt: number | null
}

export const MessageBubble = memo(function MessageBubble({
  message,
  pendingApprovals,
  isLastAssistant,
  thinkingStartedAt
}: MessageBubbleProps): React.JSX.Element {
  // System messages (compact separators, CLI commands, API errors)
  if (message.role === 'system') {
    return (
      <div className="flex flex-col gap-2 animate-fade-in">
        {message.content.map((block, i) => {
          if (block.type === 'compact_separator') {
            return <CompactSeparator key={i} summary={block.text} />
          }
          if (block.type === 'cli_command') {
            return <CliCommandBlock key={i} block={block} />
          }
          if (block.type === 'api_error') {
            return <ApiErrorBlock key={i} block={block} />
          }
          return null
        })}
      </div>
    )
  }

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

    const imageBlocks = message.content.filter((b) => b.type === 'image')
    const docBlocks = message.content.filter((b) => b.type === 'document')
    const textBlocks = message.content.filter((b) => b.type === 'text')
    const hasAttachments = imageBlocks.length > 0 || docBlocks.length > 0

    return (
      <div className="flex justify-end animate-fade-in">
        <div className="max-w-[85%] bg-bg-tertiary rounded-2xl px-4 py-2.5 text-[13px] text-text-primary leading-[1.6]">
          {hasAttachments && (
            <div className="flex gap-2 flex-wrap mb-2">
              {imageBlocks.map((block, i) => (
                <img
                  key={`img-${i}`}
                  src={`data:${block.mediaType};base64,${block.base64Data}`}
                  alt="Attached"
                  className="max-w-[200px] max-h-[200px] rounded-lg object-contain"
                />
              ))}
              {docBlocks.map((block, i) => (
                <div key={`doc-${i}`} className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg border border-border bg-bg-hover">
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" className="text-red-400 shrink-0">
                    <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
                    <polyline points="14 2 14 8 20 8" />
                  </svg>
                  <span className="text-[11px] text-text-secondary">{block.fileName || 'Document'}</span>
                </div>
              ))}
            </div>
          )}
          {textBlocks.map((block, i) => (
            <span key={i} className="whitespace-pre-wrap">{block.text}</span>
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

  // Group consecutive tool_use blocks so we can wrap them in a bordered container
  type RenderItem =
    | { kind: 'tool_group'; blocks: { block: ContentBlock; index: number }[] }
    | { kind: 'thinking'; block: ContentBlock; index: number }
    | { kind: 'other'; block: ContentBlock; index: number }
  const items: RenderItem[] = []

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
})

const ContentBlockView = memo(function ContentBlockView({ block }: { block: ContentBlock }): React.JSX.Element | null {
  if (block.type === 'text' && block.text) {
    return (
      <div className="text-[13px] text-text-primary leading-[1.6]">
        <MarkdownRenderer content={block.text} />
      </div>
    )
  }

  return null
})

function CompactSeparator({ summary }: { summary?: string }): React.JSX.Element {
  const [expanded, setExpanded] = useState(false)
  const hasSummary = !!summary?.trim()

  if (!hasSummary) {
    return (
      <div className="flex items-center gap-3 py-1">
        <div className="flex-1 h-px bg-border" />
        <span className="text-[11px] text-text-muted font-mono">compacted</span>
        <div className="flex-1 h-px bg-border" />
      </div>
    )
  }

  return (
    <div className="rounded-lg border border-warning/30 bg-bg-secondary overflow-hidden">
      <button
        onClick={() => setExpanded(!expanded)}
        className="w-full flex items-center gap-2 px-3 h-9 text-[13px] bg-warning/5 hover:bg-warning/10 transition-colors cursor-pointer"
      >
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="text-warning shrink-0">
          <path d="M21 15a2 2 0 01-2 2H7l-4 4V5a2 2 0 012-2h14a2 2 0 012 2z" />
        </svg>
        <span className="font-mono font-medium text-warning">Compacted</span>
        <span className="text-text-secondary text-[12px] truncate flex-1 text-left">Context summary</span>
        <svg
          width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
          className={`text-text-secondary transition-transform shrink-0 ${expanded ? 'rotate-180' : ''}`}
        >
          <polyline points="6 9 12 15 18 9" />
        </svg>
      </button>
      {expanded && (
        <div className="border-t border-border px-3 py-2.5">
          <div className="text-[12px] leading-[1.6] max-h-80 overflow-y-auto">
            <MarkdownRenderer content={summary!} />
          </div>
        </div>
      )}
    </div>
  )
}

function CliCommandBlock({ block }: { block: ContentBlock }): React.JSX.Element {
  const name = block.commandName || ''
  const args = block.commandArgs || ''
  const output = block.commandOutput || ''

  // "output" type is just stdout/stderr from a previous command — show inline
  if (name === 'output') {
    if (!output) return <></>
    return (
      <div className="flex justify-end">
        <div className="max-w-[85%] bg-bg-tertiary rounded-2xl px-4 py-2.5 text-[13px] text-text-primary leading-[1.6]">
          <pre className="font-mono text-[12px] text-text-primary/70 whitespace-pre-wrap break-words">{output}</pre>
        </div>
      </div>
    )
  }

  // Command execution — show as user bubble with code block
  const display = args ? `/${name} ${args}` : `/${name}`
  return (
    <div className="flex justify-end">
      <div className="max-w-[85%] bg-bg-tertiary rounded-2xl px-4 py-2.5 text-[13px] text-text-primary leading-[1.6]">
        <pre className="font-mono text-[12px] text-accent whitespace-pre-wrap break-words">{display}</pre>
      </div>
    </div>
  )
}

function ApiErrorBlock({ block }: { block: ContentBlock }): React.JSX.Element {
  const [expanded, setExpanded] = useState(false)
  const errorType = block.errorType || 'unknown'
  const errorMessage = block.errorMessage || ''

  const label = errorType === 'rate_limit'
    ? 'Rate Limited'
    : errorType === 'invalid_request'
      ? 'Invalid Request'
      : errorType.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase())

  return (
    <div className="rounded-lg border border-danger/30 bg-bg-secondary overflow-hidden">
      <button
        onClick={() => setExpanded(!expanded)}
        className="w-full flex items-center gap-2 px-3 h-9 text-[13px] hover:bg-bg-hover transition-colors cursor-pointer"
      >
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="text-danger shrink-0">
          <circle cx="12" cy="12" r="10" />
          <line x1="15" y1="9" x2="9" y2="15" />
          <line x1="9" y1="9" x2="15" y2="15" />
        </svg>
        <span className="font-medium text-danger">API Error</span>
        <span className="text-text-secondary truncate flex-1 text-left text-[12px]">{label}</span>
        <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className={`text-text-secondary transition-transform shrink-0 ${expanded ? 'rotate-180' : ''}`}>
          <polyline points="6 9 12 15 18 9" />
        </svg>
      </button>
      {expanded && errorMessage && (
        <div className="border-t border-border px-3 py-2.5">
          <pre className="text-[12px] font-mono text-danger/80 whitespace-pre-wrap break-words max-h-32 overflow-y-auto leading-[1.5]">
            {errorMessage}
          </pre>
        </div>
      )}
    </div>
  )
}
