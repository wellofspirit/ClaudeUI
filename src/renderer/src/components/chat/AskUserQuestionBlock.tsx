import { useState } from 'react'
import type { ContentBlock, PendingApproval, AskUserQuestion, AskUserQuestionInput } from '../../../../shared/types'
import { useSessionStore } from '../../stores/session-store'

function useRoutingId(): string | null {
  return useSessionStore((s) => s.activeSessionId)
}

interface Props {
  block: ContentBlock
  result?: ContentBlock
  approval?: PendingApproval
}

export function AskUserQuestionBlock({ block, result, approval }: Props): React.JSX.Element {
  const routingId = useRoutingId()
  const removePendingApproval = useSessionStore((s) => s.removePendingApproval)
  const input = block.toolInput as unknown as AskUserQuestionInput | undefined
  const questions = input?.questions ?? []

  const [currentStep, setCurrentStep] = useState(0)
  const [answers, setAnswers] = useState<Record<string, string>>({})
  const [otherText, setOtherText] = useState<Record<string, string>>({})
  const [otherActive, setOtherActive] = useState<Record<string, boolean>>({})
  const [submitted, setSubmitted] = useState(false)
  const [summaryExpanded, setSummaryExpanded] = useState(false)

  const totalSteps = questions.length
  const isCompleted = !!result || submitted
  const isPending = !!approval && !isCompleted

  const handleSelect = (questionIdx: number, question: AskUserQuestion, optionLabel: string): void => {
    const key = question.header || `q${questionIdx}`
    if (question.multiSelect) {
      const current = answers[key] || ''
      const selected = current ? current.split(', ') : []
      const idx = selected.indexOf(optionLabel)
      if (idx >= 0) {
        selected.splice(idx, 1)
      } else {
        selected.push(optionLabel)
      }
      setAnswers({ ...answers, [key]: selected.join(', ') })
    } else {
      setAnswers({ ...answers, [key]: optionLabel })
      setOtherActive({ ...otherActive, [key]: false })
      setOtherText({ ...otherText, [key]: '' })
    }
  }

  const handleOtherActivate = (questionIdx: number, question: AskUserQuestion): void => {
    const key = question.header || `q${questionIdx}`
    setOtherActive({ ...otherActive, [key]: true })
    if (!question.multiSelect) {
      // Clear predefined selection when switching to Other
      setAnswers({ ...answers, [key]: otherText[key] || '' })
    }
  }

  const handleOtherChange = (questionIdx: number, question: AskUserQuestion, text: string): void => {
    const key = question.header || `q${questionIdx}`
    setOtherText({ ...otherText, [key]: text })
    setAnswers({ ...answers, [key]: text })
  }

  const isOtherMode = (questionIdx: number, question: AskUserQuestion): boolean => {
    const key = question.header || `q${questionIdx}`
    return !!otherActive[key]
  }

  const isSelected = (questionIdx: number, question: AskUserQuestion, optionLabel: string): boolean => {
    const key = question.header || `q${questionIdx}`
    if (otherActive[key] && !question.multiSelect) return false
    const answer = answers[key] || ''
    if (question.multiSelect) {
      return answer.split(', ').includes(optionLabel)
    }
    return answer === optionLabel
  }

  const canProceed = (): boolean => {
    if (totalSteps === 0) return false
    const q = questions[currentStep]
    const key = q.header || `q${currentStep}`
    return !!answers[key]
  }

  const allAnswered = (): boolean => {
    return questions.every((q, i) => {
      const key = q.header || `q${i}`
      return !!answers[key]
    })
  }

  const handleSubmit = async (): Promise<void> => {
    if (!approval || !allAnswered() || !routingId) return
    setSubmitted(true)
    await window.api.respondApproval(routingId, approval.requestId, 'allow', answers)
    removePendingApproval(routingId, approval.requestId)
  }

  const handleDeny = async (): Promise<void> => {
    if (!approval || !routingId) return
    setSubmitted(true)
    await window.api.respondApproval(routingId, approval.requestId, 'deny')
    removePendingApproval(routingId, approval.requestId)
  }

  // Completed state: show summary
  if (isCompleted) {
    return (
      <div className="rounded-lg border border-success/30 bg-bg-secondary overflow-hidden">
        <button
          onClick={() => setSummaryExpanded(!summaryExpanded)}
          className="w-full flex items-center gap-2 px-3 h-9 text-[13px] hover:bg-bg-hover transition-colors cursor-pointer"
        >
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="text-success shrink-0">
            <circle cx="12" cy="12" r="10" />
            <polyline points="8 12 11 15 16 9" />
          </svg>
          <span className="font-mono font-medium text-accent">AskUserQuestion</span>
          <span className="text-text-secondary truncate flex-1 text-left text-[12px]">
            {totalSteps} question{totalSteps !== 1 ? 's' : ''} answered
          </span>
          <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className={`text-text-secondary transition-transform shrink-0 ${summaryExpanded ? 'rotate-180' : ''}`}>
            <polyline points="6 9 12 15 18 9" />
          </svg>
        </button>
        {summaryExpanded && (
          <div className="border-t border-border px-3 py-2.5 flex flex-col gap-2">
            {questions.map((q, i) => {
              const key = q.header || `q${i}`
              return (
                <div key={i} className="flex flex-col gap-0.5">
                  <span className="text-[11px] text-text-secondary uppercase tracking-wider">{q.header}</span>
                  <span className="text-[13px] text-text-primary">{answers[key] || '—'}</span>
                </div>
              )
            })}
          </div>
        )}
      </div>
    )
  }

  // No questions or not pending — fallback
  if (!isPending || totalSteps === 0) {
    return (
      <div className="rounded-lg border border-border bg-bg-secondary px-3 py-2.5">
        <div className="flex items-center gap-2 text-[13px]">
          <span className="w-3 h-3 rounded-full border-2 border-text-muted border-t-transparent shrink-0 animate-spin-slow" />
          <span className="font-mono font-medium text-accent">AskUserQuestion</span>
          <span className="text-text-secondary">Waiting...</span>
        </div>
      </div>
    )
  }

  const question = questions[currentStep]
  const questionKey = question.header || `q${currentStep}`

  return (
    <div className="rounded-lg border border-accent/30 bg-bg-secondary overflow-hidden">
      {/* Header */}
      <div className="flex items-center gap-2 px-3 h-9 text-[13px] border-b border-border">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="text-accent shrink-0">
          <circle cx="12" cy="12" r="10" />
          <path d="M9.09 9a3 3 0 015.83 1c0 2-3 3-3 3" />
          <line x1="12" y1="17" x2="12.01" y2="17" />
        </svg>
        <span className="font-medium text-text-primary">Question</span>
        {totalSteps > 1 && (
          <span className="text-text-muted text-[11px] ml-auto">
            {currentStep + 1} / {totalSteps}
          </span>
        )}
      </div>

      {/* Question body */}
      <div className="px-3 py-3 flex flex-col gap-3">
        {/* Header chip */}
        {question.header && (
          <span className="inline-flex self-start px-2 py-0.5 rounded-full bg-accent/10 text-accent text-[11px] font-medium uppercase tracking-wider">
            {question.header}
          </span>
        )}

        {/* Question text */}
        <p className="text-[13px] text-text-primary leading-[1.6]">{question.question}</p>

        {/* Option cards */}
        <div className="flex flex-col gap-1.5">
          {question.options.map((option, oi) => {
            const selected = isSelected(currentStep, question, option.label)
            return (
              <button
                key={oi}
                onClick={() => handleSelect(currentStep, question, option.label)}
                className={`text-left px-3 py-2 rounded-lg border transition-colors cursor-pointer ${
                  selected
                    ? 'border-accent/50 bg-accent/10'
                    : 'border-border hover:border-border-bright hover:bg-bg-hover'
                }`}
              >
                <div className="flex items-start gap-2.5">
                  {/* Radio/checkbox indicator */}
                  <div className={`mt-0.5 shrink-0 w-4 h-4 rounded-${question.multiSelect ? 'sm' : 'full'} border-2 flex items-center justify-center transition-colors ${
                    selected ? 'border-accent bg-accent' : 'border-text-muted'
                  }`}>
                    {selected && (
                      <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="3">
                        <polyline points="4 12 10 18 20 6" />
                      </svg>
                    )}
                  </div>
                  <div className="flex flex-col gap-0.5 min-w-0">
                    <span className="text-[13px] font-medium text-text-primary">{option.label}</span>
                    {option.description && (
                      <span className="text-[12px] text-text-secondary leading-[1.4]">{option.description}</span>
                    )}
                  </div>
                </div>
              </button>
            )
          })}

          {/* Other option */}
          <button
            onClick={() => {
              if (!isOtherMode(currentStep, question)) {
                handleOtherActivate(currentStep, question)
              }
            }}
            className={`text-left px-3 py-2 rounded-lg border transition-colors cursor-pointer ${
              isOtherMode(currentStep, question)
                ? 'border-accent/50 bg-accent/10'
                : 'border-border hover:border-border-bright hover:bg-bg-hover'
            }`}
          >
            <div className="flex items-start gap-2.5">
              <div className={`mt-0.5 shrink-0 w-4 h-4 rounded-${question.multiSelect ? 'sm' : 'full'} border-2 flex items-center justify-center transition-colors ${
                isOtherMode(currentStep, question) ? 'border-accent bg-accent' : 'border-text-muted'
              }`}>
                {isOtherMode(currentStep, question) && (
                  <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="3">
                    <polyline points="4 12 10 18 20 6" />
                  </svg>
                )}
              </div>
              <div className="flex flex-col gap-1 min-w-0 flex-1">
                <span className="text-[13px] font-medium text-text-primary">Other</span>
                {isOtherMode(currentStep, question) && (
                  <input
                    type="text"
                    value={otherText[questionKey] || ''}
                    onChange={(e) => handleOtherChange(currentStep, question, e.target.value)}
                    onClick={(e) => e.stopPropagation()}
                    placeholder="Type your answer..."
                    className="w-full bg-transparent border-b border-accent/30 text-[12px] text-text-primary py-0.5 outline-none placeholder:text-text-muted"
                    autoFocus
                  />
                )}
              </div>
            </div>
          </button>
        </div>
      </div>

      {/* Navigation */}
      <div className="flex items-center border-t border-border px-3 py-2">
        <button
          onClick={handleDeny}
          className="text-[12px] text-text-secondary hover:text-danger transition-colors cursor-pointer"
        >
          Dismiss
        </button>
        <div className="flex-1" />
        {currentStep > 0 && (
          <button
            onClick={() => setCurrentStep(currentStep - 1)}
            className="text-[12px] text-text-secondary hover:text-text-primary transition-colors cursor-pointer mr-3"
          >
            Back
          </button>
        )}
        {currentStep < totalSteps - 1 ? (
          <button
            onClick={() => canProceed() && setCurrentStep(currentStep + 1)}
            disabled={!canProceed()}
            className={`text-[12px] font-medium px-3 py-1 rounded-md transition-colors cursor-pointer ${
              canProceed()
                ? 'bg-accent/15 text-accent hover:bg-accent/25'
                : 'text-text-muted cursor-not-allowed'
            }`}
          >
            Next
          </button>
        ) : (
          <button
            onClick={handleSubmit}
            disabled={!allAnswered()}
            className={`text-[12px] font-medium px-3 py-1 rounded-md transition-colors cursor-pointer ${
              allAnswered()
                ? 'bg-accent/15 text-accent hover:bg-accent/25'
                : 'text-text-muted cursor-not-allowed'
            }`}
          >
            Submit
          </button>
        )}
      </div>
    </div>
  )
}
