import { useState, useRef, useCallback, useEffect, useMemo } from 'react'
import { useSessionStore, useActiveSession } from '../../../stores/session-store'
import type { FileAttachment, VoiceState as VoiceStateType } from '../../../../../shared/types'
import { v4 as uuid } from 'uuid'
import { resolveSendAction } from './utils'
import { useSlashMenu } from '../../../hooks/useSlashMenu'
import { mergeSlashCommands } from '../SlashCommandMenu'
import { useFileMention } from '../../../hooks/useFileMention'
import { useIsMobile } from '../../../hooks/useIsMobile'
import { InputBoxView } from './View'
import {
  modelSupportsAdaptiveThinking,
  modelSupportsEffort,
  modelSupportedEffortLevels,
  modelResolveThinkingMode,
  modelResolveEffort,
  modelDefaultEffort,
  modelDefaultThinkingMode,
  type EffortLevel,
  type ThinkingMode,
} from '../../../../../shared/model-capabilities'

const ACCEPTED_IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/gif', 'image/webp']
const ACCEPTED_FILE_TYPES = [...ACCEPTED_IMAGE_TYPES, 'application/pdf']
const MAX_IMAGE_DIMENSION = 2048

function processImageFile(file: File): Promise<{ mediaType: string; base64Data: string }> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onerror = reject
    reader.onload = (): void => {
      const dataUrl = reader.result as string
      const [header, base64Raw] = dataUrl.split(',')
      const mediaType = header.match(/data:(.*?);/)?.[1] || 'image/png'

      const img = new Image()
      img.onload = (): void => {
        const { width, height } = img
        if (width <= MAX_IMAGE_DIMENSION && height <= MAX_IMAGE_DIMENSION && file.size <= 4 * 1024 * 1024) {
          resolve({ mediaType, base64Data: base64Raw })
          return
        }
        const scale = Math.min(MAX_IMAGE_DIMENSION / width, MAX_IMAGE_DIMENSION / height, 1)
        const canvas = document.createElement('canvas')
        canvas.width = Math.round(width * scale)
        canvas.height = Math.round(height * scale)
        const ctx = canvas.getContext('2d')!
        ctx.drawImage(img, 0, 0, canvas.width, canvas.height)
        const resizedDataUrl = canvas.toDataURL('image/jpeg', 0.85)
        const resizedBase64 = resizedDataUrl.split(',')[1]
        resolve({ mediaType: 'image/jpeg', base64Data: resizedBase64 })
      }
      img.onerror = (): void => reject(new Error('Failed to load image'))
      img.src = dataUrl
    }
    reader.readAsDataURL(file)
  })
}

function readFileAsBase64(file: File): Promise<{ mediaType: string; base64Data: string }> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onerror = reject
    reader.onload = (): void => {
      const dataUrl = reader.result as string
      const [header, base64Data] = dataUrl.split(',')
      const mediaType = header.match(/data:(.*?);/)?.[1] || file.type
      resolve({ mediaType, base64Data })
    }
    reader.readAsDataURL(file)
  })
}

// ---------------------------------------------------------------------------
// InputBox — logic layer, provides context to InputBoxView
// ---------------------------------------------------------------------------

export function InputBox(): React.JSX.Element {
  const isMobile = useIsMobile()
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const activeSessionId = useSessionStore((s) => s.activeSessionId)
  const text = useActiveSession((s) => s.draftText)
  const setDraftText = useSessionStore((s) => s.setDraftText)
  const setText = setDraftText

  const cwd = useActiveSession((s) => s.cwd)
  const status = useActiveSession((s) => s.status)
  const sdkActive = useActiveSession((s) => s.sdkActive)
  const markSdkActive = useSessionStore((s) => s.markSdkActive)
  const queuedText = useActiveSession((s) => s.queuedText)
  const clearQueuedText = useSessionStore((s) => s.clearQueuedText)
  const consumeQueuedText = useSessionStore((s) => s.consumeQueuedText)
  const isRunning = status.state === 'running'
  const isDisabled = !activeSessionId || !cwd

  const permissionMode = useActiveSession((s) => s.permissionMode)

  const [attachedFiles, setAttachedFiles] = useState<FileAttachment[]>([])

  // Slash command autocomplete — merge SDK commands with filesystem-scanned custom commands
  const slashCommands = useSessionStore((s) => s.slashCommands)
  const customCommands = useSessionStore((s) => s.customCommands)
  const setCustomCommands = useSessionStore((s) => s.setCustomCommands)
  const mergedSlashCommands = useMemo(
    () => mergeSlashCommands(slashCommands, customCommands),
    [slashCommands, customCommands]
  )

  // Eagerly scan custom commands when cwd changes
  useEffect(() => {
    if (!cwd) return
    window.api.scanCustomCommands(cwd).then((names) => {
      setCustomCommands(names.map((name) => ({ name })))
    }).catch(() => { /* scanner failed — keep existing commands */ })
  }, [cwd, setCustomCommands])

  const {
    slashMenuOpen,
    slashMenuIndex,
    slashFilter,
    filteredCommands: filteredSlashCommands,
    handleInputChange: slashHandleInput,
    handleKeyDown: slashHandleKeyDown,
    handleSelect: handleSlashSelect
  } = useSlashMenu({ slashCommands: mergedSlashCommands, text, setText, textareaRef })

  // @ file mention autocomplete
  const {
    fileMentionOpen,
    fileMentionIndex,
    filteredEntries: filteredFileMentionEntries,
    handleInputChange: fileMentionHandleInput,
    handleKeyDown: fileMentionHandleKeyDown,
    handleConfirm: handleFileMentionConfirm
  } = useFileMention({ cwd, text, setText, textareaRef })

  const availableModels = useSessionStore((s) => s.availableModels)
  const setAvailableModels = useSessionStore((s) => s.setAvailableModels)
  const models = useMemo(() => availableModels.map((m) => {
    const shortName = m.description?.split('·')[0]?.trim() || m.displayName
    return { ...m, shortName }
  }), [availableModels])
  const selectedModelValue = useActiveSession((s) => s.selectedModel)
  const setSelectedModel = useSessionStore((s) => s.setSelectedModel)
  const selectedModel = models.find((m) => m.value === selectedModelValue) || models[0] || { value: 'default', displayName: 'Default', shortName: 'Default', description: '' }
  const statusLine = useActiveSession((s) => s.statusLine)
  const effort = useActiveSession((s) => s.effort)
  const setEffort = useSessionStore((s) => s.setEffort)
  const thinkingMode = useActiveSession((s) => s.thinkingMode)
  const setThinkingMode = useSessionStore((s) => s.setThinkingMode)
  const sandboxEnabled = useSessionStore((s) => s.settings.sandbox.enabled)

  // Voice input
  const voiceEnabled = useSessionStore((s) => s.settings.voiceEnabled)
  const voiceLanguage = useSessionStore((s) => s.settings.voiceLanguage)
  const voiceState = useActiveSession((s) => s.voiceState) as VoiceStateType
  const voiceInterimTranscript = useActiveSession((s) => s.voiceInterimTranscript)
  const clearVoiceTranscript = useSessionStore((s) => s.clearVoiceTranscript)

  useEffect(() => {
    window.api.getModels().then(setAvailableModels)
  }, [setAvailableModels])

  useEffect(() => {
    if (!isRunning) textareaRef.current?.focus()
  }, [isRunning])

  // --- Handlers ---

  /**
   * Resolve the effort + thinking values to send to the SDK for a given
   * session. Falls back to the model's default when the user hasn't
   * explicitly picked a value (store value is `null`), and coerces any
   * unsupported user choice against the current model's capabilities.
   */
  function resolveSessionSdkOptions(routingId: string): {
    effort: EffortLevel
    thinkingMode: ThinkingMode
  } {
    const state = useSessionStore.getState()
    const session = state.sessions[routingId]
    const modelInfo = state.availableModels.find((m) => m.value === session?.selectedModel)
    const desiredThinking: ThinkingMode = session?.thinkingMode ?? modelDefaultThinkingMode(modelInfo)
    const desiredEffort: EffortLevel = session?.effort ?? modelDefaultEffort(modelInfo)
    return {
      effort: modelResolveEffort(modelInfo, desiredEffort) ?? desiredEffort,
      thinkingMode: modelResolveThinkingMode(modelInfo, desiredThinking),
    }
  }

  const doSend = useCallback(async (prompt: string, attachments?: Array<{ mediaType: string; base64Data: string; fileName?: string }>) => {
    if (!activeSessionId) return
    if (!sdkActive) {
      const { sessions } = useSessionStore.getState()
      const session = sessions[activeSessionId]
      const isHistorical = session && session.messages.length > 0
      const resumeId = isHistorical ? activeSessionId : undefined
      const opts = resolveSessionSdkOptions(activeSessionId)
      await window.api.createSession(activeSessionId, session?.cwd || '', opts.effort, resumeId, session?.permissionMode, session?.selectedModel, opts.thinkingMode)
      markSdkActive(activeSessionId)
    }
    await window.api.sendPrompt(activeSessionId, prompt, attachments)
  }, [activeSessionId, sdkActive, markSdkActive])

  const ensureSession = useCallback(async () => {
    if (!activeSessionId) return
    if (!sdkActive) {
      const { sessions } = useSessionStore.getState()
      const session = sessions[activeSessionId]
      const isHistorical = session && session.messages.length > 0 && !session.sdkActive
      const resumeId = isHistorical ? activeSessionId : undefined
      const opts = resolveSessionSdkOptions(activeSessionId)
      await window.api.createSession(activeSessionId, session?.cwd || '', opts.effort, resumeId, session?.permissionMode, session?.selectedModel, opts.thinkingMode)
      markSdkActive(activeSessionId)
    }
  }, [activeSessionId, sdkActive, markSdkActive])

  const handleVoiceStart = useCallback(async () => {
    if (!activeSessionId || isDisabled || voiceState !== 'idle') return
    try {
      await ensureSession()
      await window.api.voiceStartRecording(activeSessionId, voiceLanguage)
    } catch (err) {
      window.api.logRelay('error', 'Voice:InputBox', `voiceStartRecording failed: ${err}`)
    }
  }, [activeSessionId, isDisabled, voiceState, ensureSession, voiceLanguage])

  const handleVoiceStop = useCallback(async () => {
    if (!activeSessionId) return
    await window.api.voiceStopRecording(activeSessionId)
  }, [activeSessionId])

  useEffect(() => {
    if (voiceInterimTranscript && voiceState === 'idle' && activeSessionId) {
      const existing = text.trimEnd()
      setText(existing ? existing + ' ' + voiceInterimTranscript : voiceInterimTranscript)
      clearVoiceTranscript(activeSessionId)
      textareaRef.current?.focus()
    }
  }, [voiceState, voiceInterimTranscript, activeSessionId, clearVoiceTranscript, text, setText])

  // Not wrapped in useCallback: deps include `text`, which changes on every
  // keystroke, so memoization gives no benefit. View is unmemoized too.
  const handleSend = async (): Promise<void> => {
    const action = resolveSendAction({
      text, attachedFiles, isDisabled, activeSessionId, isRunning,
    })
    if (action.type === 'noop') return

    setText('')
    if (attachedFiles.length > 0) setAttachedFiles([])
    if (textareaRef.current) textareaRef.current.style.height = 'auto'

    switch (action.type) {
      case 'side-question': {
        const { setBtwQuestion, setBtwResponse } = useSessionStore.getState()
        setBtwQuestion(activeSessionId!, action.question)
        window.api.askSideQuestion(activeSessionId!, action.question).then((response) => {
          setBtwResponse(activeSessionId!, response)
        }).catch(() => {
          setBtwResponse(activeSessionId!, null)
        })
        return
      }
      case 'clear-session': {
        const { sessions, createNewSession } = useSessionStore.getState()
        const session = sessions[activeSessionId!]
        if (session) createNewSession(uuid(), session.cwd)
        return
      }
      case 'queue-prompt': {
        await window.api.sendPrompt(activeSessionId!, action.prompt)
        return
      }
      case 'send-prompt': {
        await doSend(action.prompt, action.attachments)
        return
      }
    }
  }

  const prevRunningRef = useRef(false)
  useEffect(() => {
    const wasRunning = prevRunningRef.current
    prevRunningRef.current = isRunning
    if (wasRunning && !isRunning && queuedText) {
      consumeQueuedText(activeSessionId!)
    }
  }, [isRunning, queuedText, activeSessionId, consumeQueuedText])

  const handleEditQueued = useCallback(async () => {
    const savedText = queuedText
    if (!activeSessionId || !savedText) { clearQueuedText(); return }
    const result = await window.api.dequeueMessage(activeSessionId, savedText) as
      | { removed: number }
      | { response?: { removed?: number } }
      | null
      | undefined
    const removed =
      (result && 'response' in result ? result.response?.removed : undefined) ??
      (result && 'removed' in result ? result.removed : undefined) ??
      0
    if (removed > 0) {
      setText(savedText)
      clearQueuedText()
      requestAnimationFrame(() => {
        const el = textareaRef.current
        if (el) { el.focus(); el.style.height = 'auto'; el.style.height = Math.min(el.scrollHeight, 200) + 'px' }
      })
    } else {
      clearQueuedText()
    }
  }, [activeSessionId, queuedText, clearQueuedText, setText])

  const handleCancel = useCallback(async () => {
    if (activeSessionId) await window.api.interruptSession(activeSessionId)
  }, [activeSessionId])

  const handleKeyDown = (e: React.KeyboardEvent): void => {
    if (fileMentionHandleKeyDown(e)) return
    if (slashHandleKeyDown(e)) return
    if (e.key === 'ArrowUp' && !text && queuedText) { e.preventDefault(); handleEditQueued(); return }
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handleSend() }
    if (e.key === 'Escape' && isRunning) handleCancel()
    if (e.key === 'Tab' && !e.shiftKey && !e.ctrlKey && !e.altKey && !e.metaKey) {
      e.preventDefault()
      if (voiceEnabled && voiceState === 'idle' && !slashMenuOpen && !fileMentionOpen) handleVoiceStart()
    }
  }

  const handleKeyUp = (e: React.KeyboardEvent): void => {
    if (e.key === 'Tab' && (voiceState === 'recording' || voiceState === 'connecting')) {
      e.preventDefault(); handleVoiceStop()
    }
  }

  useEffect(() => {
    const el = textareaRef.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = Math.min(el.scrollHeight, 200) + 'px'
  }, [text, voiceInterimTranscript])

  const handleInput = (e: React.ChangeEvent<HTMLTextAreaElement>): void => {
    const value = e.target.value
    setText(value)
    const el = e.target
    el.style.height = 'auto'
    el.style.height = Math.min(el.scrollHeight, 200) + 'px'
    slashHandleInput(value)
    fileMentionHandleInput(value, el.selectionStart ?? value.length)
  }

  const addFiles = useCallback(async (files: File[]) => {
    const accepted = files.filter((f) => ACCEPTED_FILE_TYPES.includes(f.type))
    if (accepted.length === 0) return
    const newAttachments: FileAttachment[] = []
    for (const file of accepted) {
      try {
        const isPdf = file.type === 'application/pdf'
        const { mediaType, base64Data } = isPdf ? await readFileAsBase64(file) : await processImageFile(file)
        newAttachments.push({
          id: uuid(), fileName: file.name, fileType: isPdf ? 'pdf' : 'image',
          mediaType: mediaType as FileAttachment['mediaType'], base64Data,
          previewUrl: isPdf ? '' : `data:${mediaType};base64,${base64Data}`
        })
      } catch (err) {
        window.api.logError('InputBox', `Failed to process file ${file.name}: ${err}`)
      }
    }
    if (newAttachments.length > 0) setAttachedFiles((prev) => [...prev, ...newAttachments])
  }, [])

  const handleFileChange = useCallback(async (e: React.ChangeEvent<HTMLInputElement>) => {
    await addFiles(Array.from(e.target.files || []))
    if (fileInputRef.current) fileInputRef.current.value = ''
  }, [addFiles])

  const handlePaste = useCallback(async (e: React.ClipboardEvent) => {
    const imageItems = Array.from(e.clipboardData.items).filter((item) => item.type.startsWith('image/'))
    if (imageItems.length === 0) return
    e.preventDefault()
    await addFiles(imageItems.map((item) => item.getAsFile()).filter(Boolean) as File[])
  }, [addFiles])

  const removeFile = useCallback((id: string) => {
    setAttachedFiles((prev) => prev.filter((i) => i.id !== id))
  }, [])

  const handleSelectModel = useCallback((value: string) => {
    setSelectedModel(value)
    if (activeSessionId) window.api.setModel(activeSessionId, value)
    // Auto-coerce the user's explicit picks against the new model. Leave
    // `null` store values alone — they auto-track the new model's defaults.
    const state = useSessionStore.getState()
    const session = state.sessions[activeSessionId ?? '']
    const newModel = state.availableModels.find((m) => m.value === value)
    if (session?.thinkingMode !== null && session?.thinkingMode !== undefined) {
      const coerced = modelResolveThinkingMode(newModel, session.thinkingMode)
      if (coerced !== session.thinkingMode) setThinkingMode(coerced)
    }
    if (session?.effort !== null && session?.effort !== undefined) {
      const coerced = modelResolveEffort(newModel, session.effort)
      // Effort unsupported on new model → clear the user's pick (fall back to default).
      if (coerced === null) setEffort(null)
      else if (coerced !== session.effort) setEffort(coerced)
    }
  }, [activeSessionId, setSelectedModel, setThinkingMode, setEffort])

  // Effort and thinking mode are read at sdkQuery start time, so restart the
  // session (with resume) to apply changes mid-conversation.
  const restartSdkSession = useCallback(async () => {
    if (!activeSessionId || !sdkActive) return
    await window.api.cancelSession(activeSessionId)
    const { sessions } = useSessionStore.getState()
    const session = sessions[activeSessionId]
    const opts = resolveSessionSdkOptions(activeSessionId)
    await window.api.createSession(
      activeSessionId,
      session?.cwd || '',
      opts.effort,
      activeSessionId,
      session?.permissionMode,
      session?.selectedModel,
      opts.thinkingMode,
    )
    markSdkActive(activeSessionId)
  }, [activeSessionId, sdkActive, markSdkActive])

  const handleSelectEffort = useCallback(async (level: EffortLevel) => {
    setEffort(level)
    await restartSdkSession()
  }, [setEffort, restartSdkSession])

  const handleSelectThinking = useCallback(async (mode: ThinkingMode) => {
    setThinkingMode(mode)
    await restartSdkSession()
  }, [setThinkingMode, restartSdkSession])

  const handleOpenSandboxSettings = useCallback(() => {
    window.dispatchEvent(new CustomEvent('open-settings', { detail: { section: 'sandbox' } }))
  }, [])

  // --- Derived values for context ---

  const isVoiceActive = voiceState === 'recording' || voiceState === 'connecting' || voiceState === 'processing'

  const displayValue = isVoiceActive
    ? text + (voiceInterimTranscript ? (text && !text.endsWith(' ') ? ' ' : '') + voiceInterimTranscript : '')
    : text

  const placeholder = (voiceState === 'recording' || voiceState === 'connecting')
    ? 'Listening...'
    : voiceState === 'processing'
      ? 'Finishing transcription...'
      : !activeSessionId || !cwd
        ? 'Select a folder to get started'
        : isRunning
          ? 'Type to queue a message...'
          : 'Ask Claude anything, / for commands'

  const textClassName = isVoiceActive && voiceInterimTranscript
    ? 'text-[var(--text-secondary)] italic'
    : 'text-text-primary'

  const adaptiveSupported = useMemo(() => modelSupportsAdaptiveThinking(selectedModel), [selectedModel])
  const effortSupported = useMemo(() => modelSupportsEffort(selectedModel), [selectedModel])
  const allowedEffortLevels = useMemo(() => modelSupportedEffortLevels(selectedModel), [selectedModel])

  // Effective display values: show the user's explicit pick when set,
  // otherwise fall back to the current model's default so new sessions
  // present the right tier (e.g. xhigh on Opus 4.7, high on Sonnet 4.6).
  const effectiveEffort = useMemo<EffortLevel>(
    () => effort ?? modelDefaultEffort(selectedModel),
    [effort, selectedModel],
  )
  const effectiveThinking = useMemo<ThinkingMode>(
    () => thinkingMode ?? modelDefaultThinkingMode(selectedModel),
    [thinkingMode, selectedModel],
  )

  return (
    <InputBoxView
      textareaRef={textareaRef} fileInputRef={fileInputRef} isMobile={isMobile}
      text={text} displayValue={displayValue} isDisabled={isDisabled} isRunning={isRunning}
      isVoiceActive={isVoiceActive} placeholder={placeholder} textClassName={textClassName}
      permissionMode={permissionMode}
      slashMenuOpen={slashMenuOpen} slashCommands={slashCommands} slashFilter={slashFilter}
      slashMenuIndex={slashMenuIndex} filteredSlashCommands={filteredSlashCommands}
      fileMentionOpen={fileMentionOpen} fileMentionIndex={fileMentionIndex}
      filteredFileMentionEntries={filteredFileMentionEntries}
      attachedFiles={attachedFiles}
      models={models} selectedModel={selectedModel} effort={effectiveEffort}
      effortSupported={effortSupported} allowedEffortLevels={allowedEffortLevels}
      thinkingMode={effectiveThinking} adaptiveSupported={adaptiveSupported}
      sandboxEnabled={sandboxEnabled} voiceEnabled={voiceEnabled} voiceState={voiceState}
      statusLine={statusLine}
      onSend={handleSend} onCancel={handleCancel}
      onInput={handleInput} onKeyDown={handleKeyDown} onKeyUp={handleKeyUp} onPaste={handlePaste}
      onFileChange={handleFileChange} onRemoveFile={removeFile}
      onSlashSelect={handleSlashSelect} onFileMentionConfirm={handleFileMentionConfirm}
      onSelectModel={handleSelectModel} onSelectEffort={handleSelectEffort} onSelectThinking={handleSelectThinking}
      onOpenSandboxSettings={handleOpenSandboxSettings}
      onVoiceStart={handleVoiceStart} onVoiceStop={handleVoiceStop}
    />
  )
}
