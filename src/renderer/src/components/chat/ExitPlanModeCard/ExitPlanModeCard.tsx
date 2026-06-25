import { useState, useCallback } from 'react'
import { useSessionStore, useActiveSession } from '../../../stores/session-store'
import type { PendingApproval, ContentBlock as _ContentBlock } from '../../../../../shared/types'
import type { ToolView } from '../../../../../shared/tool-kinds'
import { waitForModeChange } from './utils'
import { ExitPlanModeCardView } from './View'

type ToolUseBlock = Extract<_ContentBlock, { type: 'tool_use' }>
type PlanView = Extract<ToolView, { kind: 'plan' }>

interface ExitPlanModeCardProps {
  block: ToolUseBlock
  view: PlanView
  approval?: PendingApproval
}

export function ExitPlanModeCard({ view, approval }: ExitPlanModeCardProps): React.JSX.Element {
  const activeSessionId = useSessionStore((s) => s.activeSessionId)
  const removePendingApproval = useSessionStore((s) => s.removePendingApproval)
  const clearConversation = useSessionStore((s) => s.clearConversation)
  const setPermissionMode = useSessionStore((s) => s.setPermissionMode)
  const markSdkActive = useSessionStore((s) => s.markSdkActive)
  const openPlanPanel = useSessionStore((s) => s.openPlanPanel)
  const cwd = useActiveSession((s) => s.cwd)
  const selectedEngineId = useActiveSession((s) => s.selectedEngineId)

  const [expanded, setExpanded] = useState(true)
  const [showFeedback, setShowFeedback] = useState(false)
  const [feedback, setFeedback] = useState('')

  // Plan content comes from the engine-neutral view (not block.toolInput)
  const planContent = view.plan || null

  // Option 1: Start fresh, auto-accept edits
  const handleStartFresh = useCallback(async () => {
    if (!planContent || !cwd || !approval || !activeSessionId) return

    // Get the session log path before cancelling (for transcript reference)
    const sessionLogPath = await window.api.getSessionLogPath(activeSessionId)

    await window.api.respondApproval(activeSessionId, approval.requestId, 'deny')
    removePendingApproval(activeSessionId, approval.requestId)

    await window.api.cancelSession(activeSessionId)
    clearConversation(activeSessionId)

    // Create a fresh SDK session for the same routingId
    const session = useSessionStore.getState().sessions[activeSessionId]
    await window.api.createSession(
      activeSessionId,
      cwd,
      session?.effort ?? 'medium',
      undefined,
      'acceptEdits',
      undefined,
      undefined,
      undefined,
      undefined,
      selectedEngineId
    )
    markSdkActive(activeSessionId)
    setPermissionMode('acceptEdits', activeSessionId)

    // Build prompt matching CLI format, including transcript reference
    let prompt = `Implement the following plan:\n\n${planContent}`
    if (sessionLogPath) {
      prompt += `\n\nIf you need specific details from before exiting plan mode (like exact code snippets, error messages, or content you generated), read the full transcript at: ${sessionLogPath}`
    }
    // User message is added by the server-relayed session:user-message event
    await window.api.sendPrompt(activeSessionId, prompt)
  }, [
    planContent,
    approval,
    cwd,
    activeSessionId,
    removePendingApproval,
    clearConversation,
    setPermissionMode,
    markSdkActive
  ])

  // Option 2: Continue, auto-accept edits
  const handleContinueAutoEdit = useCallback(async () => {
    if (!approval || !activeSessionId) return
    await window.api.respondApproval(activeSessionId, approval.requestId, 'allow')
    removePendingApproval(activeSessionId, approval.requestId)
    await waitForModeChange()

    setPermissionMode('acceptEdits', activeSessionId)
    await window.api.setPermissionMode(activeSessionId, 'acceptEdits')
  }, [approval, activeSessionId, removePendingApproval, setPermissionMode])

  // Option 3: Continue, approve manually
  const handleContinueManual = useCallback(async () => {
    if (!approval || !activeSessionId) return
    await window.api.respondApproval(activeSessionId, approval.requestId, 'allow')
    removePendingApproval(activeSessionId, approval.requestId)
    await waitForModeChange()

    setPermissionMode('default', activeSessionId)
    await window.api.setPermissionMode(activeSessionId, 'default')
  }, [approval, activeSessionId, removePendingApproval, setPermissionMode])

  // Option 4: Keep planning — submit feedback
  const handleKeepPlanning = useCallback(async () => {
    if (!approval || !activeSessionId) return
    const text = feedback.trim()
    if (!text) return
    await window.api.respondApproval(activeSessionId, approval.requestId, 'deny', {
      feedback: text
    })
    removePendingApproval(activeSessionId, approval.requestId)
    setShowFeedback(false)
    setFeedback('')
  }, [feedback, approval, activeSessionId, removePendingApproval])

  const handleOpenPlanPanel = useCallback(() => {
    if (activeSessionId && approval && planContent) {
      openPlanPanel(activeSessionId, planContent, approval.requestId)
    }
  }, [activeSessionId, approval, planContent, openPlanPanel])

  const handleToggleFeedback = useCallback(() => {
    setShowFeedback((prev) => !prev)
  }, [])

  return (
    <ExitPlanModeCardView
      planContent={planContent}
      hasApproval={!!approval}
      activeSessionId={activeSessionId}
      expanded={expanded}
      showFeedback={showFeedback}
      feedback={feedback}
      onToggleExpanded={() => setExpanded((prev) => !prev)}
      onToggleFeedback={handleToggleFeedback}
      onFeedbackChange={setFeedback}
      onOpenPlanPanel={handleOpenPlanPanel}
      onStartFresh={handleStartFresh}
      onContinueAutoEdit={handleContinueAutoEdit}
      onContinueManual={handleContinueManual}
      onKeepPlanning={handleKeepPlanning}
    />
  )
}
