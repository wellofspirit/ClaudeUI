import type { ChatMessage, ContentBlock, TeammateInfo } from '../../../../shared/types'
import { MarkdownRenderer } from '../chat/MarkdownRenderer'

// ── View props ──────────────────────────────────────────────────────

export interface TeamsViewViewProps {
  loading: boolean
  teamName: string | undefined
  teammateList: TeammateInfo[]
  messages: ChatMessage[]
  streamingText: string
  subagentMessages: Record<string, ChatMessage[]>
  subagentStreamingText: Record<string, string>
}

export function TeamsViewView({
  loading,
  teamName,
  teammateList,
  messages,
  streamingText,
  subagentMessages,
  subagentStreamingText
}: TeamsViewViewProps): React.JSX.Element {
  if (loading) {
    return (
      <div className="h-screen flex items-center justify-center bg-bg-primary text-text-muted">
        <p className="text-sm">Loading team info…</p>
      </div>
    )
  }

  if (!teamName) {
    return (
      <div className="h-screen flex items-center justify-center bg-bg-primary text-text-muted">
        <div className="text-center">
          <p className="text-lg">No active team</p>
          <p className="text-sm mt-1">Start a team session in the main window</p>
        </div>
      </div>
    )
  }

  return (
    <div className="h-screen flex flex-col bg-bg-primary overflow-hidden">
      <div className="shrink-0 h-10 flex items-center px-4 border-b border-border bg-bg-secondary/50">
        <h1 className="text-[13px] text-text-secondary font-medium">
          Agent Monitor — {teamName}
        </h1>
        <span className="ml-2 text-[11px] text-text-muted">
          {teammateList.length} agent{teammateList.length !== 1 ? 's' : ''}
        </span>
      </div>

      <div className="flex-1 overflow-auto p-3">
        <div className="grid grid-cols-[repeat(auto-fill,minmax(400px,1fr))] gap-3 auto-rows-[400px]">
          <AgentCard
            name="Main"
            status="running"
            messages={messages}
            streamingText={streamingText}
          />
          {teammateList.map((t) => (
            <AgentCard
              key={t.toolUseId}
              name={t.name}
              status={t.status}
              messages={subagentMessages[t.toolUseId] || []}
              streamingText={subagentStreamingText[t.toolUseId] || ''}
            />
          ))}
        </div>
      </div>
    </div>
  )
}

// ── Sub-components ──────────────────────────────────────────────────

function AgentCard({
  name,
  status,
  messages,
  streamingText
}: {
  name: string
  status: TeammateInfo['status']
  messages: ChatMessage[]
  streamingText: string
}): React.JSX.Element {
  const statusColor = status === 'running' ? 'bg-green-400' : 'bg-text-muted/50'
  const recentMessages = messages.slice(-10)

  return (
    <div className="flex flex-col rounded-lg border border-border bg-bg-secondary/30 overflow-hidden">
      <div className="shrink-0 flex items-center gap-2 px-3 py-2 border-b border-border/50">
        <span className={`w-2 h-2 rounded-full ${statusColor}`} />
        <span className="text-[12px] text-text-primary font-medium truncate">{name}</span>
        <span className="text-[10px] text-text-muted capitalize ml-auto">{status}</span>
      </div>

      <div className="flex-1 overflow-y-auto p-2 space-y-1.5 text-[11px]">
        {recentMessages.map((msg) => (
          <MessageLine key={msg.id} message={msg} />
        ))}
        {streamingText && (
          <div className="text-text-primary opacity-80 leading-relaxed">
            <MarkdownRenderer content={streamingText} />
          </div>
        )}
        {recentMessages.length === 0 && !streamingText && (
          <div className="text-text-muted italic text-center pt-4">No messages yet</div>
        )}
      </div>
    </div>
  )
}

function MessageLine({ message }: { message: ChatMessage }): React.JSX.Element {
  const isUser = message.role === 'user'
  const textBlocks = message.content.filter((b): b is Extract<ContentBlock, { type: 'text' }> => b.type === 'text' && !!b.text)
  const toolBlocks = message.content.filter((b): b is Extract<ContentBlock, { type: 'tool_use' }> => b.type === 'tool_use')

  return (
    <div className={`leading-relaxed ${isUser ? 'text-accent' : 'text-text-primary'}`}>
      {textBlocks.map((b, i) => (
        <div key={i} className="whitespace-pre-wrap break-words line-clamp-4">
          {b.text}
        </div>
      ))}
      {toolBlocks.map((b, i) => (
        <div key={`tool-${i}`} className="text-text-muted text-[10px] italic">
          {b.toolName}
        </div>
      ))}
    </div>
  )
}
