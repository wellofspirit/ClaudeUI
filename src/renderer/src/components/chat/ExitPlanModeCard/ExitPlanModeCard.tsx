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
  /**
   * Whether this card is on the LAST assistant message. Only that one gets the
   * no-approval action set (Codex): an older plan's buttons would send
   * "Implement the plan." for a plan the conversation has long moved past.
   */
  isLatest?: boolean
}

export function ExitPlanModeCard({
  view,
  approval,
  isLatest = false
}: ExitPlanModeCardProps): React.JSX.Element {
  const activeSessionId = useSessionStore((s) => s.activeSessionId)
  const dismissApproval = useSessionStore((s) => s.dismissApproval)
  const clearConversation = useSessionStore((s) => s.clearConversation)
  const markSdkActive = useSessionStore((s) => s.markSdkActive)
  const openPlanPanel = useSessionStore((s) => s.openPlanPanel)
  const cwd = useActiveSession((s) => s.cwd)
  const selectedEngineId = useActiveSession((s) => s.selectedEngineId)
  const engineId = useActiveSession((s) => s.status.engineId)

  const [expanded, setExpanded] = useState(true)
  const [showFeedback, setShowFeedback] = useState(false)
  const [feedback, setFeedback] = useState('')

  // Plan content comes from the engine-neutral view (not block.toolInput)
  const planContent = view.plan || null

  /**
   * The Codex plan item has NO approval gate on the wire — the core emits it as
   * an ordinary thread item and the turn ends. The four options are therefore a
   * MODE SWITCH plus a prompt, the way the Codex TUI's own follow-up works
   * (`tui/src/chatwidget/plan_implementation.rs`), rather than an approval reply.
   *
   * Gated on all three of: this engine, no approval, and the latest assistant
   * message — so Claude's approval path below is reached exactly when it was
   * before, and a scrolled-back plan is inert.
   */
  const codexActions = !approval && isLatest && engineId === 'codex' && !!planContent

  // Option 1: Start fresh, auto-accept edits
  const handleStartFresh = useCallback(async () => {
    if (!planContent || !cwd || !activeSessionId) return
    if (!approval && !codexActions) return

    // Capture the session's model / effort / thinking BEFORE clearConversation
    // wipes them back to defaults — threading them keeps the fresh session on the
    // user's chosen model (like every other spawn path) instead of discarding it.
    const preSession = useSessionStore.getState().sessions[activeSessionId]
    const model = preSession?.selectedModel
    const effort = preSession?.effort ?? undefined
    const thinkingMode = preSession?.thinkingMode ?? undefined

    // Get the session log path before cancelling (for transcript reference)
    const sessionLogPath = await window.api.getSessionLogPath(activeSessionId)

    // Codex's plan item is not an approval: there is nothing to deny, and the
    // session is torn down two lines below anyway.
    if (approval) {
      await window.api.respondApproval(activeSessionId, approval.requestId, 'deny')
      dismissApproval(activeSessionId, approval.requestId)
    }

    await window.api.cancelSession(activeSessionId)
    // AWAITED: the clear is a replicated event now, and the `session:created`
    // below must be emitted after it — otherwise the fresh session's birth
    // config would be blanked by a clear that arrived late.
    //
    // Error posture matches its neighbours (which all await bare invokes and let
    // a rejection abort the flow): if the reset did not happen, spawning a fresh
    // session on top of the OLD transcript is worse than doing nothing — the user
    // would be talking to an empty engine under a conversation it never saw. The
    // approval is already denied at this point, so the plan card resolves either
    // way and the user can retry.
    await clearConversation(activeSessionId)

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
    codexActions,
    cwd,
    activeSessionId,
    dismissApproval,
    clearConversation,
    markSdkActive,
    selectedEngineId
  ])

  /**
   * Options 2 and 3 on an engine with no approval: switch the mode, then ask
   * for the plan to be carried out. The prompt is the Codex TUI's own
   * ("Implement the plan.", `plan_implementation.rs`), so the model sees the
   * same instruction from either client.
   */
  const continueWithMode = useCallback(
    async (mode: 'acceptEdits' | 'default') => {
      if (!activeSessionId) return
      if (approval) {
        await window.api.respondApproval(activeSessionId, approval.requestId, 'allow')
        dismissApproval(activeSessionId, approval.requestId)
        await waitForModeChange()
        // Invoke only — the pill follows `session:permission-mode` (SyncCore 4c).
        await window.api.setPermissionMode(activeSessionId, mode)
        return
      }
      if (!codexActions) return
      // Mode BEFORE prompt: the next turn has to start under the new policy, and
      // `turn/start` carries both the policy and the collaboration mode.
      await window.api.setPermissionMode(activeSessionId, mode)
      await window.api.sendPrompt(activeSessionId, 'Implement the plan.')
    },
    [approval, codexActions, activeSessionId, dismissApproval]
  )

  // Option 2: Continue, auto-accept edits
  const handleContinueAutoEdit = useCallback(
    () => continueWithMode('acceptEdits'),
    [continueWithMode]
  )

  // Option 3: Continue, approve manually
  const handleContinueManual = useCallback(() => continueWithMode('default'), [continueWithMode])

  // Option 4: Keep planning — submit feedback
  const handleKeepPlanning = useCallback(async () => {
    if (!activeSessionId) return
    const text = feedback.trim()
    if (!text) return
    if (approval) {
      await window.api.respondApproval(activeSessionId, approval.requestId, 'deny', {
        feedback: text
      })
      dismissApproval(activeSessionId, approval.requestId)
    } else if (codexActions) {
      // No approval to deny — the feedback is the next prompt, and the mode is
      // deliberately left alone: the user chose to KEEP planning.
      await window.api.sendPrompt(activeSessionId, text)
    } else return
    setShowFeedback(false)
    setFeedback('')
  }, [feedback, approval, codexActions, activeSessionId, dismissApproval])

  const handleOpenPlanPanel = useCallback(() => {
    if (!activeSessionId || !planContent) return
    if (approval) openPlanPanel(activeSessionId, planContent, approval.requestId)
    // A plan with no approval still gets the review panel; the bar sends the
    // comments as a prompt rather than as an approval denial.
    else if (codexActions) openPlanPanel(activeSessionId, planContent, null)
  }, [activeSessionId, approval, codexActions, planContent, openPlanPanel])

  const handleToggleFeedback = useCallback(() => {
    setShowFeedback((prev) => !prev)
  }, [])

  return (
    <ExitPlanModeCardView
      planContent={planContent}
      hasApproval={!!approval || codexActions}
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
