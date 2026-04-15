import { useEffect, useMemo, useState } from 'react'
import { useSessionStore } from '../../stores/session-store'
import type { ChatMessage, TeammateInfo } from '../../../../shared/types'
import { TeamsViewView } from './View'

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

  const teamSession = useSessionStore((s) => (routingId ? s.sessions[routingId] : undefined))
  const teammateList = teamSession ? Object.values(teamSession.teammates) as TeammateInfo[] : []

  return (
    <TeamsViewView
      loading={loading}
      teamName={teamSession?.teamName ?? undefined}
      teammateList={teammateList}
      messages={teamSession?.messages ?? []}
      streamingText={teamSession?.streamingText ?? ''}
      subagentMessages={teamSession?.subagentMessages ?? {}}
      subagentStreamingText={teamSession?.subagentStreamingText ?? {}}
    />
  )
}
