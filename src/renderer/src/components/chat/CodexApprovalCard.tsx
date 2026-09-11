import { useState } from 'react'
import type { PendingApproval } from '../../../../shared/types'
import type { CodexApprovalDecision } from '../../../../shared/codex-types'
import { SelectMenu } from '../shared/SelectMenu'

export function CodexApprovalCard({ approval }: { approval: PendingApproval }): React.JSX.Element {
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [answers, setAnswers] = useState<Record<string, string>>({})
  const native = approval.codex!
  const execute = async (action: () => Promise<void>): Promise<void> => {
    setBusy(true)
    setError('')
    try {
      await action()
    } catch (error) {
      setError(error instanceof Error ? error.message : 'Native approval failed')
    } finally {
      setBusy(false)
    }
  }
  const labels: Record<CodexApprovalDecision, string> = {
    accept: 'Accept',
    acceptForSession: 'Accept for session',
    decline: 'Decline',
    cancel: 'Cancel'
  }
  return (
    <section
      data-testid="CodexApprovalCard"
      className="rounded-lg border border-warning/40 bg-bg-secondary p-3 space-y-2 text-sm"
    >
      <h3>
        {approval.toolName === 'fileChange'
          ? 'Native file-change approval'
          : native.questions
            ? 'Native question'
            : approval.input.networkApprovalContext
              ? 'Native network approval'
              : approval.input.kind === 'writeStdin'
                ? 'Native terminal input approval'
                : 'Native command approval'}
      </h3>
      {approval.decisionReason && <p>{approval.decisionReason}</p>}
      {!native.questions && (
        <pre
          data-testid="CodexApprovalCard.context"
          className="max-h-56 overflow-auto whitespace-pre-wrap break-all text-xs"
        >
          {JSON.stringify(approval.input, null, 2)}
        </pre>
      )}
      {native.questions?.map((question) => (
        <label key={question.id} className="block" data-testid="CodexApprovalCard.question">
          {question.header}: {question.question}
          {question.options.length > 0 && !question.allowOther ? (
            // `''` stays a REAL option, unlike the one-shot pickers in
            // CodexPolicyPill: picking it only clears local answer state (which
            // re-disables Submit), so it costs nothing and keeps the native
            // element's "un-answer this" path.
            <SelectMenu
              testid="CodexApprovalCard.choice"
              ariaLabel={question.question}
              value={answers[question.id] ?? ''}
              options={[
                { value: '', label: 'Choose an answer' },
                ...question.options.map((option) => ({
                  value: option.label,
                  label: `${option.label} ${option.description}`
                }))
              ]}
              onChange={(value) => setAnswers({ ...answers, [question.id]: value })}
            />
          ) : (
            <>
              <input
                data-testid="CodexApprovalCard.answer"
                value={answers[question.id] ?? ''}
                onChange={(event) => setAnswers({ ...answers, [question.id]: event.target.value })}
                className="block w-full bg-bg-primary"
              />
              {question.options.map((option) => (
                <button
                  key={option.label}
                  onClick={() => setAnswers({ ...answers, [question.id]: option.label })}
                >
                  {option.label}
                </button>
              ))}
            </>
          )}
        </label>
      ))}
      <div className="flex flex-wrap gap-3">
        {native.questions && (
          <button
            data-testid="CodexApprovalCard.submit"
            disabled={busy || native.questions.some((question) => !answers[question.id])}
            onClick={() =>
              void execute(() =>
                window.api.respondApproval(native.routingId!, approval.requestId, 'allow', answers)
              )
            }
          >
            Submit answers
          </button>
        )}
        {native.decisions.map((decision) => (
          <button
            key={decision}
            data-testid={`CodexApprovalCard.${decision}`}
            disabled={busy || !native.routingId}
            onClick={() =>
              void execute(() =>
                window.api.codexApproval(native.routingId!, approval.requestId, decision)
              )
            }
          >
            {labels[decision]}
          </button>
        ))}
        {native.unsupportedDecisions.map((decision) => (
          <button
            key={decision}
            disabled
            title="This native policy amendment is not implemented; choose another offered decision."
          >
            {decision} (unsupported)
          </button>
        ))}
        {native.decisions.length === 0 && (
          <button
            data-testid="CodexApprovalCard.interrupt"
            disabled={busy || !native.routingId}
            onClick={() => void execute(() => window.api.interruptSession(native.routingId!))}
          >
            Stop turn
          </button>
        )}
      </div>
      {error && <p role="alert">{error}</p>}
    </section>
  )
}
