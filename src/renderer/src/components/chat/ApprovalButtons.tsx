/**
 * ApprovalButtons — the shared approval decision widget.
 *
 * Extracted from the 3 formerly-duplicated sites in the old ToolCallBlock/View.tsx
 * (main / mermaid / mockup). Now used by the ToolCard shell + the diagram/mockup
 * kind bodies. All sites call `onApproval(decision, selectedSuggestions?)` with an
 * identical contract.
 *
 * Props:
 *  - approval: the pending approval (for suggestions, decisionReason)
 *  - permissionMode: current session permission mode (for redundancy filtering)
 *  - onApproval: callback with decision + checked suggestions
 *  - showSuggestions: whether to render AlwaysAllowSection (defaults to true)
 */

import { useState, useEffect } from 'react'
import type {
  PendingApproval,
  PermissionSuggestion,
  PermissionMode
} from '../../../../shared/types'
import { AlwaysAllowSection } from './PermissionSuggestions'

export interface ApprovalButtonsProps {
  approval: PendingApproval
  permissionMode: PermissionMode | undefined
  onApproval: (
    decision: 'allow' | 'deny',
    selectedSuggestions?: PermissionSuggestion[]
  ) => Promise<void>
  /** Whether to show decisionReason and AlwaysAllowSection. Defaults to true. */
  showSuggestions?: boolean
  /** Optional testid for the root element. Defaults to "ApprovalButtons". */
  testid?: string
}

/** `m:ss` until `expiresAt`, floored at 0:00. */
function formatHoldRemaining(expiresAt: number, now: number): string {
  const secs = Math.max(0, Math.ceil((expiresAt - now) / 1000))
  return `${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, '0')}`
}

/**
 * The live "blocks in m:ss" countdown on a held auto-mode block (ADR-091 §3).
 * Display only: the host owns the expiry and withdraws the card itself.
 */
export function HoldCountdown({
  expiresAt,
  testid = 'ApprovalButtons.holdCountdown'
}: {
  expiresAt: number
  testid?: string
}): React.JSX.Element {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [])
  return (
    <span data-testid={testid} className="ml-auto shrink-0 text-[11px] font-mono text-warning/80">
      blocks in {formatHoldRemaining(expiresAt, now)}
    </span>
  )
}

export function ApprovalButtons({
  approval,
  permissionMode,
  onApproval,
  showSuggestions = true,
  testid
}: ApprovalButtonsProps): React.JSX.Element {
  const [checkedSuggestions, setCheckedSuggestions] = useState<boolean[]>(() =>
    (approval.suggestions || []).map(() => false)
  )

  useEffect(() => {
    if (approval.suggestions?.length) {
      setCheckedSuggestions(approval.suggestions.map(() => false))
    }
  }, [approval.suggestions])

  const hasSuggestions = showSuggestions && (approval.suggestions?.length ?? 0) > 0
  const hasReason = showSuggestions && !!approval.decisionReason

  const handleDecision = async (decision: 'allow' | 'deny'): Promise<void> => {
    const selected =
      decision === 'allow' && approval.suggestions
        ? approval.suggestions.filter((_, i) => checkedSuggestions[i])
        : undefined
    await onApproval(decision, selected?.length ? selected : undefined)
  }

  // An auto-mode judge's block the user may override. ClaudeUI's own judge
  // HOLDS its block (ADR-091 §3) until the user answers or `expiresAt` passes,
  // when the host keeps it blocked. It offers no standing rule: it is an
  // override of one call, and under `auto` a ClaudeUI allow rule is never
  // consulted.
  const heldBlock = approval.autoModeBlock
  if (heldBlock)
    return (
      <>
        <div className="border-t border-warning/20 px-3 py-2 flex items-start gap-2">
          {approval.decisionReason && (
            <p className="flex-1 text-[11px] text-text-muted/70 leading-relaxed">
              {approval.decisionReason}
            </p>
          )}
          <HoldCountdown expiresAt={heldBlock.expiresAt} />
        </div>
        <div data-testid={testid ?? 'ApprovalButtons'} className="flex border-t border-warning/20">
          <button
            data-testid="ApprovalButtons.keepBlocked"
            onClick={() => handleDecision('deny')}
            className="flex-1 h-8 text-[12px] font-medium text-text-secondary hover:bg-bg-hover transition-colors cursor-pointer"
          >
            Keep blocked
          </button>
          <div className="w-px bg-warning/20" />
          <button
            data-testid="ApprovalButtons.approveAnyway"
            onClick={() => handleDecision('allow')}
            className="flex-1 h-8 text-[12px] font-medium text-warning hover:bg-warning/5 transition-colors cursor-pointer"
          >
            Approve anyway
          </button>
        </div>
      </>
    )

  return (
    <>
      {(hasReason || hasSuggestions) && (
        <div className="border-t border-warning/20 px-3 py-2">
          {hasReason && (
            <p className="text-[11px] text-text-muted/70 leading-relaxed">
              {approval.decisionReason}
            </p>
          )}
          {hasSuggestions && (
            <AlwaysAllowSection
              suggestions={approval.suggestions!}
              checkedSuggestions={checkedSuggestions}
              onToggle={(i) =>
                setCheckedSuggestions((prev) => prev.map((v, j) => (j === i ? !v : v)))
              }
              currentMode={permissionMode}
            />
          )}
        </div>
      )}
      <div data-testid={testid ?? 'ApprovalButtons'} className="flex border-t border-warning/20">
        <button
          data-testid="ApprovalButtons.deny"
          onClick={() => handleDecision('deny')}
          className="flex-1 h-8 text-[12px] font-medium text-danger hover:bg-danger/5 transition-colors cursor-pointer"
        >
          Deny
        </button>
        <div className="w-px bg-warning/20" />
        <button
          data-testid="ApprovalButtons.allow"
          onClick={() => handleDecision('allow')}
          className="flex-1 h-8 text-[12px] font-medium text-success hover:bg-success/5 transition-colors cursor-pointer"
        >
          Allow
        </button>
      </div>
    </>
  )
}
