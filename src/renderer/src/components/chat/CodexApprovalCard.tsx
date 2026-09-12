import { useState } from 'react'
import type { PendingApproval } from '../../../../shared/types'
import type { CodexApprovalChoices } from '../../../../shared/codex-types'
import { SelectMenu } from '../shared/SelectMenu'

/**
 * The native `item/tool/requestUserInput` question card — the ONLY Codex
 * approval that still needs an engine-specific surface. Commands and file
 * changes are decided by ClaudeUI's shared permission engine (ADR-066) and
 * render through `ApprovalButtons` / `ApprovalCardView` like every other
 * engine's, so there is no accept/decline vocabulary here: the two exits are
 * "submit answers" and "cancel".
 */
export function CodexApprovalCard({ approval }: { approval: PendingApproval }): React.JSX.Element {
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [answers, setAnswers] = useState<Record<string, string>>({})
  // `PendingApproval.codex` is a union since the guardian-denial override
  // joined it, and only a QUESTION payload reaches this component — both call
  // sites route on `codex.questions`, and an override renders its two buttons
  // inline on the declined tool card instead.
  const native = approval.codex as CodexApprovalChoices
  const questions = native.questions
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
  return (
    <section
      data-testid="CodexApprovalCard"
      className="rounded-lg border border-warning/40 bg-bg-secondary p-3 space-y-2 text-sm"
    >
      <h3>Native question</h3>
      {approval.decisionReason && <p>{approval.decisionReason}</p>}
      {questions.map((question) => (
        <label key={question.id} className="block" data-testid="CodexApprovalCard.question">
          {question.header}: {question.question}
          {question.options.length > 0 && !question.allowOther ? (
            // `''` stays a REAL option: picking it only clears local answer
            // state (which re-disables Submit), so it costs nothing and keeps
            // the native element's "un-answer this" path.
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
        <button
          data-testid="CodexApprovalCard.submit"
          disabled={busy || questions.some((question) => !answers[question.id])}
          onClick={() =>
            void execute(() =>
              window.api.respondApproval(native.routingId!, approval.requestId, 'allow', answers)
            )
          }
        >
          Submit answers
        </button>
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
            Cancel
          </button>
        ))}
      </div>
      {error && <p role="alert">{error}</p>}
    </section>
  )
}
