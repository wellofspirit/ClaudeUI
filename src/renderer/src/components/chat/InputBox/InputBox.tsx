import { useRef, useCallback, useEffect, useMemo } from 'react'
import {
  useSessionStore,
  useActiveSession,
  resolveOpencodeModel,
  bootstrapPermissionMode
} from '../../../stores/session-store'
import type { FileAttachment, VoiceState as VoiceStateType } from '../../../../../shared/types'
import { v4 as uuid } from 'uuid'
import { resolveSendAction, filterModelsForEngine } from './utils'
import { recallQueuedInto } from './recall-queued'
import { useSlashMenu } from '../../../hooks/useSlashMenu'
import { mergeSlashCommands } from '../SlashCommandMenu'
import { useFileMention } from '../../../hooks/useFileMention'
import { useIsMobile } from '../../../hooks/useIsMobile'
import { InputBoxView } from './View'
import { autoModeAvailableForEngine } from '../../../../../shared/permission-modes'
import type { PermissionMode } from '../../../../../shared/types'
import {
  claudeModelCapabilities,
  modelResolveThinkingMode,
  modelResolveEffort,
  modelDefaultEffort,
  modelDefaultThinkingMode,
  canonicalizeModelValue,
  type EffortLevel,
  type ThinkingMode
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
        if (
          width <= MAX_IMAGE_DIMENSION &&
          height <= MAX_IMAGE_DIMENSION &&
          file.size <= 4 * 1024 * 1024
        ) {
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

  // Capability gating — use status.capabilities (authoritative after spawn;
  // seeded from selectedEngineId before spawn via createNewSession).
  const capabilities = useActiveSession((s) => s.status.capabilities)

  const cwd = useActiveSession((s) => s.cwd)
  const status = useActiveSession((s) => s.status)
  const sdkActive = useActiveSession((s) => s.sdkActive)
  const markSdkActive = useSessionStore((s) => s.markSdkActive)
  const queuedItems = useActiveSession((s) => s.queuedItems)

  const isRunning = status.state === 'running'
  const isDisabled = !activeSessionId || !cwd

  // With a live session, its own mode. On welcome (no session yet), the mode
  // the session created from this input WILL start in — the same
  // bootstrapPermissionMode(state, engine) call createNewSession makes, keyed
  // by the engine the welcome picker has selected. Without this the input sat
  // unlabeled pre-session and then sprouted an "Auto ⏵⏵" tab the moment a
  // folder was picked, which read as the mode changing out from under you.
  const permissionMode = useSessionStore((s) => {
    const id = s.activeSessionId
    if (id && s.sessions[id]) return s.sessions[id].permissionMode
    return bootstrapPermissionMode(s, s.lastSelectedEngineId)
  })

  // Attachments live per-session in the store (mirrors draftText) so a file
  // attached in session A can never be sent from B, and is restored on return
  // to A (gpt#14). Async file reads apply to the session they were dropped into.
  const attachedFiles = useActiveSession((s) => s.draftAttachments)
  const addDraftAttachments = useSessionStore((s) => s.addDraftAttachments)
  const removeDraftAttachment = useSessionStore((s) => s.removeDraftAttachment)
  const setDraftAttachments = useSessionStore((s) => s.setDraftAttachments)

  // Slash command autocomplete — merge SDK commands with filesystem-scanned custom commands
  const slashCommands = useSessionStore((s) => s.slashCommands)
  const customCommands = useSessionStore((s) => s.customCommands)
  const setCustomCommands = useSessionStore((s) => s.setCustomCommands)
  // Slash-command menu is gated on capabilities.slashCommands: when the engine
  // doesn't support slash commands, the menu offers nothing (engine + filesystem
  // commands alike) and `/` types as literal text. Claude: true → unchanged.
  const mergedSlashCommands = useMemo(
    () => (capabilities.slashCommands ? mergeSlashCommands(slashCommands, customCommands) : []),
    [capabilities.slashCommands, slashCommands, customCommands]
  )

  // Eagerly scan custom commands when cwd changes
  useEffect(() => {
    if (!cwd) return
    window.api
      .scanCustomCommands(cwd)
      .then((names) => {
        setCustomCommands(names.map((name) => ({ name })))
      })
      .catch(() => {
        /* scanner failed — keep existing commands */
      })
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
  const models = useMemo(
    () =>
      availableModels.map((m) => {
        const shortName = m.description?.split('·')[0]?.trim() || m.displayName
        return { ...m, shortName }
      }),
    [availableModels]
  )
  const selectedModelValue = useActiveSession((s) => s.selectedModel)
  const setSelectedModel = useSessionStore((s) => s.setSelectedModel)
  const setSelectedEngine = useSessionStore((s) => s.setSelectedEngine)
  const lastSelectedEngineId = useSessionStore((s) => s.lastSelectedEngineId)
  const setLastSelectedEngineId = useSessionStore((s) => s.setLastSelectedEngineId)
  // Engine is immutable after backend commitment, so the picker disappears
  // once initialization starts. Historical sessions are committed by definition.
  const startedSessionId = useActiveSession((s) => s.status.sessionId)
  const isHistorical = useActiveSession((s) => s.isHistorical)
  const sessionEngineId = useActiveSession((s) => s.selectedEngineId)
  // On welcome, the picker controls the engine that createNewSession will seed.
  // Once a session exists, it always reflects that session's own engine instead.
  const effectiveEngineId = activeSessionId ? sessionEngineId : lastSelectedEngineId
  const engineLocked = sdkActive || !!startedSessionId || !!isHistorical
  const pickerModels = useMemo(
    () => filterModelsForEngine(models, effectiveEngineId),
    [models, effectiveEngineId]
  )
  // Memoized so its identity is stable across renders (it feeds several
  // downstream useMemo dependency lists). The fallback MUST stay within the
  // session's OWN engine — never surface a same-valued model from another
  // harness. For opencode use the same resolver the spawn path uses so display
  // == what will actually run.
  const opencodeDefaultModel = useSessionStore((s) => s.opencodeDefaultModel)
  const piDefaultModel = useSessionStore((s) => s.piDefaultModel)
  const selectedModel = useMemo(() => {
    const engine = effectiveEngineId ?? 'claude'
    const sameEngine = models.filter((m) => (m.engineId ?? 'claude') === engine)
    const exact = sameEngine.find((m) => m.value === selectedModelValue)
    if (exact) return exact
    if (engine === 'opencode') {
      const resolved = resolveOpencodeModel(models, opencodeDefaultModel)
      const m = resolved ? sameEngine.find((mm) => mm.value === resolved) : undefined
      if (m) return m
    }
    if (engine === 'pi') {
      // Mirror resolvePiSpawnModel's resolution ladder (requested → default →
      // first catalog): `exact` above already covers "requested", this covers
      // "default", and `sameEngine[0]` below covers "first catalog". Looking the
      // configured default up in `models` keeps display consistent with what
      // would actually spawn — never surfaces it if pi's catalog doesn't have it.
      const m = models.find(
        (mm) => mm.value === piDefaultModel && (mm.engineId ?? 'claude') === 'pi'
      )
      if (m) return m
    }
    return (
      sameEngine[0] || {
        value: selectedModelValue || 'default',
        displayName: engine === 'claude' ? 'Default' : 'Select a model',
        shortName: engine === 'claude' ? 'Default' : 'Select model',
        description: '',
        // Non-Claude synthetic fallback: without explicit flags,
        // claudeModelCapabilities' unknown-family heuristic (used for ALL
        // engines, see the `reasoning` memo below) would assume a modern Claude
        // model and paint the Adaptive-thinking + 5-tier effort pickers onto an
        // engine that never supports them (pi: only low/medium/high, ever
        // — see piModelCapabilities). Explicit false short-circuits the
        // heuristic entirely (modelSupports* trust a boolean flag over the
        // id-based guess).
        ...(engine === 'claude'
          ? {}
          : { engineId: engine, supportsAdaptiveThinking: false, supportsEffort: false })
      }
    )
  }, [models, effectiveEngineId, selectedModelValue, opencodeDefaultModel, piDefaultModel])

  const statusLine = useActiveSession((s) => s.statusLine)
  const billingType = useActiveSession((s) => s.status?.account?.billingType)
  const effort = useActiveSession((s) => s.effort)
  const setEffort = useSessionStore((s) => s.setEffort)
  const thinkingMode = useActiveSession((s) => s.thinkingMode)
  const setThinkingMode = useSessionStore((s) => s.setThinkingMode)
  const reasoningVariant = useActiveSession((s) => s.reasoningVariant)
  const setReasoningVariant = useSessionStore((s) => s.setReasoningVariant)
  const sandboxEnabled = useSessionStore((s) => s.engineConfig.sandbox?.enabled ?? false)

  // Voice input
  const voiceEnabled = useSessionStore((s) => s.settings.voiceEnabled)
  const voiceLanguage = useSessionStore((s) => s.settings.voiceLanguage)
  const voiceState = useActiveSession((s) => s.voiceState) as VoiceStateType
  const voiceInterimTranscript = useActiveSession((s) => s.voiceInterimTranscript)
  const clearVoiceTranscript = useSessionStore((s) => s.clearVoiceTranscript)

  // Load models from all engines via getEngineModels(). Re-fetches when cwd
  // changes, and whenever modelReloadNonce is bumped (e.g. an opencode provider
  // or default-model change in Settings) so newly-available models show up in
  // the picker without an app restart. Flattens EngineModelGroup[] → ModelInfo[]
  // (each entry has engineId/vendorId set).
  const modelReloadNonce = useSessionStore((s) => s.modelReloadNonce)
  const loadedModelsKey = useRef<string | null>(null)
  useEffect(() => {
    const key = cwd ?? ''
    if (loadedModelsKey.current !== null && loadedModelsKey.current !== key) {
      setAvailableModels([])
    }
    loadedModelsKey.current = key

    let ignore = false
    window.api
      .getEngineModels()
      .then((groups) => {
        if (!ignore) {
          const flat = groups.flatMap((g) => g.models)
          setAvailableModels(flat)
        }
      })
      .catch(() => {
        // Fallback to Claude-only models if getEngineModels fails
        window.api
          .getModels()
          .then((models) => {
            if (!ignore) setAvailableModels(models)
          })
          .catch(() => {
            /* non-fatal */
          })
      })
    return () => {
      ignore = true
    }
  }, [cwd, modelReloadNonce, setAvailableModels])

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
    const engineId = session?.selectedEngineId ?? 'claude'
    const modelInfo = state.availableModels.find(
      (m) => m.value === session?.selectedModel && (m.engineId ?? 'claude') === engineId
    )
    const desiredThinking: ThinkingMode =
      session?.thinkingMode ?? modelDefaultThinkingMode(modelInfo)
    // Effort precedence: explicit per-session pick > per-model user default > cli.js heuristic.
    const userDefault =
      state.settings.modelEffortDefaults?.[canonicalizeModelValue(modelInfo?.value)]
    const desiredEffort: EffortLevel =
      session?.effort ?? userDefault ?? modelDefaultEffort(modelInfo)
    return {
      effort: modelResolveEffort(modelInfo, desiredEffort) ?? desiredEffort,
      thinkingMode: modelResolveThinkingMode(modelInfo, desiredThinking)
    }
  }

  const doSend = useCallback(
    async (
      prompt: string,
      attachments?: Array<{ mediaType: string; base64Data: string; fileName?: string }>
    ) => {
      if (!activeSessionId) return
      if (!sdkActive) {
        const { sessions } = useSessionStore.getState()
        const session = sessions[activeSessionId]
        const opts = resolveSessionSdkOptions(activeSessionId)
        const fork = session?.forkOrigin
        if (fork) {
          // Branch: resume the SOURCE session, truncated to the anchor, forked into
          // a fresh UUID. cli.js mints the new id and we rekey to it on first init.
          await window.api.createSession(
            activeSessionId,
            session?.cwd || '',
            opts.effort,
            fork.sourceSessionId,
            session?.permissionMode,
            session?.selectedModel,
            opts.thinkingMode,
            fork.anchorUuid,
            true,
            session?.selectedEngineId
          )
        } else {
          const isHistorical = session && session.messages.length > 0
          // For opencode sessions, always pass the routingId as resumeSessionId so
          // OpencodeSession can resume a prior session even when messages are empty
          // (history is replayed from the server, not preloaded into the store).
          // OpencodeSession.run() verifies the id via getSession and falls back to
          // createSession if it doesn't exist (e.g. first-ever prompt on that slot).
          const isOpencode = session?.selectedEngineId === 'opencode'
          const resumeId = isHistorical || isOpencode ? activeSessionId : undefined
          await window.api.createSession(
            activeSessionId,
            session?.cwd || '',
            opts.effort,
            resumeId,
            session?.permissionMode,
            session?.selectedModel,
            opts.thinkingMode,
            undefined,
            undefined,
            session?.selectedEngineId
          )
        }
        markSdkActive(activeSessionId)
      }
      await window.api.sendPrompt(activeSessionId, prompt, attachments)
    },
    [activeSessionId, sdkActive, markSdkActive]
  )

  const ensureSession = useCallback(async () => {
    if (!activeSessionId) return
    if (!sdkActive) {
      const { sessions } = useSessionStore.getState()
      const session = sessions[activeSessionId]
      const opts = resolveSessionSdkOptions(activeSessionId)
      const fork = session?.forkOrigin
      if (fork) {
        await window.api.createSession(
          activeSessionId,
          session?.cwd || '',
          opts.effort,
          fork.sourceSessionId,
          session?.permissionMode,
          session?.selectedModel,
          opts.thinkingMode,
          fork.anchorUuid,
          true,
          session?.selectedEngineId
        )
      } else {
        const isHistorical = session && session.messages.length > 0 && !session.sdkActive
        const resumeId = isHistorical ? activeSessionId : undefined
        await window.api.createSession(
          activeSessionId,
          session?.cwd || '',
          opts.effort,
          resumeId,
          session?.permissionMode,
          session?.selectedModel,
          opts.thinkingMode,
          undefined,
          undefined,
          session?.selectedEngineId
        )
      }
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
      text,
      attachedFiles,
      isDisabled,
      activeSessionId,
      isRunning,
      sideQuestionEnabled: capabilities.sideQuestion,
      queueEnabled: capabilities.queue
    })
    if (action.type === 'noop') return

    const clearInput = (): void => {
      setText('')
      if (activeSessionId) setDraftAttachments(activeSessionId, [])
      if (textareaRef.current) textareaRef.current.style.height = 'auto'
    }

    switch (action.type) {
      case 'side-question': {
        clearInput()
        const { setBtwQuestion, setBtwResponse } = useSessionStore.getState()
        setBtwQuestion(activeSessionId!, action.question)
        window.api
          .askSideQuestion(activeSessionId!, action.question)
          .then((response) => {
            setBtwResponse(activeSessionId!, response)
          })
          .catch(() => {
            setBtwResponse(activeSessionId!, null)
          })
        return
      }
      case 'clear-session': {
        clearInput()
        const { sessions, createNewSession } = useSessionStore.getState()
        const session = sessions[activeSessionId!]
        if (session) createNewSession(uuid(), session.cwd)
        return
      }
      case 'queue-prompt':
      case 'send-prompt': {
        // Clear the input only AFTER the send resolves. On failure (remote
        // disconnect, spawn error) the draft + attachments are left intact and
        // the error surfaced, so the prompt is never silently lost (gpt#15).
        const sessionId = activeSessionId!
        try {
          if (action.type === 'queue-prompt') {
            await window.api.sendPrompt(sessionId, action.prompt, action.attachments)
          } else {
            await doSend(action.prompt, action.attachments)
          }
        } catch (err) {
          useSessionStore.getState().addError(sessionId, `Failed to send message: ${err}`)
          return
        }
        // Only clear the textarea if the user is still on this session; always
        // clear the attachments of the session the send targeted.
        if (useSessionStore.getState().activeSessionId === sessionId) {
          setText('')
          if (textareaRef.current) textareaRef.current.style.height = 'auto'
        }
        setDraftAttachments(sessionId, [])
        return
      }
    }
  }

  const handleEditQueued = useCallback(async () => {
    await recallQueuedInto(activeSessionId, setText)
    requestAnimationFrame(() => {
      const el = textareaRef.current
      if (el) {
        el.focus()
        el.style.height = 'auto'
        el.style.height = Math.min(el.scrollHeight, 200) + 'px'
      }
    })
  }, [activeSessionId, setText])

  const handleCancel = useCallback(async () => {
    if (activeSessionId) await window.api.interruptSession(activeSessionId)
  }, [activeSessionId])

  const handleKeyDown = (e: React.KeyboardEvent): void => {
    if (fileMentionHandleKeyDown(e)) return
    if (slashHandleKeyDown(e)) return
    if (e.key === 'ArrowUp' && !text && queuedItems.length > 0) {
      e.preventDefault()
      handleEditQueued()
      return
    }
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      handleSend()
    }
    if (e.key === 'Escape' && isRunning) handleCancel()
    if (e.key === 'Tab' && !e.shiftKey && !e.ctrlKey && !e.altKey && !e.metaKey) {
      e.preventDefault()
      if (voiceEnabled && voiceState === 'idle' && !slashMenuOpen && !fileMentionOpen)
        handleVoiceStart()
    }
  }

  const handleKeyUp = (e: React.KeyboardEvent): void => {
    if (e.key === 'Tab' && (voiceState === 'recording' || voiceState === 'connecting')) {
      e.preventDefault()
      handleVoiceStop()
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

  // Single funnel for both the attach-menu file picker and clipboard paste.
  // Gated on capabilities.vision so engines/models without image input can't
  // attach via either path (the AttachMenu button is also hidden in View).
  const visionEnabled = capabilities.vision
  const addFiles = useCallback(
    async (files: File[]) => {
      if (!visionEnabled || !activeSessionId) return
      // Capture the target session NOW: file reads are async and the user may
      // switch sessions before they finish. The finished attachments land on the
      // session they were dropped into, never the now-active one (gpt#14).
      const targetSessionId = activeSessionId
      const accepted = files.filter((f) => ACCEPTED_FILE_TYPES.includes(f.type))
      if (accepted.length === 0) return
      const newAttachments: FileAttachment[] = []
      for (const file of accepted) {
        try {
          const isPdf = file.type === 'application/pdf'
          const { mediaType, base64Data } = isPdf
            ? await readFileAsBase64(file)
            : await processImageFile(file)
          newAttachments.push({
            id: uuid(),
            fileName: file.name,
            fileType: isPdf ? 'pdf' : 'image',
            mediaType: mediaType as FileAttachment['mediaType'],
            base64Data,
            previewUrl: isPdf ? '' : `data:${mediaType};base64,${base64Data}`
          })
        } catch (err) {
          window.api.logError('InputBox', `Failed to process file ${file.name}: ${err}`)
        }
      }
      if (newAttachments.length > 0) addDraftAttachments(targetSessionId, newAttachments)
    },
    [visionEnabled, activeSessionId, addDraftAttachments]
  )

  const handleFileChange = useCallback(
    async (e: React.ChangeEvent<HTMLInputElement>) => {
      await addFiles(Array.from(e.target.files || []))
      if (fileInputRef.current) fileInputRef.current.value = ''
    },
    [addFiles]
  )

  const handlePaste = useCallback(
    async (e: React.ClipboardEvent) => {
      const imageItems = Array.from(e.clipboardData.items).filter((item) =>
        item.type.startsWith('image/')
      )
      if (imageItems.length === 0) return
      e.preventDefault()
      await addFiles(imageItems.map((item) => item.getAsFile()).filter(Boolean) as File[])
    },
    [addFiles]
  )

  const removeFile = useCallback(
    (id: string) => {
      if (activeSessionId) removeDraftAttachment(activeSessionId, id)
    },
    [activeSessionId, removeDraftAttachment]
  )

  const handleSelectModel = useCallback(
    (value: string) => {
      const state = useSessionStore.getState()
      const session = state.sessions[activeSessionId ?? '']
      const selectedEngine = session?.selectedEngineId ?? 'claude'
      const newModel = state.availableModels.find(
        (m) => m.value === value && (m.engineId ?? 'claude') === selectedEngine
      )
      setSelectedModel(value)

      // A "started" session has a backend sessionId. Only push a live model
      // switch to the backend for an already committed same-engine session.
      const started = !!session?.status.sessionId
      if (activeSessionId && started) {
        window.api.setModel(activeSessionId, value)
      }

      // Auto-coerce the user's explicit picks against the new model. Leave
      // `null` store values alone — they auto-track the new model's defaults.
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
      // Reset reasoning variant — the new model has different variants.
      // setSelectedModel already resets it in the store; also notify the backend.
      if (activeSessionId && started) {
        window.api.setReasoningVariant(activeSessionId, null)
      }
    },
    [activeSessionId, setSelectedModel, setThinkingMode, setEffort]
  )

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
      undefined,
      undefined,
      session?.selectedEngineId
    )
    markSdkActive(activeSessionId)
  }, [activeSessionId, sdkActive, markSdkActive])

  const handleSelectEffort = useCallback(
    async (level: EffortLevel) => {
      setEffort(level)
      await restartSdkSession()
    },
    [setEffort, restartSdkSession]
  )

  const handleSelectReasoningVariant = useCallback(
    (variant: string | null) => {
      setReasoningVariant(variant)
      if (activeSessionId) {
        window.api.setReasoningVariant(activeSessionId, variant)
      }
    },
    [activeSessionId, setReasoningVariant]
  )

  const handleSelectThinking = useCallback(
    async (mode: ThinkingMode) => {
      setThinkingMode(mode)
      await restartSdkSession()
    },
    [setThinkingMode, restartSdkSession]
  )

  const handleOpenSandboxSettings = useCallback(() => {
    window.dispatchEvent(new CustomEvent('open-settings', { detail: { section: 'sandbox' } }))
  }, [])

  // Mobile mode picker (MobileConfigSheet) — mirrors the desktop Shift+Tab
  // gates in SessionView so both surfaces agree on what's selectable. Hidden
  // pre-session: the welcome screen has no session to target (Shift+Tab
  // early-returns there too).
  const showModePicker = !!activeSessionId
  const canPlan = capabilities.plan ?? true
  const autoAvailable = useMemo(
    () => autoModeAvailableForEngine(sessionEngineId ?? effectiveEngineId, models),
    [sessionEngineId, effectiveEngineId, models]
  )
  const handleSelectMode = useCallback(
    (mode: PermissionMode) => {
      if (activeSessionId) useSessionStore.getState().changePermissionMode(activeSessionId, mode)
    },
    [activeSessionId]
  )

  // --- Derived values for context ---

  const isVoiceActive =
    voiceState === 'recording' || voiceState === 'connecting' || voiceState === 'processing'

  const displayValue = isVoiceActive
    ? text +
      (voiceInterimTranscript
        ? (text && !text.endsWith(' ') ? ' ' : '') + voiceInterimTranscript
        : '')
    : text

  const placeholder =
    voiceState === 'recording' || voiceState === 'connecting'
      ? 'Listening...'
      : voiceState === 'processing'
        ? 'Finishing transcription...'
        : !activeSessionId || !cwd
          ? 'Select a folder to get started'
          : isRunning
            ? 'Type to queue a message...'
            : 'Ask Claude anything, / for commands'

  const textClassName =
    isVoiceActive && voiceInterimTranscript
      ? 'text-[var(--text-secondary)] italic'
      : 'text-text-primary'

  // Reasoning controls are derived through the SAME normalizer that builds the
  // session's ResolvedCapabilities (claudeModelCapabilities, 02 §3.2 single
  // source of truth) — but keyed on the dropdown's `selectedModel` (a ModelInfo
  // carrying authoritative SDK capability fields) so the pickers track the
  // user's model selection live, before any spawn/setModel round-trip. No
  // parallel modelSupports* derivation here.
  const reasoning = useMemo(() => claudeModelCapabilities(selectedModel).reasoning, [selectedModel])
  const thinkingCap = reasoning.thinking
  const effortCap = reasoning.effort

  // opencode per-model reasoning variant picker: derived from the selected
  // model's reasoningVariants (populated by model-discovery). Claude models have
  // none → empty array → picker hidden.
  const reasoningVariants = useMemo(() => selectedModel.reasoningVariants ?? [], [selectedModel])
  const adaptiveSupported = !!thinkingCap?.modes.includes('adaptive')
  const allowedEffortLevels = useMemo(() => effortCap?.levels ?? [], [effortCap])

  // Effective display values: show the user's explicit pick when set,
  // otherwise fall back to the current model's default so new sessions
  // present the right tier (e.g. xhigh on Opus 4.7, high on Sonnet 4.6).
  const effectiveEffort = useMemo<EffortLevel>(
    () => effort ?? modelDefaultEffort(selectedModel),
    [effort, selectedModel]
  )
  const effectiveThinking = useMemo<ThinkingMode>(
    () => thinkingMode ?? modelDefaultThinkingMode(selectedModel),
    [thinkingMode, selectedModel]
  )

  return (
    <InputBoxView
      textareaRef={textareaRef}
      fileInputRef={fileInputRef}
      isMobile={isMobile}
      text={text}
      displayValue={displayValue}
      isDisabled={isDisabled}
      isRunning={isRunning}
      isVoiceActive={isVoiceActive}
      placeholder={placeholder}
      textClassName={textClassName}
      permissionMode={permissionMode}
      showModePicker={showModePicker}
      canPlan={canPlan}
      autoAvailable={autoAvailable}
      slashMenuOpen={slashMenuOpen}
      slashCommands={mergedSlashCommands}
      slashFilter={slashFilter}
      slashMenuIndex={slashMenuIndex}
      filteredSlashCommands={filteredSlashCommands}
      fileMentionOpen={fileMentionOpen}
      fileMentionIndex={fileMentionIndex}
      filteredFileMentionEntries={filteredFileMentionEntries}
      attachedFiles={attachedFiles}
      models={pickerModels}
      selectedModel={selectedModel}
      selectedEngineId={effectiveEngineId}
      engineLocked={engineLocked}
      showEnginePicker={!engineLocked}
      effort={effectiveEffort}
      effortSupported={effortCap != null}
      allowedEffortLevels={allowedEffortLevels}
      thinkingMode={effectiveThinking}
      adaptiveSupported={adaptiveSupported}
      showThinkingPicker={thinkingCap != null}
      showModelPicker={true}
      showCostInStatusLine={billingType !== 'free'}
      showContextMeter={capabilities.contextWindow > 0}
      visionEnabled={capabilities.vision}
      sandboxEnabled={sandboxEnabled}
      voiceEnabled={voiceEnabled && capabilities.voice}
      voiceState={voiceState}
      statusLine={statusLine}
      onSend={handleSend}
      onCancel={handleCancel}
      onInput={handleInput}
      onKeyDown={handleKeyDown}
      onKeyUp={handleKeyUp}
      onPaste={handlePaste}
      onFileChange={handleFileChange}
      onRemoveFile={removeFile}
      onSlashSelect={handleSlashSelect}
      onFileMentionConfirm={handleFileMentionConfirm}
      onSelectMode={handleSelectMode}
      onSelectModel={handleSelectModel}
      onSelectEngine={activeSessionId ? setSelectedEngine : setLastSelectedEngineId}
      onSelectEffort={handleSelectEffort}
      onSelectThinking={handleSelectThinking}
      reasoningVariants={reasoningVariants}
      reasoningVariant={reasoningVariant}
      onSelectReasoningVariant={handleSelectReasoningVariant}
      onOpenSandboxSettings={handleOpenSandboxSettings}
      onVoiceStart={handleVoiceStart}
      onVoiceStop={handleVoiceStop}
    />
  )
}
