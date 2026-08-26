import { useState } from 'react'
import type { ContentBlock, PendingApproval } from '../../../../../shared/types'
import type { ToolView } from '../../../../../shared/tool-kinds'
import { useSessionStore } from '../../../stores/session-store'
import { AskUserQuestionBlockView } from './View'

type ToolUseBlock = Extract<ContentBlock, { type: 'tool_use' }>
type ToolResultBlock = Extract<ContentBlock, { type: 'tool_result' }>
type QuestionView = Extract<ToolView, { kind: 'question' }>

interface Props {
  block: ToolUseBlock
  result?: ToolResultBlock
  view: QuestionView
  approval?: PendingApproval
}

export function AskUserQuestionBlock({ block, result, view, approval }: Props): React.JSX.Element {
  const routingId = useSessionStore((s) => s.activeSessionId)
  const dismissApproval = useSessionStore((s) => s.dismissApproval)
  const [submitted, setSubmitted] = useState(false)

  const isCompleted = !!result || submitted
  const isPending = !!approval && !isCompleted

  const handleSubmit = async (answers: Record<string, string>): Promise<void> => {
    if (!approval || !routingId) return
    setSubmitted(true)
    await window.api.respondApproval(routingId, approval.requestId, 'allow', answers)
    dismissApproval(routingId, approval.requestId)
  }

  const handleDeny = async (): Promise<void> => {
    if (!approval || !routingId) return
    setSubmitted(true)
    await window.api.respondApproval(routingId, approval.requestId, 'deny')
    dismissApproval(routingId, approval.requestId)
  }

  return (
    <AskUserQuestionBlockView
      block={block}
      questions={view.questions}
      isCompleted={isCompleted}
      isPending={isPending}
      onSubmit={handleSubmit}
      onDeny={handleDeny}
    />
  )
}
