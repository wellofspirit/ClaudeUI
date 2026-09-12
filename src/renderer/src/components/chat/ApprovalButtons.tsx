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
import { CodexApprovalCard } from './CodexApprovalCard'
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
  // Only a native QUESTION still needs the engine-specific card; commands and
  // file changes come through the shared gate and render here (ADR-066).
  if (approval.codex?.questions) return <CodexApprovalCard approval={approval} />
  const hasReason = showSuggestions && !!approval.decisionReason

  const handleDecision = async (decision: 'allow' | 'deny'): Promise<void> => {
    const selected =
      decision === 'allow' && approval.suggestions
        ? approval.suggestions.filter((_, i) => checkedSuggestions[i])
        : undefined
    await onApproval(decision, selected?.length ? selected : undefined)
  }

  // A guardian denial Codex already answered (ADR-067). The action is not
  // pending — nothing is waiting on this click — so the exits are "leave it
  // denied" and "tell Codex to allow that one action", and there is no standing
  // rule to offer: under `auto` a ClaudeUI allow rule is never consulted.
  if (approval.codex?.guardianOverride)
    return (
      <>
        {approval.decisionReason && (
          <div className="border-t border-warning/20 px-3 py-2">
            <p className="text-[11px] text-text-muted/70 leading-relaxed">
              {approval.decisionReason}
            </p>
          </div>
        )}
        <div data-testid={testid ?? 'ApprovalButtons'} className="flex border-t border-warning/20">
          <button
            data-testid="ApprovalButtons.dismiss"
            onClick={() => handleDecision('deny')}
            className="flex-1 h-8 text-[12px] font-medium text-text-secondary hover:bg-bg-hover transition-colors cursor-pointer"
          >
            Dismiss
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
