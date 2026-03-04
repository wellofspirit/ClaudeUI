import { useState } from 'react'
import { useSessionStore, useActiveSession } from '../../stores/session-store'
import type { PendingApproval } from '../../../../shared/types'

/**
 * Finds pending approvals that aren't matched to any visible tool_use block
 * in the messages (e.g. approvals from sub-agents whose tool calls aren't
 * in the parent's message stream).
 */
function useUnmatchedApprovals(): PendingApproval[] {
  const pendingApprovals = useActiveSession((s) => s.pendingApprovals)
  const messages = useActiveSession((s) => s.messages)

  if (pendingApprovals.length === 0) return []

  // Collect all tool_use signatures from messages
  const toolUseSignatures = new Set<string>()
  for (const msg of messages) {
    if (msg.role !== 'assistant') continue
    for (const b of msg.content) {
      if (b.type === 'tool_use' && b.toolName && b.toolInput) {
        toolUseSignatures.add(`${b.toolName}:${JSON.stringify(b.toolInput)}`)
      }
    }
  }

  return pendingApprovals.filter(
    (a) => !toolUseSignatures.has(`${a.toolName}:${JSON.stringify(a.input)}`)
  )
}

function ApprovalCard({ approval }: { approval: PendingApproval }): React.JSX.Element {
  const activeSessionId = useSessionStore((s) => s.activeSessionId)
  const removePendingApproval = useSessionStore((s) => s.removePendingApproval)
  const updateSettings = useSessionStore((s) => s.updateSettings)
  const sandboxSettings = useSessionStore((s) => s.settings.sandbox)
  const [alwaysAllow, setAlwaysAllow] = useState(false)

  const isSandboxEscape = !!approval.input?.dangerouslyDisableSandbox

  const handleRespond = async (decision: 'allow' | 'deny'): Promise<void> => {
    if (!activeSessionId) return

    // If allowing with "always allow" checked, add command to excluded list
    if (decision === 'allow' && alwaysAllow && isSandboxEscape && approval.input?.command) {
      const cmd = String(approval.input.command)
      if (!sandboxSettings.excludedCommands.includes(cmd)) {
        updateSettings({
          sandbox: {
            ...sandboxSettings,
            excludedCommands: [...sandboxSettings.excludedCommands, cmd]
          }
        })
      }
    }

    await window.api.respondApproval(activeSessionId, approval.requestId, decision)
    removePendingApproval(activeSessionId, approval.requestId)
  }

  const input = approval.input
  const toolName = approval.toolName

  // Render a useful summary based on tool type
  let summary: React.JSX.Element
  if (toolName === 'Bash' && input?.command) {
    summary = (
      <pre className="text-[12px] font-mono text-text-primary/80 whitespace-pre-wrap break-words bg-bg-primary rounded-md p-2 border border-border max-h-32 overflow-y-auto">
        $ {String(input.command)}
      </pre>
    )
  } else if ((toolName === 'Edit' || toolName === 'Write' || toolName === 'Read') && input?.file_path) {
    summary = (
      <span className="text-[12px] font-mono text-text-secondary">{String(input.file_path)}</span>
    )
  } else {
    summary = (
      <pre className="text-[12px] font-mono text-text-primary/70 whitespace-pre-wrap break-words bg-bg-primary rounded-md p-2 border border-border max-h-24 overflow-y-auto">
        {JSON.stringify(input, null, 2)}
      </pre>
    )
  }

  const borderColor = isSandboxEscape ? 'border-danger/50' : 'border-warning/40'
  const dividerColor = isSandboxEscape ? 'border-danger/20' : 'border-warning/20'
  const labelColor = isSandboxEscape ? 'text-danger' : 'text-warning'
  const labelText = isSandboxEscape ? 'Sandbox Escape' : 'Permission'

  return (
    <div className={`rounded-lg border ${borderColor} bg-bg-secondary overflow-hidden animate-fade-in`}>
      <div className="px-3 py-2">
        <div className="flex items-center gap-2 mb-2">
          {isSandboxEscape ? (
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="text-danger shrink-0">
              <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
              <line x1="4" y1="4" x2="20" y2="20" />
            </svg>
          ) : (
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="text-warning shrink-0">
              <path d="M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z" />
              <line x1="12" y1="9" x2="12" y2="13" />
              <line x1="12" y1="17" x2="12.01" y2="17" />
            </svg>
          )}
          <span className={`text-[11px] font-semibold ${labelColor} uppercase tracking-wider`}>{labelText}</span>
          <span className="font-mono text-[12px] text-accent">{toolName}</span>
        </div>
        {isSandboxEscape && (
          <p className="text-[11px] text-danger/70 mb-2">
            This command requests execution outside the sandbox.
          </p>
        )}
        {summary}
        {isSandboxEscape && (
          <label className="flex items-center gap-2 mt-2 cursor-default select-none">
            <input
              type="checkbox"
              checked={alwaysAllow}
              onChange={(e) => setAlwaysAllow(e.target.checked)}
              className="w-3.5 h-3.5 rounded border-border accent-accent cursor-pointer"
            />
            <span className="text-[11px] text-text-muted">Always allow this command outside sandbox</span>
          </label>
        )}
      </div>
      <div className={`flex border-t ${dividerColor}`}>
        <button
          onClick={() => handleRespond('deny')}
          className="flex-1 h-8 text-[12px] font-medium text-danger hover:bg-danger/5 transition-colors cursor-pointer"
        >
          Deny
        </button>
        <div className={`w-px ${dividerColor.replace('border-', 'bg-')}`} />
        <button
          onClick={() => handleRespond('allow')}
          className="flex-1 h-8 text-[12px] font-medium text-success hover:bg-success/5 transition-colors cursor-pointer"
        >
          Allow
        </button>
      </div>
    </div>
  )
}

export function FloatingApproval(): React.JSX.Element | null {
  const unmatched = useUnmatchedApprovals()

  if (unmatched.length === 0) return null

  return (
    <div className="absolute bottom-32 left-1/2 -translate-x-1/2 z-20 w-full max-w-[500px] px-4 flex flex-col gap-2 pointer-events-auto">
      {unmatched.map((approval) => (
        <ApprovalCard key={approval.requestId} approval={approval} />
      ))}
    </div>
  )
}
