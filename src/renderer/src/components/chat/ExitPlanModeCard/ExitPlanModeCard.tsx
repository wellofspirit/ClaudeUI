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
  const dismissApproval = useSessionStore((s) => s.dismissApproval)
  const clearConversation = useSessionStore((s) => s.clearConversation)
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

    // Capture the session's model / effort / thinking BEFORE clearConversation
    // wipes them back to defaults — threading them keeps the fresh session on the
    // user's chosen model (like every other spawn path) instead of discarding it.
    const preSession = useSessionStore.getState().sessions[activeSessionId]
    const model = preSession?.selectedModel
    const effort = preSession?.effort ?? undefined
    const thinkingMode = preSession?.thinkingMode ?? undefined

    // Get the session log path before cancelling (for transcript reference)
    const sessionLogPath = await window.api.getSessionLogPath(activeSessionId)

    await window.api.respondApproval(activeSessionId, approval.requestId, 'deny')
    dismissApproval(activeSessionId, approval.requestId)

    await window.api.cancelSession(activeSessionId)
    clearConversation(activeSessionId)

    // Create a fresh SDK session for the same routingId.
    await window.api.createSession(
      activeSessionId,
      cwd,
      effort,
      undefined,
      'acceptEdits',
      model,
      thinkingMode,
      undefined,
      undefined,
      selectedEngineId
    )
    markSdkActive(activeSessionId)
    // No local mode write: the fresh spawn's own init emits
    // `session:permission-mode` with the mode it was created in (SyncCore 4c).

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
    dismissApproval,
    clearConversation,
    markSdkActive,
    selectedEngineId
  ])

  // Option 2: Continue, auto-accept edits
  const handleContinueAutoEdit = useCallback(async () => {
    if (!approval || !activeSessionId) return
    await window.api.respondApproval(activeSessionId, approval.requestId, 'allow')
    dismissApproval(activeSessionId, approval.requestId)
    await waitForModeChange()

    // Invoke only — the pill follows `session:permission-mode` (SyncCore 4c).
    await window.api.setPermissionMode(activeSessionId, 'acceptEdits')
  }, [approval, activeSessionId, dismissApproval])

  // Option 3: Continue, approve manually
  const handleContinueManual = useCallback(async () => {
    if (!approval || !activeSessionId) return
    await window.api.respondApproval(activeSessionId, approval.requestId, 'allow')
    dismissApproval(activeSessionId, approval.requestId)
    await waitForModeChange()

    await window.api.setPermissionMode(activeSessionId, 'default')
  }, [approval, activeSessionId, dismissApproval])

  // Option 4: Keep planning — submit feedback
  const handleKeepPlanning = useCallback(async () => {
    if (!approval || !activeSessionId) return
    const text = feedback.trim()
    if (!text) return
    await window.api.respondApproval(activeSessionId, approval.requestId, 'deny', {
      feedback: text
    })
    dismissApproval(activeSessionId, approval.requestId)
    setShowFeedback(false)
    setFeedback('')
  }, [feedback, approval, activeSessionId, dismissApproval])

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
