import { useRef, useCallback, useEffect, useMemo } from 'react'
import { useShallow } from 'zustand/react/shallow'
import {
  useSessionStore,
  useActiveSession,
  bootstrapPermissionMode,
  engineDefaultModels,
  resolveEngineDefaultModel
} from '../../../stores/session-store'
import { resolveRekeyed } from '../../../stores/replica'
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
import { engineMeta } from '../../../../../shared/engine-meta'
import { SIGN_IN_PROVIDER_LABEL, signInProviderFor } from '../../../utils/sign-in-provider'
import type { PermissionMode } from '../../../../../shared/types'
import {
  claudeModelCapabilities,
  modelResolveThinkingMode,
  modelResolveEffort,
  modelDefaultEffort,
  modelDefaultThinkingMode,
  canonicalizeModelValue,
  type EffortLevel,
  type ThinkingMode,
  codexPublishesEffort
} from '../../../../../shared/model-capabilities'

const codexCatalogOf = (models: ReadonlyArray<{ value: string; engineId?: string }>) =>
  models.filter((model) => model.engineId === 'codex')

/**
 * THE predicate for "this Codex spawn carries an explicit model". The request
 * (`resolveSessionSdkOptions`) sends `selectedModel` exactly when this is true,
 * and the pill reads "Native default" exactly when it is false. Keeping two
 * copies of the rule is what let the pill advertise a catalog model the request
 * then omitted, so Codex silently ran its own configured default instead.
 *
 * The empty-`selectedModel` case is the one the second copy got wrong: the flag
 * can say "explicit" while the value is gone (a sticky pick the catalog no
 * longer offers), and an absent value is an omitted model whatever the flag
 * says.
 */
export function codexModelIsExplicit(
  session:
    | {
        codexModelExplicit?: boolean
        isHistorical?: boolean
        selectedModel: string
        status: { sessionId: string | null }
      }
    | undefined,
  sticky: string | undefined,
  codexModels: ReadonlyArray<{ value: string }>,
  /** `engines/codex.json#codexConfig.defaultModel`, '' when unset (Slice 5b). */
  configuredDefault: string = ''
): boolean {
  // Welcome screen: no session holds the pick yet, so answer for the one
  // `createNewSession` is about to seed — it marks a sticky model explicit, and
  // drops it only when a codex catalog exists that no longer lists it. A
  // CONFIGURED default is the next rung of the same ladder (ADR-059: naming it
  // in settings is as explicit as picking it in the picker), and the store
  // seeds it in exactly this order.
  if (!session) {
    const candidate = sticky || configuredDefault
    return (
      !!candidate &&
      (codexModels.length === 0 || codexModels.some((model) => model.value === candidate))
    )
  }
  if (!session.selectedModel) return false
  return !!(session.codexModelExplicit || session.isHistorical || session.status.sessionId)
}

/**
 * The configured native tier to send with a FRESH Codex spawn, or undefined.
 *
 * PAIRED with the model. The Default-models pane offers only the tiers the
 * configured default model publishes, so `codexConfig.defaultEffort` is a
 * statement about THAT model: a session the user steered onto another model
 * (a sticky pick) runs that model's own default tier, because sending the
 * configured one would make `CodexSession.validateEffort` refuse the start for a
 * mismatch the user never chose. With no default model configured the tier came
 * from the union, so it goes when the catalog says the session's model publishes
 * it, and when the model is Codex's own (not explicit, unknown here) — where a
 * mismatch is the loud thread-start failure ADR-059 wants, not a silent drop.
 */
export function codexDefaultEffortFor(
  defaults: {
    codexDefaultModel: string
    codexDefaultModelConfigured: boolean
    codexDefaultEffort: string
  },
  model: string | undefined,
  codexModels: ReadonlyArray<{
    value: string
    nativeEffortOptions?: ReadonlyArray<{ value: string }>
  }>
): string | undefined {
  const effort = defaults.codexDefaultEffort
  if (!effort) return undefined
  if (defaults.codexDefaultModelConfigured)
    return model === defaults.codexDefaultModel ? effort : undefined
  if (!model) return effort
  const options = codexModels.find((m) => m.value === model)?.nativeEffortOptions
  if (!options || options.length === 0) return effort
  return options.some((option) => option.value === effort) ? effort : undefined
}

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
        // claude/opencode/pi discovery all emit "Name · detail" descriptions, so
        // the head of the split is the name. Codex's native catalog puts a
        // marketing sentence there instead ("Our most capable model for …"),
        // which splits to the whole sentence — use its display name directly.
        const shortName =
          m.engineId === 'codex'
            ? m.displayName
            : m.description?.split('·')[0]?.trim() || m.displayName
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
  const codexModelExplicit = useActiveSession((s) => s.codexModelExplicit)
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
  const engineDefaults = useSessionStore(useShallow(engineDefaultModels))
  const lastSelectedModelByEngine = useSessionStore((s) => s.lastSelectedModelByEngine)
  const selectedModel = useMemo(() => {
    const engine = effectiveEngineId ?? 'claude'
    const sameEngine = models.filter((m) => (m.engineId ?? 'claude') === engine)
    /** The picker's "nothing resolved" row — never a substitute model. */
    const unset: (typeof sameEngine)[number] = {
      value: '',
      displayName: 'Select a model',
      shortName: 'Select model',
      description: '',
      engineId: engine,
      supportsAdaptiveThinking: false,
      supportsEffort: false
    }
    // Welcome screen: there is no session holding the pick, so the per-engine
    // stickiness map is where it lives. Ahead of `exact` because the empty
    // session's placeholder `selectedModel` would otherwise win.
    if (!activeSessionId) {
      const sticky = lastSelectedModelByEngine[engine]
      const m = sticky ? sameEngine.find((mm) => mm.value === sticky) : undefined
      if (m) return m
    }
    const exact = sameEngine.find((m) => m.value === selectedModelValue)
    if (exact) return exact
    if (engine === 'codex') {
      // Welcome screen, no sticky pick: the CONFIGURED default is what
      // `createNewSession` will seed, so the pill must name it rather than the
      // catalog's first row (which the spawn would not carry).
      if (!activeSessionId && engineDefaults.codexDefaultModelConfigured) {
        const configured = sameEngine.find((mm) => mm.value === engineDefaults.codexDefaultModel)
        if (configured) return configured
      }
      if (
        activeSessionId &&
        (codexModelExplicit || isHistorical || startedSessionId) &&
        selectedModelValue
      ) {
        return sameEngine.length > 0
          ? { ...unset, displayName: 'Model unavailable', shortName: 'Model unavailable' }
          : {
              ...unset,
              value: selectedModelValue,
              displayName: selectedModelValue,
              shortName: selectedModelValue
            }
      }
      return sameEngine[0] ?? unset
    }
    if (engine === 'opencode' || engine === 'pi') {
      // The SAME resolver the store seeds sessions with, so the pill shows what
      // will actually spawn. `null` = the user's configured default is gone:
      // show the unset row rather than a substitute whose capabilities differ.
      const resolved = resolveEngineDefaultModel(engine, models, engineDefaults)
      if (resolved === null) return unset
      const m = sameEngine.find((mm) => mm.value === resolved)
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
  }, [
    models,
    effectiveEngineId,
    selectedModelValue,
    engineDefaults,
    lastSelectedModelByEngine,
    activeSessionId,
    codexModelExplicit,
    isHistorical,
    startedSessionId
  ])
  const stickyCodexModel = lastSelectedModelByEngine.codex
  // The exact four fields `resolveSessionSdkOptions` reads off the store, so
  // the pill and the spawn ask `codexModelIsExplicit` the same question.
  const activeCodexSession = useMemo(
    () =>
      activeSessionId
        ? {
            codexModelExplicit,
            isHistorical,
            selectedModel: selectedModelValue,
            status: { sessionId: startedSessionId }
          }
        : undefined,
    [activeSessionId, codexModelExplicit, isHistorical, selectedModelValue, startedSessionId]
  )

  // Pre-spawn sign-in hint (ADR-068 §3, Slice 6). A session that has not
  // reached a backend is the one moment a missing credential is still cheap to
  // fix; once it spawns, the reactive AuthRequiredRow owns the problem. A fork
  // carries seeded messages before its first send, hence the message gate.
  const messageCount = useActiveSession((s) => s.messages.length)
  const providerAuth = useSessionStore((s) => s.providerAuth)
  const signInHint = useMemo(() => {
    if (startedSessionId || isHistorical || messageCount > 0) return null
    const resolved = signInProviderFor(effectiveEngineId, selectedModel.vendorId, providerAuth)
    if (!resolved || resolved.state !== 'unauthenticated') return null
    return {
      providerId: resolved.providerId,
      engineLabel: engineMeta(effectiveEngineId).label,
      providerLabel: SIGN_IN_PROVIDER_LABEL[resolved.providerId]
    }
  }, [
    startedSessionId,
    isHistorical,
    messageCount,
    effectiveEngineId,
    selectedModel.vendorId,
    providerAuth
  ])

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
    effort?: string
    thinkingMode?: ThinkingMode
    model?: string
  } {
    const state = useSessionStore.getState()
    const session = state.sessions[routingId]
    const engineId = session?.selectedEngineId ?? 'claude'
    if (engineId === 'codex') {
      const catalog = codexCatalogOf(state.availableModels)
      const model = codexModelIsExplicit(
        session,
        state.lastSelectedModelByEngine.codex,
        catalog,
        state.codexDefaultModel
      )
        ? session?.selectedModel
        : undefined
      // The configured NATIVE tier seeds a session that has no thread yet, and
      // only when it is paired with the session's model (`codexDefaultEffortFor`).
      // A resume must not carry the DEFAULT: `CodexSession.start` folds an
      // explicit effort OVER the thread's remembered one, so re-sending it
      // would silently undo a live `thread/settings/update` the user made.
      const fresh = !session?.status.sessionId && !session?.isHistorical
      // The user's OWN pick outranks it and rides EVERY spawn, resume included
      // (F15): it is the tier they set in the composer with no process there to
      // take it, and folding it over the thread's remembered one is exactly
      // what they asked for. Only a tier the SELECTED model's catalog row
      // publishes may go: `CodexSession.validateEffort` refuses the start on
      // any other, so an unpublished leftover is dropped and — on a fresh
      // spawn only — the configured default applies as before.
      const picked =
        session?.effort && codexPublishesEffort(catalog, session.selectedModel, session.effort)
          ? session.effort
          : undefined
      const effort = picked ?? (fresh ? codexDefaultEffortFor(state, model, catalog) : undefined)
      return { model, ...(effort ? { effort } : {}) }
    }
    const modelInfo = state.availableModels.find(
      (m) => m.value === session?.selectedModel && (m.engineId ?? 'claude') === engineId
    )
    const desiredThinking: ThinkingMode =
      session?.thinkingMode ?? modelDefaultThinkingMode(modelInfo)
    // Effort precedence: explicit per-session pick > per-model user default > cli.js heuristic.
    const userDefault =
      state.settings.modelEffortDefaults?.[canonicalizeModelValue(modelInfo?.value)]
    // Not the codex branch (returned above): here the store's pick is one of
    // the Claude rungs, the only values the non-native picker can set.
    const desiredEffort: EffortLevel =
      (session?.effort as EffortLevel | null | undefined) ??
      userDefault ??
      modelDefaultEffort(modelInfo)
    return {
      model: session?.selectedModel,
      effort: modelResolveEffort(modelInfo, desiredEffort) ?? desiredEffort,
      thinkingMode: modelResolveThinkingMode(modelInfo, desiredThinking)
    }
  }

  /**
   * Refuse to spawn a non-Claude engine with an EMPTY model.
   *
   * An empty `selectedModel` on opencode/pi only happens when the user's
   * configured default named a model that is gone (the store seeds `''` and
   * banners it rather than substituting). Passing that through would hand the
   * spawn resolver `undefined`, which for pi means "use pi's own default" — the
   * silent substitute this whole path exists to prevent. Claude's `'default'`
   * alias is a real value and never trips this.
   */
  function assertModelResolved(routingId: string): void {
    const state = useSessionStore.getState()
    const session = state.sessions[routingId]
    const engineId = session?.selectedEngineId ?? 'claude'
    // Codex without an explicit model is a SUPPORTED spawn (the pill says
    // "Native default" and Codex uses its own configured model), so the
    // engine-default guard below must not fire on it.
    if (
      engineId === 'codex' &&
      !codexModelIsExplicit(
        session,
        state.lastSelectedModelByEngine.codex,
        codexCatalogOf(state.availableModels),
        state.codexDefaultModel
      )
    )
      return
    if (engineId === 'claude' || session?.selectedModel) return
    throw new Error(
      `No model selected for this ${engineId} session — the configured default model is no longer available. Pick one in the model picker.`
    )
  }

  const doSend = useCallback(
    async (
      prompt: string,
      attachments?: Array<{ mediaType: string; base64Data: string; fileName?: string }>
    ) => {
      if (!activeSessionId) return
      if (!sdkActive) {
        assertModelResolved(activeSessionId)
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
            opts.model,
            opts.thinkingMode,
            fork.anchorUuid,
            true,
            session?.selectedEngineId
          )
        } else {
          const isHistorical =
            session?.selectedEngineId === 'codex'
              ? !!(session.status.sessionId || session.isHistorical)
              : session && session.messages.length > 0
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
            opts.model,
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
      assertModelResolved(activeSessionId)
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
          opts.model,
          opts.thinkingMode,
          fork.anchorUuid,
          true,
          session?.selectedEngineId
        )
      } else {
        const isHistorical =
          session?.selectedEngineId === 'codex'
            ? !!(session.status.sessionId || session.isHistorical)
            : session && session.messages.length > 0 && !session.sdkActive
        const resumeId = isHistorical ? activeSessionId : undefined
        await window.api.createSession(
          activeSessionId,
          session?.cwd || '',
          opts.effort,
          resumeId,
          session?.permissionMode,
          opts.model,
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
          useSessionStore
            .getState()
            .addError(resolveRekeyed(sessionId), `Failed to send message: ${err}`)
          return
        }
        // The engine can report its stable session id WHILE the send is in
        // flight — Codex rekeys on `thread/start`, which lands well before
        // `turn/start` resolves this await — and the rekey retires `sessionId`
        // out from under us. Follow the move first, or the guard below compares
        // the new active id against a dead one, the textarea never clears, and
        // the attachment reset lands on an id nothing holds any more.
        const settledId = resolveRekeyed(sessionId)
        // Only clear the textarea if the user is still on this session; always
        // clear the attachments of the session the send targeted.
        if (useSessionStore.getState().activeSessionId === settledId) {
          setText('')
          if (textareaRef.current) textareaRef.current.style.height = 'auto'
        }
        setDraftAttachments(settledId, [])
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
        if (selectedEngine === 'codex') {
          // A codex pick is a NATIVE tier, not a rung of the Claude ladder, so
          // it is coerced against the new model's own published options (F11).
          // A started session is left alone: the backend re-validates the tier
          // against the model it switches to and echoes the result back.
          if (
            !started &&
            !codexPublishesEffort(codexCatalogOf(state.availableModels), value, session.effort)
          )
            setEffort(null)
        } else {
          const coerced = modelResolveEffort(newModel, session.effort as EffortLevel)
          // Effort unsupported on new model → clear the user's pick (fall back to default).
          if (coerced === null) setEffort(null)
          else if (coerced !== session.effort) setEffort(coerced)
        }
      }
      // Reset reasoning variant — the new model has different variants.
      // setSelectedModel already resets it in the store; also notify the backend.
      if (activeSessionId && started) {
        window.api.setReasoningVariant(activeSessionId, null)
      }
    },
    [activeSessionId, setSelectedModel, setThinkingMode, setEffort]
  )

  // Engine-native reasoning tiers, published by the live session's capabilities
  // (Codex reads them off its own model catalog). Absent for Claude/opencode/pi,
  // which use the fixed EffortLevel ladder derived from the selected model.
  const nativeEffortOptions = capabilities.reasoning.nativeEffort?.options

  // THE predicate for "a process is there to take a live setter": a thread id
  // AND a connected backend. Everything else — not spawned yet, a historical
  // read from the sidebar, a session whose host died (ADR-045 projects
  // `disconnected` as idle + `sdkActive: false`) — has no session on the host
  // for `session:set-effort` to find, so the store is the only place a pick can
  // live until the next spawn or resume reads it (F15).
  const liveBackend = sdkActive && !!startedSessionId

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
      opts.model,
      opts.thinkingMode,
      undefined,
      undefined,
      session?.selectedEngineId
    )
    markSdkActive(activeSessionId)
  }, [activeSessionId, sdkActive, markSdkActive])

  const handleSelectEffort = useCallback(
    async (level: string) => {
      // An engine with NATIVE effort tiers applies them live over IPC (Codex's
      // `thread/settings/update`), and the acknowledged value arrives back on
      // `session:status` — no local optimistic write and no respawn. Claude and
      // opencode have no live setter, hence the cancel/recreate below.
      if (nativeEffortOptions) {
        // The store mirrors the user's LAST EXPLICIT PICK either way: with no
        // process on the host the main `setEffort` handler finds no live
        // session and returns without emitting, and the pick would vanish
        // (F11 pre-spawn, F15 historical + disconnected). It is what
        // `resolveSessionSdkOptions` carries into the next spawn or resume.
        setEffort(level)
        if (liveBackend && activeSessionId) await window.api.setEffort(activeSessionId, level)
        return
      }
      setEffort(level as EffortLevel)
      await restartSdkSession()
    },
    [activeSessionId, nativeEffortOptions, liveBackend, setEffort, restartSdkSession]
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

  // -------------------------------------------------------------------------
  // The per-session ChatGPT account pin (ADR-068 §2)
  // -------------------------------------------------------------------------
  //
  // Read once on mount and again whenever the menu opens, so an account added
  // or removed in Settings since this bar mounted is offered (or gone) without
  // the input bar knowing anything about the settings surface.
  const providerAccounts = useSessionStore((s) => s.providerAccounts)
  const loadProviderAccounts = useSessionStore((s) => s.loadProviderAccounts)
  useEffect(() => {
    void loadProviderAccounts()
  }, [loadProviderAccounts])

  // Three conditions, all of them honest refusals rather than cosmetic gates:
  // the ENGINE must be able to run one session on another account, the provider
  // must have per-session accounts turned on, and there must be a second account
  // to switch to. `providerAccounts === null` means "not read yet", which is a
  // fourth reason to stay hidden — guessing would flash a picker and then take
  // it away.
  const showAccountPicker =
    capabilities.auth.perSessionAccount &&
    providerAccounts?.perSession === true &&
    providerAccounts.accounts.length > 1
  const accountChoices = useMemo(
    () =>
      (providerAccounts?.accounts ?? []).map(({ id, email, planType }) => ({
        id,
        ...(email ? { email } : {}),
        ...(planType ? { planType } : {})
      })),
    [providerAccounts]
  )
  const handleSelectAccount = useCallback(
    async (accountId: string | null) => {
      if (!activeSessionId) return
      try {
        await window.api.setSessionAccount(activeSessionId, accountId)
      } catch (error) {
        // Codex can REFUSE the re-injection (a managed workspace policy, or a
        // token it will not parse), and the native message is the only thing the
        // user can act on. It goes where `session:error` goes — an error row on
        // this session — rather than dying as an unhandled rejection in the
        // console, which is all it did before. Both surfaces reach this one
        // handler: the desktop `AccountPicker` and the mobile sheet's account
        // page are both wired to `onSelectAccount`.
        useSessionStore
          .getState()
          .addError(
            activeSessionId,
            error instanceof Error
              ? error.message
              : 'The ChatGPT account for this session could not be changed'
          )
      }
    },
    [activeSessionId]
  )
  const handleAddAccount = useCallback(() => {
    window.dispatchEvent(
      new CustomEvent('open-settings', { detail: { page: 'models', group: 'providers' } })
    )
  }, [])

  const handleOpenSandboxSettings = useCallback(() => {
    window.dispatchEvent(
      new CustomEvent('open-settings', { detail: { page: 'claude', group: 'sandbox' } })
    )
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
            ? capabilities.queue
              ? 'Type to queue a message...'
              : 'Wait for this turn, or stop it to send another message'
            : effectiveEngineId === 'codex'
              ? 'Ask Codex anything'
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
  const effectiveEffort = useMemo<string>(
    () =>
      nativeEffortOptions
        ? // On a LIVE thread the engine's ACKNOWLEDGED tier is the truth, and a
          // pick is pushed to it over IPC, so the pill follows the thread.
          // Without a process nothing can refresh that acknowledgement, so the
          // session's OWN pick comes first: it is what the next spawn or resume
          // will carry (F15). Only then the selected model's catalog default
          // (`nativeDefaultEffort`, from model-discovery), never the first
          // catalog row: that row is just the lowest tier the catalog happens
          // to list, so it claimed a tier the engine never said.
          liveBackend
          ? (status.codex?.reasoningEffort ?? effort ?? selectedModel.nativeDefaultEffort ?? '')
          : (effort ?? status.codex?.reasoningEffort ?? selectedModel.nativeDefaultEffort ?? '')
        : (effort ?? modelDefaultEffort(selectedModel)),
    [effort, selectedModel, nativeEffortOptions, liveBackend, status.codex?.reasoningEffort]
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
      selectedModel={
        effectiveEngineId === 'codex' &&
        !codexModelIsExplicit(
          activeCodexSession,
          stickyCodexModel,
          pickerModels,
          engineDefaults.codexDefaultModel
        )
          ? {
              ...selectedModel,
              displayName: 'Native configured model',
              shortName: 'Native default'
            }
          : selectedModel
      }
      selectedEngineId={effectiveEngineId}
      engineLocked={engineLocked}
      showEnginePicker={!engineLocked}
      effort={effectiveEffort}
      effortSupported={nativeEffortOptions != null || effortCap != null}
      allowedEffortLevels={allowedEffortLevels}
      nativeEffortOptions={nativeEffortOptions}
      showAccountPicker={showAccountPicker}
      accounts={accountChoices}
      activeAccountId={providerAccounts?.activeId ?? null}
      pinnedAccountId={status.codex?.pinnedAccountId ?? null}
      onSelectAccount={handleSelectAccount}
      onAddAccount={handleAddAccount}
      onAccountMenuOpen={loadProviderAccounts}
      thinkingMode={effectiveThinking}
      adaptiveSupported={adaptiveSupported}
      showThinkingPicker={effectiveEngineId !== 'codex' && thinkingCap != null}
      showModelPicker={true}
      showCostInStatusLine={effectiveEngineId !== 'codex' && billingType !== 'free'}
      showContextMeter={capabilities.contextWindow > 0}
      visionEnabled={capabilities.vision}
      sandboxEnabled={sandboxEnabled}
      voiceEnabled={voiceEnabled && capabilities.voice}
      voiceState={voiceState}
      statusLine={statusLine}
      signInHint={signInHint}
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
