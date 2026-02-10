import { useSessionStore } from '../../stores/session-store'

export function ApprovalPrompt(): React.JSX.Element | null {
  const pendingApproval = useSessionStore((s) => s.pendingApproval)
  const setPendingApproval = useSessionStore((s) => s.setPendingApproval)

  if (!pendingApproval) return null

  const handleRespond = async (decision: 'allow' | 'deny'): Promise<void> => {
    await window.api.respondApproval(pendingApproval.requestId, decision)
    setPendingApproval(null)
  }

  const inputPreview = JSON.stringify(pendingApproval.input, null, 2)

  return (
    <div className="rounded-lg border border-warning/20 overflow-hidden animate-fade-in">
      <div className="px-4 py-3">
        <div className="flex items-center gap-2 mb-2">
          <span className="text-[11px] font-semibold text-warning uppercase tracking-wider">Permission</span>
          <span className="text-[13px] font-mono font-medium text-text-primary">{pendingApproval.toolName}</span>
        </div>
        <pre className="text-[11px] text-text-secondary font-mono whitespace-pre-wrap break-words max-h-28 overflow-y-auto bg-bg-primary rounded-md p-2.5 border border-border leading-[1.5]">
          {inputPreview.length > 500 ? inputPreview.slice(0, 500) + '\n...' : inputPreview}
        </pre>
      </div>
      <div className="flex border-t border-warning/15">
        <button
          onClick={() => handleRespond('deny')}
          className="flex-1 h-9 text-[12px] font-medium text-danger hover:opacity-80 transition-opacity cursor-pointer"
        >
          Deny
        </button>
        <div className="w-px bg-warning/15" />
        <button
          onClick={() => handleRespond('allow')}
          className="flex-1 h-9 text-[12px] font-medium text-success hover:opacity-80 transition-opacity cursor-pointer"
        >
          Allow
        </button>
      </div>
    </div>
  )
}
