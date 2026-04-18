import { useState } from 'react'
import type { ContentBlock, PendingApproval } from '../../../../../shared/types'
import { useSessionStore } from '../../../stores/session-store'
import { AskUserQuestionBlockView } from './View'

type ToolUseBlock = Extract<ContentBlock, { type: 'tool_use' }>
type ToolResultBlock = Extract<ContentBlock, { type: 'tool_result' }>

interface Props {
  block: ToolUseBlock
  result?: ToolResultBlock
  approval?: PendingApproval
}

export function AskUserQuestionBlock({ block, result, approval }: Props): React.JSX.Element {
  const routingId = useSessionStore((s) => s.activeSessionId)
  const removePendingApproval = useSessionStore((s) => s.removePendingApproval)
  const [submitted, setSubmitted] = useState(false)

  const isCompleted = !!result || submitted
  const isPending = !!approval && !isCompleted

  const handleSubmit = async (answers: Record<string, string>): Promise<void> => {
    if (!approval || !routingId) return
    setSubmitted(true)
    await window.api.respondApproval(routingId, approval.requestId, 'allow', answers)
    removePendingApproval(routingId, approval.requestId)
  }

  const handleDeny = async (): Promise<void> => {
    if (!approval || !routingId) return
    setSubmitted(true)
    await window.api.respondApproval(routingId, approval.requestId, 'deny')
    removePendingApproval(routingId, approval.requestId)
  }

  return (
    <AskUserQuestionBlockView
      block={block}
      isCompleted={isCompleted}
      isPending={isPending}
      onSubmit={handleSubmit}
      onDeny={handleDeny}
    />
  )
}
