import { useState, useRef, useCallback, useEffect } from 'react'
import { useSessionStore } from '../../stores/session-store'
import { v4 as uuid } from 'uuid'

const MODELS = [
  { id: 'claude-sonnet-4-5-20250929', label: 'sonnet-4-5' },
  { id: 'claude-opus-4-6', label: 'opus-4-6' },
  { id: 'claude-haiku-4-5-20251001', label: 'haiku-4-5' }
]

const EFFORT_LEVELS = ['low', 'medium', 'high'] as const

export function InputBox(): React.JSX.Element {
  const [text, setText] = useState('')
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const cwd = useSessionStore((s) => s.cwd)
  const status = useSessionStore((s) => s.status)
  const addUserMessage = useSessionStore((s) => s.addUserMessage)
  const isRunning = status.state === 'running'
  const isDisabled = !cwd || isRunning

  const [modelOpen, setModelOpen] = useState(false)
  const [effortOpen, setEffortOpen] = useState(false)
  const [plusOpen, setPlusOpen] = useState(false)
  const [selectedModel, setSelectedModel] = useState(MODELS[0])
  const [effort, setEffort] = useState<(typeof EFFORT_LEVELS)[number]>('high')

  useEffect(() => {
    if (!isRunning) textareaRef.current?.focus()
  }, [isRunning])

  // Close dropdowns on outside click
  useEffect(() => {
    const handler = (): void => {
      setModelOpen(false)
      setEffortOpen(false)
      setPlusOpen(false)
    }
    document.addEventListener('click', handler)
    return () => document.removeEventListener('click', handler)
  }, [])

  const handleSend = useCallback(async () => {
    const prompt = text.trim()
    if (!prompt || isDisabled) return
    addUserMessage(uuid(), prompt)
    setText('')
    if (textareaRef.current) textareaRef.current.style.height = 'auto'
    await window.api.sendPrompt(prompt)
  }, [text, isDisabled, addUserMessage])

  const handleCancel = useCallback(async () => {
    await window.api.cancelSession()
  }, [])

  const handleKeyDown = (e: React.KeyboardEvent): void => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      handleSend()
    }
    if (e.key === 'Escape' && isRunning) handleCancel()
  }

  const handleInput = (e: React.ChangeEvent<HTMLTextAreaElement>): void => {
    setText(e.target.value)
    const el = e.target
    el.style.height = 'auto'
    el.style.height = Math.min(el.scrollHeight, 200) + 'px'
  }

  return (
    <div style={{ padding: '24px 13px 16px' }} className="shrink-0 bg-gradient-to-t from-bg-primary from-70% to-transparent">
      <div className="max-w-[740px] mx-auto">
        <div
          onClick={() => { setModelOpen(false); setEffortOpen(false); setPlusOpen(false) }}
          className="rounded-2xl border border-border bg-bg-input focus-within:border-border-bright transition-colors"
        >
          {/* Top section — input area */}
          <textarea
            ref={textareaRef}
            value={text}
            onChange={handleInput}
            onKeyDown={handleKeyDown}
            onMouseDown={() => { setModelOpen(false); setEffortOpen(false); setPlusOpen(false) }}
            placeholder={
              !cwd
                ? 'Select a folder to get started'
                : isRunning
                  ? 'Claude is working...'
                  : 'Ask Claude anything, / for commands'
            }
            disabled={isDisabled}
            rows={2}
            className="w-full bg-transparent text-[13px] text-text-primary placeholder:text-text-muted pt-2 px-2 pb-1 resize-none outline-none disabled:opacity-30 leading-relaxed"
          />

          {/* Bottom section — controls bar */}
          <div className="flex items-center justify-between px-1.5 pb-1.5">
            {/* Left controls */}
            <div className="flex items-center gap-1">
              {/* Plus button */}
              <div className="relative">
                <button
                  onClick={(e) => {
                    e.stopPropagation()
                    setPlusOpen(!plusOpen)
                    setModelOpen(false)
                    setEffortOpen(false)
                  }}
                  className="w-7 h-7 flex items-center justify-center rounded-lg text-text-muted hover:text-text-secondary hover:bg-bg-hover transition-colors cursor-pointer"
                >
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                    <line x1="12" y1="5" x2="12" y2="19" />
                    <line x1="5" y1="12" x2="19" y2="12" />
                  </svg>
                </button>
                {plusOpen && (
                  <div className="absolute bottom-full mb-1 left-0 w-48 bg-bg-tertiary border border-border rounded-lg overflow-hidden shadow-lg shadow-black/30 z-20">
                    <button className="w-full flex items-center gap-2.5 px-3 h-9 text-[12px] text-text-secondary hover:bg-bg-hover hover:text-text-primary transition-colors cursor-pointer">
                      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className="text-text-muted">
                        <rect x="3" y="3" width="18" height="18" rx="2" ry="2" />
                        <circle cx="8.5" cy="8.5" r="1.5" />
                        <polyline points="21 15 16 10 5 21" />
                      </svg>
                      Attach image
                    </button>
                  </div>
                )}
              </div>

              {/* Model picker */}
              <div className="relative">
                <button
                  onClick={(e) => {
                    e.stopPropagation()
                    setModelOpen(!modelOpen)
                    setEffortOpen(false)
                    setPlusOpen(false)
                  }}
                  className="h-7 px-2 flex items-center gap-1 rounded-lg text-[11px] text-text-muted hover:text-text-secondary hover:bg-bg-hover transition-colors cursor-pointer"
                >
                  <span>{selectedModel.label}</span>
                  <svg width="8" height="8" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                    <polyline points="6 9 12 15 18 9" />
                  </svg>
                </button>
                {modelOpen && (
                  <div className="absolute bottom-full mb-1 left-0 w-44 bg-bg-tertiary border border-border rounded-lg overflow-hidden shadow-lg shadow-black/30 z-20">
                    {MODELS.map((m) => (
                      <button
                        key={m.id}
                        onClick={() => {
                          setSelectedModel(m)
                          setModelOpen(false)
                        }}
                        className={`w-full flex items-center gap-2 px-3 h-8 text-[12px] transition-colors cursor-pointer text-left ${
                          m.id === selectedModel.id
                            ? 'text-text-primary bg-bg-hover'
                            : 'text-text-secondary hover:bg-bg-hover hover:text-text-primary'
                        }`}
                      >
                        {m.label}
                      </button>
                    ))}
                  </div>
                )}
              </div>

              {/* Effort level */}
              <div className="relative">
                <button
                  onClick={(e) => {
                    e.stopPropagation()
                    setEffortOpen(!effortOpen)
                    setModelOpen(false)
                    setPlusOpen(false)
                  }}
                  className="h-7 px-2 flex items-center gap-1 rounded-lg text-[11px] text-text-muted hover:text-text-secondary hover:bg-bg-hover transition-colors cursor-pointer"
                >
                  <span>{effort}</span>
                  <svg width="8" height="8" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                    <polyline points="6 9 12 15 18 9" />
                  </svg>
                </button>
                {effortOpen && (
                  <div className="absolute bottom-full mb-1 left-0 w-28 bg-bg-tertiary border border-border rounded-lg overflow-hidden shadow-lg shadow-black/30 z-20">
                    {EFFORT_LEVELS.map((level) => (
                      <button
                        key={level}
                        onClick={() => {
                          setEffort(level)
                          setEffortOpen(false)
                        }}
                        className={`w-full flex items-center px-3 h-8 text-[12px] transition-colors cursor-pointer text-left capitalize ${
                          level === effort
                            ? 'text-text-primary bg-bg-hover'
                            : 'text-text-secondary hover:bg-bg-hover hover:text-text-primary'
                        }`}
                      >
                        {level}
                      </button>
                    ))}
                  </div>
                )}
              </div>
            </div>

            {/* Right controls */}
            <div className="flex items-center gap-1.5">
              {isRunning ? (
                <button
                  onClick={handleCancel}
                  className="h-7 px-2.5 flex items-center gap-1.5 text-[11px] text-text-secondary rounded-lg border border-border hover:border-border-bright transition-colors cursor-pointer"
                >
                  <svg width="8" height="8" viewBox="0 0 24 24" fill="currentColor">
                    <rect x="4" y="4" width="16" height="16" rx="2" />
                  </svg>
                  Stop
                </button>
              ) : (
                <button
                  onClick={handleSend}
                  disabled={!text.trim() || isDisabled}
                  className="w-7 h-7 flex items-center justify-center rounded-full bg-text-primary text-bg-primary transition-opacity disabled:opacity-15 cursor-pointer disabled:cursor-default"
                >
                  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                    <line x1="12" y1="19" x2="12" y2="5" />
                    <polyline points="5 12 12 5 19 12" />
                  </svg>
                </button>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
