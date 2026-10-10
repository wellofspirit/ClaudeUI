import { useState } from 'react'
import { CodexApprovalCard } from './CodexApprovalCard'
import { useSessionStore, useActiveSession } from '../../stores/session-store'
import type {
  ApprovalDecision,
  ContentBlock,
  EngineId,
  PendingApproval
} from '../../../../shared/types'
import type { ToolView } from '../../../../shared/tool-kinds'
import { engineToolMap } from './tool-registry/engine-tool-maps'
import { AlwaysAllowSection } from './PermissionSuggestions'
import { HoldCountdown } from './ApprovalButtons'
import { AskUserQuestionBlock } from './AskUserQuestionBlock/AskUserQuestionBlock'

// ---------------------------------------------------------------------------
// View layer — pure render, zero business logic
// ---------------------------------------------------------------------------

export interface ApprovalCardViewProps {
  approval: PendingApproval
  permissionMode: string | undefined
  alwaysAllow: boolean
  onAlwaysAllowChange: (checked: boolean) => void
  checkedSuggestions: boolean[]
  onToggleSuggestion: (index: number) => void
  onRespond: (decision: ApprovalDecision) => void
  /** When true, renders the "Allow for session" button. No current producer —
   *  will be re-wired when opencode is integrated in Phase 5. */
  showAllowForSession?: boolean
  /**
   * The call normalized by its engine's tool map ({@link approvalToolView}),
   * so the summary reads the same for every engine's names and field shapes.
   * Absent → the raw input.
   */
  toolView?: ToolView
}

export function ApprovalCardView({
  approval,
  permissionMode,
  alwaysAllow,
  onAlwaysAllowChange,
  checkedSuggestions,
  onToggleSuggestion,
  onRespond,
  showAllowForSession = false,
  toolView
}: ApprovalCardViewProps): React.JSX.Element {
  // See ApprovalButtons: the codex card is the native-question surface only.
  if (approval.codex?.questions) return <CodexApprovalCard approval={approval} />
  const input = approval.input
  const toolName = approval.toolName
  const isSandboxEscape = !!input?.dangerouslyDisableSandbox
  // A held auto-mode block (ADR-091 §3) — see ApprovalButtons: Keep blocked /
  // Approve anyway, never a standing rule or a session allow.
  const heldBlock = approval.autoModeBlock
  const hasSuggestions = !heldBlock && (approval.suggestions?.length ?? 0) > 0

  // Render a useful summary based on the call's normalized kind — engine
  // names and field shapes differ (Claude `Bash`/`file_path`, pi `bash`/`path`).
  const filePath =
    toolView &&
    (toolView.kind === 'fileEdit' || toolView.kind === 'fileWrite' || toolView.kind === 'fileRead')
      ? toolView.path
      : ''
  let summary: React.JSX.Element
  if (toolView?.kind === 'command' && toolView.command) {
    summary = (
      <pre
        data-testid="ApprovalCardView.summary"
        className="text-[12px] font-mono text-text-primary/80 whitespace-pre-wrap break-words bg-bg-primary rounded-md p-2 border border-border max-h-32 overflow-y-auto"
      >
        $ {toolView.command}
      </pre>
    )
  } else if (filePath) {
    summary = (
      <span
        data-testid="ApprovalCardView.summary"
        className="text-[12px] font-mono text-text-secondary"
      >
        {filePath}
      </span>
    )
  } else {
    summary = (
      <pre
        data-testid="ApprovalCardView.summary"
        className="text-[12px] font-mono text-text-primary/70 whitespace-pre-wrap break-words bg-bg-primary rounded-md p-2 border border-border max-h-24 overflow-y-auto"
      >
        {JSON.stringify(input, null, 2)}
      </pre>
    )
  }

  const borderColor = isSandboxEscape ? 'border-danger/50' : 'border-warning/40'
  const dividerColor = isSandboxEscape ? 'border-danger/20' : 'border-warning/20'
  const labelColor = isSandboxEscape ? 'text-danger' : 'text-warning'
  const labelText = isSandboxEscape ? 'Sandbox Escape' : 'Permission'

  return (
    <div
      data-testid="ApprovalCardView"
      className={`rounded-lg border ${borderColor} bg-bg-secondary overflow-hidden animate-fade-in`}
    >
      <div className="px-3 py-2">
        <div className="flex items-center gap-2 mb-2">
          {isSandboxEscape ? (
            <svg
              width="12"
              height="12"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              className="text-danger shrink-0"
            >
              <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
              <line x1="4" y1="4" x2="20" y2="20" />
            </svg>
          ) : (
            <svg
              width="12"
              height="12"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              className="text-warning shrink-0"
            >
              <path d="M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z" />
              <line x1="12" y1="9" x2="12" y2="13" />
              <line x1="12" y1="17" x2="12.01" y2="17" />
            </svg>
          )}
          <span
            data-testid="ApprovalCardView.label"
            className={`text-[11px] font-semibold ${labelColor} uppercase tracking-wider`}
          >
            {labelText}
          </span>
          <span
            data-testid="ApprovalCardView.toolName"
            className="font-mono text-[12px] text-accent"
          >
            {toolName}
          </span>
          {heldBlock && (
            <HoldCountdown
              expiresAt={heldBlock.expiresAt}
              testid="ApprovalCardView.holdCountdown"
            />
          )}
        </div>
        {approval.agent && (
          <p
            data-testid="ApprovalCardView.agent"
            className="text-[11px] text-text-secondary mb-2 leading-relaxed"
          >
            Agent {approval.agent.label} ({approval.agent.subagentType})
          </p>
        )}
        {approval.decisionReason && (
          <p
            data-testid="ApprovalCardView.reason"
            className="text-[11px] text-text-muted/70 mb-2 leading-relaxed"
          >
            {approval.decisionReason}
          </p>
        )}
        {isSandboxEscape && (
          <p className="text-[11px] text-danger/70 mb-2">
            This command requests execution outside the sandbox.
          </p>
        )}
        {summary}
        {isSandboxEscape && !heldBlock && (
          <label className="flex items-center gap-2 mt-2 cursor-default select-none">
            <input
              data-testid="ApprovalCardView.alwaysAllowOutsideSandbox"
              type="checkbox"
              checked={alwaysAllow}
              onChange={(e) => onAlwaysAllowChange(e.target.checked)}
              className="w-3.5 h-3.5 rounded border-border accent-accent cursor-pointer"
            />
            <span className="text-[11px] text-text-muted">
              Always allow this command outside sandbox
            </span>
          </label>
        )}
        {hasSuggestions && (
          <AlwaysAllowSection
            suggestions={approval.suggestions!}
            checkedSuggestions={checkedSuggestions}
            onToggle={onToggleSuggestion}
            currentMode={permissionMode}
          />
        )}
      </div>
      <div className={`flex border-t ${dividerColor}`}>
        <button
          data-testid="ApprovalCardView.deny"
          onClick={() => onRespond('deny')}
          className="flex-1 h-8 text-[12px] font-medium text-danger hover:bg-danger/5 transition-colors cursor-pointer"
        >
          {heldBlock ? 'Keep blocked' : 'Deny'}
        </button>
        {showAllowForSession && !heldBlock && (
          <>
            <div className={`w-px ${dividerColor.replace('border-', 'bg-')}`} />
            <button
              data-testid="ApprovalCardView.allowForSession"
              onClick={() => onRespond('allowForSession')}
              className="flex-1 h-8 text-[12px] font-medium text-accent/80 hover:bg-accent/5 transition-colors cursor-pointer"
            >
              Allow for session
            </button>
          </>
        )}
        <div className={`w-px ${dividerColor.replace('border-', 'bg-')}`} />
        <button
          data-testid="ApprovalCardView.allow"
          onClick={() => onRespond('allow')}
          className="flex-1 h-8 text-[12px] font-medium text-success hover:bg-success/5 transition-colors cursor-pointer"
        >
          {heldBlock ? 'Approve anyway' : 'Allow'}
        </button>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Logic layer — hooks, store access, IPC calls
// ---------------------------------------------------------------------------

/**
 * The approval's call normalized by the tool map of the engine that MADE it:
 * the session's own, or — for a dispatch target's forwarded card — the
 * target's (`agent.subagentType: 'dispatch:<engine>'`; an opencode target
 * prefixes the tool name with `dispatch:`). Undefined when the tool is not one
 * the map knows, so the card falls back to the raw input.
 */
export function approvalToolView(
  approval: PendingApproval,
  sessionEngine: EngineId
): ToolView | undefined {
  const dispatched = approval.agent?.subagentType.match(/^dispatch:(\w+)$/)?.[1]
  const engine = (dispatched as EngineId | undefined) ?? sessionEngine
  const toolName = approval.toolName.replace(/^dispatch:/, '')
  try {
    const map = engineToolMap(engine)
    const kind = map.kindOf(toolName)
    return kind === 'unknown' ? undefined : map.normalize(kind, approval.input, undefined, toolName)
  } catch {
    return undefined
  }
}

/**
 * Every pending approval with no matching tool_use block in the session's
 * TOP-LEVEL transcript.
 *
 * Nested transcripts (`subagentMessages`) are deliberately NOT consulted. Since
 * Slice I, `SubagentMessages` binds the same approval to the nested tool card,
 * so an approval raised inside a subagent renders on BOTH surfaces — a decided
 * duplication, not an oversight: a nested card can be scrolled out of view or
 * sit behind a collapsed task card, and an approval nobody can find is a hung
 * turn. Both surfaces carry the same `requestId`, so answering either resolves
 * the request and dismisses the other.
 */
function useUnmatchedApprovals(): PendingApproval[] {
  const pendingApprovals = useActiveSession((s) => s.pendingApprovals)
  const messages = useActiveSession((s) => s.messages)

  if (pendingApprovals.length === 0) return []

  // Collect tool_use ids AND (toolName, input) signatures. The id is the
  // authoritative binding key (mirrors MessageBubble's matcher) and the
  // signature is a legacy fallback for older main-process payloads that
  // haven't yet started forwarding toolUseId.
  const toolUseIds = new Set<string>()
  const toolUseSignatures = new Set<string>()
  for (const msg of messages) {
    if (msg.role !== 'assistant') continue
    for (const b of msg.content) {
      if (b.type !== 'tool_use') continue
      if (b.toolUseId) toolUseIds.add(b.toolUseId)
      if (b.toolName && b.toolInput) {
        toolUseSignatures.add(`${b.toolName}:${JSON.stringify(b.toolInput)}`)
      }
    }
  }

  return pendingApprovals.filter((a) => {
    if (a.toolUseId) return !toolUseIds.has(a.toolUseId)
    return !toolUseSignatures.has(`${a.toolName}:${JSON.stringify(a.input)}`)
  })
}

function ApprovalCard({ approval }: { approval: PendingApproval }): React.JSX.Element {
  const activeSessionId = useSessionStore((s) => s.activeSessionId)
  const dismissApproval = useSessionStore((s) => s.dismissApproval)
  const setEngineConfig = useSessionStore((s) => s.setEngineConfig)
  const engineConfig = useSessionStore((s) => s.engineConfig)
  const sandboxSettings = engineConfig.sandbox
  const permissionMode = useActiveSession((s) => s.permissionMode)
  const engineId = useActiveSession((s) => s.status.engineId)
  const [alwaysAllow, setAlwaysAllow] = useState(false)
  const [checkedSuggestions, setCheckedSuggestions] = useState<boolean[]>(() =>
    (approval.suggestions || []).map(() => false)
  )

  const handleRespond = async (decision: ApprovalDecision): Promise<void> => {
    if (!activeSessionId) return

    const isSandboxEscape = !!approval.input?.dangerouslyDisableSandbox

    // If allowing with "always allow" checked, add command to excluded list
    // A held auto-mode block overrides ONE call (ADR-091 §3) — never a standing rule.
    if (
      decision === 'allow' &&
      alwaysAllow &&
      isSandboxEscape &&
      !approval.autoModeBlock &&
      approval.input?.command
    ) {
      const cmd = String(approval.input.command)
      const currentExcluded = sandboxSettings?.excludedCommands ?? []
      if (!currentExcluded.includes(cmd)) {
        const nextSandbox = sandboxSettings
          ? { ...sandboxSettings, excludedCommands: [...currentExcluded, cmd] }
          : {
              enabled: false,
              autoAllowBashIfSandboxed: false,
              allowUnsandboxedCommands: false,
              network: {
                restrictNetwork: false,
                allowLocalBinding: false,
                allowedDomains: [],
                allowManagedDomainsOnly: false,
                allowAllUnixSockets: false,
                allowUnixSockets: []
              },
              filesystem: { allowWrite: [], denyWrite: [], denyRead: [] },
              excludedCommands: [cmd]
            }
        const nextConfig = { ...engineConfig, sandbox: nextSandbox }
        setEngineConfig(nextConfig)
        window.api.saveEngineConfig('claude', nextConfig).catch(() => {})
      }
    }

    // On allow, include any checked permission suggestions
    const selected =
      decision === 'allow' && approval.suggestions
        ? approval.suggestions.filter((_, i) => checkedSuggestions[i])
        : undefined

    await window.api.respondApproval(
      activeSessionId,
      approval.requestId,
      decision,
      undefined,
      selected?.length ? selected : undefined
    )
    dismissApproval(activeSessionId, approval.requestId)
  }

  return (
    <ApprovalCardView
      approval={approval}
      permissionMode={permissionMode}
      alwaysAllow={alwaysAllow}
      onAlwaysAllowChange={setAlwaysAllow}
      checkedSuggestions={checkedSuggestions}
      onToggleSuggestion={(i) =>
        setCheckedSuggestions((prev) => prev.map((v, j) => (j === i ? !v : v)))
      }
      onRespond={handleRespond}
      toolView={approvalToolView(approval, engineId)}
    />
  )
}

type ToolUseBlock = Extract<ContentBlock, { type: 'tool_use' }>

/**
 * Renders an unmatched AskUserQuestion approval as a floating interactive
 * question card. Used for child (subagent) questions whose callID is not in
 * the main message blocks, so they cannot be rendered inline.
 *
 * Builds a synthetic ToolUseBlock + ToolView from the approval's input so that
 * AskUserQuestionBlock can render typed questions. Submit / dismiss still
 * go through the approval's requestId via respondApproval.
 */
function FloatingQuestionCard({ approval }: { approval: PendingApproval }): React.JSX.Element {
  const synthetic: ToolUseBlock = {
    type: 'tool_use',
    toolUseId: approval.toolUseId ?? approval.requestId,
    toolName: 'AskUserQuestion',
    toolInput: (approval.input as Record<string, unknown>) ?? {}
  }
  // approval.input is {questions: AskUserQuestion[]} — already normalized by
  // event-mapper. Null-guard the access: a malformed approval with no input must
  // not throw here (that unmounts the whole app to a blank screen — M-RN2).
  const questionView = {
    kind: 'question' as const,
    questions:
      ((approval.input as Record<string, unknown> | undefined)
        ?.questions as import('../../../../shared/types').AskUserQuestion[]) ?? []
  }
  return <AskUserQuestionBlock block={synthetic} view={questionView} approval={approval} />
}

export function FloatingApproval(): React.JSX.Element | null {
  const unmatched = useUnmatchedApprovals()

  if (unmatched.length === 0) return null

  return (
    <div
      data-testid="FloatingApproval"
      className="absolute bottom-32 left-1/2 -translate-x-1/2 z-20 w-full max-w-[500px] px-4 flex flex-col gap-2 pointer-events-auto"
    >
      {unmatched.map((approval) =>
        approval.toolName === 'AskUserQuestion' ? (
          <FloatingQuestionCard key={approval.requestId} approval={approval} />
        ) : (
          <ApprovalCard key={approval.requestId} approval={approval} />
        )
      )}
    </div>
  )
}
