import { useState, useRef, useCallback, useEffect } from 'react'
import { useSessionStore, useActiveSession } from '../../stores/session-store'
import type { StatusLineData } from '../../../../shared/types'
import { v4 as uuid } from 'uuid'

const EFFORT_LEVELS = ['low', 'medium', 'high'] as const

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`
  return String(n)
}

function formatDuration(ms: number): string {
  const totalSec = Math.floor(ms / 1000)
  if (totalSec < 60) return `${totalSec}s`
  const min = Math.floor(totalSec / 60)
  const sec = totalSec % 60
  return `${min}m ${sec}s`
}

function formatCost(usd: number): string {
  if (usd < 0.01) return '$' + usd.toFixed(4)
  return '$' + usd.toFixed(2)
}

function formatFileSize(bytes: number): string {
  if (bytes >= 1_048_576) return `${(bytes / 1_048_576).toFixed(1)} MB`
  if (bytes >= 1_024) return `${(bytes / 1_024).toFixed(1)} KB`
  return `${bytes} B`
}

function interpolateTemplate(template: string, data: StatusLineData): string {
  const total = data.totalInputTokens + data.totalOutputTokens
  return template
    .replace(/\{in\}/g, formatTokens(data.totalInputTokens))
    .replace(/\{out\}/g, formatTokens(data.totalOutputTokens))
    .replace(/\{total\}/g, formatTokens(total))
    .replace(/\{cost\}/g, formatCost(data.totalCostUsd))
    .replace(/\{used\}/g, data.usedPercentage !== null ? String(data.usedPercentage) : '–')
    .replace(/\{remaining\}/g, data.usedPercentage !== null ? String(100 - data.usedPercentage) : '–')
    .replace(/\{lines\+\}/g, String(data.totalLinesAdded))
    .replace(/\{lines-\}/g, String(data.totalLinesRemoved))
    .replace(/\{duration\}/g, formatDuration(data.totalDurationMs))
}

const ALIGN_CLASS = {
  left: 'text-left px-4',
  center: 'text-center',
  right: 'text-right px-4'
} as const

function StatusLine({ data }: { data: StatusLineData }): React.JSX.Element {
  const align = useSessionStore((s) => s.settings.statusLineAlign)
  const template = useSessionStore((s) => s.settings.statusLineTemplate)

  // Fallback: when patched status_line data is unavailable, show JSONL file size
  const isFallback = data.jsonlFileSize != null && data.totalInputTokens === 0 && data.totalOutputTokens === 0
  const text = isFallback
    ? `Session: ${formatFileSize(data.jsonlFileSize!)}${data.totalCostUsd > 0 ? ` · ${formatCost(data.totalCostUsd)}` : ''}`
    : interpolateTemplate(template, data)

  return (
    <div className={`text-[10px] text-text-muted ${ALIGN_CLASS[align]} pt-1.5 select-none truncate`}>
      {text}
    </div>
  )
}


export function InputBox(): React.JSX.Element {
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const activeSessionId = useSessionStore((s) => s.activeSessionId)
  const text = useActiveSession((s) => s.draftText)
  const setDraftText = useSessionStore((s) => s.setDraftText)
  const setText = setDraftText
  const cwd = useActiveSession((s) => s.cwd)
  const status = useActiveSession((s) => s.status)
  const sdkActive = useActiveSession((s) => s.sdkActive)
  const addUserMessage = useSessionStore((s) => s.addUserMessage)
  const markSdkActive = useSessionStore((s) => s.markSdkActive)
  const isRunning = status.state === 'running'
  const isDisabled = !activeSessionId || !cwd || isRunning

  const permissionMode = useActiveSession((s) => s.permissionMode)


  const [modelOpen, setModelOpen] = useState(false)
  const [effortOpen, setEffortOpen] = useState(false)
  const [plusOpen, setPlusOpen] = useState(false)
  const availableModels = useSessionStore((s) => s.availableModels)
  const setAvailableModels = useSessionStore((s) => s.setAvailableModels)
  const models = availableModels.map((m) => {
    const shortName = m.description?.split('·')[0]?.trim() || m.displayName
    return { ...m, shortName }
  })
  const selectedModelValue = useActiveSession((s) => s.selectedModel)
  const setSelectedModel = useSessionStore((s) => s.setSelectedModel)
  const selectedModel = models.find((m) => m.value === selectedModelValue) || models[0] || { value: 'default', displayName: 'Default', shortName: 'Default' }
  const statusLine = useActiveSession((s) => s.statusLine)
  const effort = useActiveSession((s) => s.effort)
  const setEffort = useSessionStore((s) => s.setEffort)

  useEffect(() => {
    window.api.getModels().then(setAvailableModels)
  }, [setAvailableModels])

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
    if (!prompt || isDisabled || !activeSessionId) return

    // Check historical state BEFORE adding user message, otherwise the
    // newly added message makes messages.length > 0 and misidentifies
    // a brand-new session as historical (causing "No conversation found" error).
    let needsSdkCreate = false
    let resumeId: string | undefined
    if (!sdkActive) {
      const { sessions } = useSessionStore.getState()
      const session = sessions[activeSessionId]
      const isHistorical = session && session.messages.length > 0 && !session.sdkActive
      resumeId = isHistorical ? activeSessionId : undefined
      needsSdkCreate = true
    }

    addUserMessage(activeSessionId, uuid(), prompt)
    setText('')
    if (textareaRef.current) textareaRef.current.style.height = 'auto'

    // Lazy SDK creation: create session on first message
    if (needsSdkCreate) {
      const { sessions } = useSessionStore.getState()
      const session = sessions[activeSessionId]
      await window.api.createSession(activeSessionId, session?.cwd || '', session?.effort ?? 'medium', resumeId, session?.permissionMode)
      markSdkActive(activeSessionId)
    }

    await window.api.sendPrompt(activeSessionId, prompt)
  }, [text, isDisabled, activeSessionId, addUserMessage, sdkActive, markSdkActive])

  const handleCancel = useCallback(async () => {
    if (activeSessionId) {
      await window.api.cancelSession(activeSessionId)
    }
  }, [activeSessionId])

  const handleKeyDown = (e: React.KeyboardEvent): void => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      handleSend()
    }
    if (e.key === 'Escape' && isRunning) handleCancel()
  }

  // Resize textarea when switching sessions (draft text changes)
  useEffect(() => {
    const el = textareaRef.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = Math.min(el.scrollHeight, 200) + 'px'
  }, [text])

  const handleInput = (e: React.ChangeEvent<HTMLTextAreaElement>): void => {
    setText(e.target.value)
    const el = e.target
    el.style.height = 'auto'
    el.style.height = Math.min(el.scrollHeight, 200) + 'px'
  }

  return (
    <div style={{ padding: '8px 13px 16px' }} className="shrink-0">
      <div className="max-w-[740px] mx-auto">
        <div
          onClick={() => { setModelOpen(false); setEffortOpen(false); setPlusOpen(false); }}
          className={`group relative rounded-2xl bg-bg-input transition-colors ${
            permissionMode === 'acceptEdits'
              ? 'border border-mode-edit-dim focus-within:border-mode-edit'
              : permissionMode === 'plan'
                ? 'border border-mode-plan-dim focus-within:border-mode-plan'
                : 'shadow-[0_1px_6px_rgba(0,0,0,0.12),0_2px_16px_rgba(0,0,0,0.08)] focus-within:shadow-[0_1px_8px_rgba(0,0,0,0.18),0_4px_20px_rgba(0,0,0,0.12)]'
          }`}
        >
          {/* Mode tab */}
          {permissionMode !== 'default' && (
            <div
              className={`absolute bottom-full left-3 px-1.5 pt-0.5 pb-px rounded-t text-[9px] font-semibold tracking-wider uppercase text-text-primary border border-b-0 transition-colors ${
                permissionMode === 'acceptEdits'
                  ? 'border-mode-edit-dim group-focus-within:border-mode-edit bg-mode-edit-dim group-focus-within:bg-mode-edit'
                  : 'border-mode-plan-dim group-focus-within:border-mode-plan bg-mode-plan-dim group-focus-within:bg-mode-plan'
              }`}
            >
              {permissionMode === 'acceptEdits' ? 'Accept Edits' : 'Plan'}
            </div>
          )}

          {/* Top section — input area */}
          <textarea
            ref={textareaRef}
            value={text}
            onChange={handleInput}
            onKeyDown={handleKeyDown}
            onMouseDown={() => { setModelOpen(false); setEffortOpen(false); setPlusOpen(false); }}
            placeholder={
              !activeSessionId || !cwd
                ? 'Select a folder to get started'
                : isRunning
                  ? 'Claude is working...'
                  : 'Ask Claude anything, / for commands'
            }
            disabled={isDisabled}
            rows={2}
            className="w-full bg-transparent text-[13px] text-text-primary placeholder:text-text-muted pt-2 pl-3 pr-2 pb-1 resize-none outline-none disabled:opacity-30 leading-relaxed"
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
                  <span>{selectedModel.shortName}</span>
                  <svg width="8" height="8" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                    <polyline points="6 9 12 15 18 9" />
                  </svg>
                </button>
                {modelOpen && (
                  <div className="absolute bottom-full mb-1 left-0 w-56 bg-bg-tertiary border border-border rounded-lg overflow-hidden shadow-lg shadow-black/30 z-20">
                    {models.map((m) => (
                      <button
                        key={m.value}
                        onClick={() => {
                          setSelectedModel(m.value)
                          if (activeSessionId) window.api.setModel(activeSessionId, m.value)
                          setModelOpen(false)
                        }}
                        className={`w-full flex flex-col px-3 py-1.5 transition-colors cursor-pointer text-left ${
                          m.value === selectedModel.value
                            ? 'text-text-primary bg-bg-hover'
                            : 'text-text-secondary hover:bg-bg-hover hover:text-text-primary'
                        }`}
                      >
                        <span className="text-[12px]">{m.shortName}</span>
                        {m.description && (
                          <span className="text-text-muted text-[10px]">{m.description.split('·')[1]?.trim()}</span>
                        )}
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
                  className="h-7 px-2 flex items-center gap-1 rounded-lg text-[11px] text-text-muted hover:text-text-secondary hover:bg-bg-hover transition-colors cursor-pointer capitalize"
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
                        onClick={async () => {
                          setEffort(level)
                          setEffortOpen(false)
                          if (activeSessionId && sdkActive) {
                            await window.api.cancelSession(activeSessionId)
                            const { sessions } = useSessionStore.getState()
                            const session = sessions[activeSessionId]
                            await window.api.createSession(activeSessionId, session?.cwd || '', level, activeSessionId, session?.permissionMode)
                            await window.api.setModel(activeSessionId, session?.selectedModel ?? 'default')
                            markSdkActive(activeSessionId)
                          }
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
        {statusLine && <StatusLine data={statusLine} />}
      </div>
    </div>
  )
}
