import { useEffect, useMemo, useState } from 'react'
import { useSessionStore } from '../stores/session-store'
import type { ChatMessage, TeammateInfo } from '../../../shared/types'
import { MarkdownRenderer } from './chat/MarkdownRenderer'

export function TeamsView(): React.JSX.Element {
  const routingId = useMemo(
    () => new URLSearchParams(window.location.search).get('routingId'),
    []
  )

  const [loading, setLoading] = useState(true)

  // Pull initial team state from backend on mount, then load JSONL histories
  useEffect(() => {
    if (!routingId) {
      setLoading(false)
      return
    }
    window.api.getTeamInfo(routingId).then(async (info) => {
      if (!info) {
        setLoading(false)
        return
      }
      const store = useSessionStore.getState()
      if (info.teamName) {
        store.setTeamName(routingId, info.teamName)
      }
      for (const t of info.teammates) {
        store.addTeammate(routingId, t)
      }

      // Load subagent message histories from JSONL files
      if (info.sessionId && info.projectKey && info.teammates.length > 0) {
        const results = await Promise.all(
          info.teammates.map(async (t) => {
            try {
              const msgs = await window.api.loadSubagentHistory(info.sessionId!, info.projectKey!, t.fileId || t.agentId)
              return { toolUseId: t.toolUseId, msgs }
            } catch {
              return { toolUseId: t.toolUseId, msgs: [] as ChatMessage[] }
            }
          })
        )
        const subagentMessages: Record<string, ChatMessage[]> = {}
        for (const { toolUseId, msgs } of results) {
          if (msgs.length > 0) subagentMessages[toolUseId] = msgs
        }
        if (Object.keys(subagentMessages).length > 0) {
          store.bulkSetSubagentMessages(routingId, subagentMessages)
        }
      }
      setLoading(false)
    })
  }, [routingId])

  // Subscribe to the specific session by routingId (push events keep it updated)
  const teamSession = useSessionStore((s) => (routingId ? s.sessions[routingId] : undefined))

  if (loading) {
    return (
      <div className="h-screen flex items-center justify-center bg-bg-primary text-text-muted">
        <p className="text-sm">Loading team info…</p>
      </div>
    )
  }

  if (!routingId || !teamSession?.teamName) {
    return (
      <div className="h-screen flex items-center justify-center bg-bg-primary text-text-muted">
        <div className="text-center">
          <p className="text-lg">No active team</p>
          <p className="text-sm mt-1">Start a team session in the main window</p>
        </div>
      </div>
    )
  }

  const teammateList = Object.values(teamSession.teammates) as TeammateInfo[]

  return (
    <div className="h-screen flex flex-col bg-bg-primary overflow-hidden">
      {/* Header */}
      <div className="shrink-0 h-10 flex items-center px-4 border-b border-border bg-bg-secondary/50">
        <h1 className="text-[13px] text-text-secondary font-medium">
          Agent Monitor — {teamSession.teamName}
        </h1>
        <span className="ml-2 text-[11px] text-text-muted">
          {teammateList.length} agent{teammateList.length !== 1 ? 's' : ''}
        </span>
      </div>

      {/* Grid of agent cards */}
      <div className="flex-1 overflow-auto p-3">
        <div className="grid grid-cols-[repeat(auto-fill,minmax(400px,1fr))] gap-3 auto-rows-[400px]">
          {/* Main agent card */}
          <AgentCard
            name="Main"
            status="running"
            messages={teamSession.messages}
            streamingText={teamSession.streamingText}
          />

          {/* Teammate cards */}
          {teammateList.map((t) => (
            <AgentCard
              key={t.toolUseId}
              name={t.name}
              status={t.status}
              messages={teamSession.subagentMessages[t.toolUseId] || []}
              streamingText={teamSession.subagentStreamingText[t.toolUseId] || ''}
            />
          ))}
        </div>
      </div>
    </div>
  )
}

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

  // Show last few messages
  const recentMessages = messages.slice(-10)

  return (
    <div className="flex flex-col rounded-lg border border-border bg-bg-secondary/30 overflow-hidden">
      {/* Card header */}
      <div className="shrink-0 flex items-center gap-2 px-3 py-2 border-b border-border/50">
        <span className={`w-2 h-2 rounded-full ${statusColor}`} />
        <span className="text-[12px] text-text-primary font-medium truncate">{name}</span>
        <span className="text-[10px] text-text-muted capitalize ml-auto">{status}</span>
      </div>

      {/* Card body — scrollable messages */}
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
  const textBlocks = message.content.filter((b) => b.type === 'text' && b.text)
  const toolBlocks = message.content.filter((b) => b.type === 'tool_use')

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
