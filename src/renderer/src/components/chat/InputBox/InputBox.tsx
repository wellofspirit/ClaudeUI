import { useRef, useCallback, useEffect, useMemo, useState } from 'react'
import { useShallow } from 'zustand/react/shallow'
import {
  useSessionStore,
  useActiveSession,
  bootstrapPermissionMode,
  engineDefaultModels,
  resolveEngineDefaultModel,
  seedingModelPicks,
  carriesPicksIntoNewSessions,
  hasResumableTranscript
} from '../../../stores/session-store'
import { resolveRekeyed } from '../../../stores/replica'
import { awaitReloadBeforeSpawn } from '../../../lib/session-history-load'
import {
  createPendingWorktree,
  onDraftSendRequest,
  WorktreeCreateError
} from '../../../lib/worktree-start'
import { voiceController } from '../../../lib/voice/voice-controller'
import { noSignalMessage, switchedMessage } from '../../../lib/voice/browser-voice-capture'
import {
  dismissStaleVoiceOffer,
  dismissVoiceNotice,
  followVoiceNotice,
  latchVoiceNoticeOutcome,
  showVoiceNotice,
  useVoiceNotice
} from '../../../lib/voice/voice-notice'
import { outcomeOf, voiceNoticeView } from '../../../lib/voice/voice-pack-notice'
import {
  cancelVoicePackInstall,
  installVoicePack,
  refreshVoicePackStatus,
  useVoicePackStore
} from '../../../lib/voice/voice-pack-store'
import type {
  AttachmentUpload,
  FileAttachment,
  VoiceState as VoiceStateType
} from '../../../../../shared/types'
import { v4 as uuid } from 'uuid'
import { resolveSendAction, filterModelsForEngine, dedupeResolvedModels, modelLabel } from './utils'
import { recallQueuedInto } from './recall-queued'
import {
  catalogFor,
  rememberedEffortPatch,
  sessionSpawnEffort,
  spawnAnnouncement
} from '../../../lib/session-effort'
import { useSlashMenu } from '../../../hooks/useSlashMenu'
import { mergeSlashCommands } from '../SlashCommandMenu'
import { useFileMention } from '../../../hooks/useFileMention'
import { useIsMobile } from '../../../hooks/useIsMobile'
import { InputBoxView } from './View'
import { HarnessInstallBanner } from '../../harness/HarnessInstallBanner'
import { useSeedModelWhenHarnessReady } from '../../harness/use-harness-ready'
import { useHarnessReadiness } from '../../SettingsDialog/harness-store'
import { HARNESS_LABEL, harnessCanRun } from '../../SettingsDialog/harness-view'
import { engineMeta } from '../../../../../shared/engine-meta'
import { autoModeAvailableForEngine } from '../../../../../shared/permission-modes'
import type { EngineId, PermissionMode } from '../../../../../shared/types'
import { HARNESS_IDS } from '../../../../../shared/harness-types'
import {
  claudeAliasForModel,
  claudeModelCapabilities,
  modelResolveThinkingMode,
  modelResolveEffort,
  modelDefaultThinkingMode,
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

/**
 * A voice failure the renderer itself saw (start/stop rejected), surfaced where a
 * server-side `voice:error` lands (`useClaudeEvents`): the notice pill above the
 * mic — never the session's error stack.
 */
function reportVoiceError(routingId: string, err: unknown): void {
  const message = err instanceof Error ? err.message : String(err)
  showVoiceNotice(routingId, message, 'warn')
}

/** Subscribe to the live microphone level — the ring reads it without re-rendering. */
function subscribeVoiceLevel(listener: (level: number) => void): () => void {
  return voiceController().onLevel(listener)
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
  const modelEffortDefaults = useSessionStore((s) => s.settings.modelEffortDefaults)
  const engineEffortDefaults = useSessionStore((s) => s.settings.engineEffortDefaults)
  const newSessionModel = useSessionStore((s) => s.settings.newSessionModel)
  const setAvailableModels = useSessionStore((s) => s.setAvailableModels)
  const setEngineModels = useSessionStore((s) => s.setEngineModels)
  const models = useMemo(
    () => availableModels.map((m) => ({ ...m, shortName: modelLabel(m).shortName })),
    [availableModels]
  )
  const requestedModelValue = useActiveSession((s) => s.selectedModel)
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
  // opencode/pi report the model the live process will actually use. Local
  // picks and historical hydration can differ until a setter is acknowledged.
  const selectedModelValue =
    sdkActive &&
    !!startedSessionId &&
    (effectiveEngineId === 'opencode' || effectiveEngineId === 'pi') &&
    status.model?.engineId === effectiveEngineId
      ? engineMeta(effectiveEngineId).encodeModelValue(status.model)
      : requestedModelValue
  const engineLocked = sdkActive || !!startedSessionId || !!isHistorical
  // A harness that does not run (ADR-082 §8): the banner above the input
  // offers it, Send stays off and the model picker says why, instead of an
  // error after the first send. A live process keeps its binary, so a session
  // already running is never blocked; `unknown` (no snapshot yet) is today's
  // behaviour.
  const harnessReadiness = useHarnessReadiness(effectiveEngineId)
  const harnessBlocked = !harnessCanRun(harnessReadiness) && !sdkActive
  // Deduped: cli.js lists `default` and its concrete equivalent (`opus[1m]`)
  // as two rows with the same description, which the shortName derivation above
  // renders identically. The `selectedModel` memo below deliberately resolves
  // against the UNDEDUPED `models`, so a session pinned to a collapsed row is
  // still resolvable.
  const pickerModels = useMemo(
    () =>
      dedupeResolvedModels(filterModelsForEngine(models, effectiveEngineId), selectedModelValue),
    [models, effectiveEngineId, selectedModelValue]
  )
  // Memoized so its identity is stable across renders (it feeds several
  // downstream useMemo dependency lists). The fallback MUST stay within the
  // session's OWN engine — never surface a same-valued model from another
  // harness. For opencode use the same resolver the spawn path uses so display
  // == what will actually run.
  const engineDefaults = useSessionStore(useShallow(engineDefaultModels))
  // The picks that SEED a new session — none when the user chose the
  // configured default (`newSessionModel`), so the welcome pill previews it.
  const lastSelectedModelByEngine = useSessionStore(seedingModelPicks)
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
    // Claude with a CONFIGURED default (ADR-074 §8): the welcome pill previews
    // what `createNewSession` will seed — ahead of `exact`, which the empty
    // session's `'default'` placeholder would otherwise win — and a session
    // seeded '' because that default is gone reads unset rather than naming the
    // list's first row. Unconfigured, this is skipped: the pill is today's.
    if (engine === 'claude' && engineDefaults.claudeDefaultModelConfigured) {
      if (!activeSessionId) {
        const resolved = resolveEngineDefaultModel(engine, models, engineDefaults)
        if (resolved === null) return unset
        const m = sameEngine.find((mm) => mm.value === resolved)
        if (m) return m
      } else if (!selectedModelValue) {
        return unset
      }
    }
    const exact = sameEngine.find((m) => m.value === selectedModelValue)
    if (exact) return exact
    // A session saved on a concrete Claude model shows the alias that runs that
    // model today — display only, the session keeps its own value (ADR-100).
    if (engine === 'claude' && selectedModelValue) {
      const alias = claudeAliasForModel(selectedModelValue, sameEngine)
      const viaAlias = sameEngine.find((m) => m.value === alias)
      if (viaAlias) return viaAlias
    }
    // Curation changes the picker, not an existing session's model. Keep the
    // reference visible even when discovery no longer returns its metadata.
    const missingSelection = {
      ...unset,
      value: selectedModelValue,
      displayName:
        engine === 'claude' && selectedModelValue === 'default' ? 'Default' : selectedModelValue,
      shortName:
        engine === 'claude' && selectedModelValue === 'default' ? 'Default' : selectedModelValue,
      description: 'Not in the current model list. Choose a model to change this session.',
      supportsEffort: sdkActive && !!startedSessionId && !!capabilities.reasoning.effort,
      supportedEffortLevels:
        sdkActive && startedSessionId ? capabilities.reasoning.effort?.levels : undefined,
      supportsAdaptiveThinking:
        sdkActive &&
        !!startedSessionId &&
        capabilities.reasoning.thinking?.modes.includes('adaptive') === true
    }
    if (activeSessionId && selectedModelValue && engine === 'claude') {
      return missingSelection
    }
    if (engine === 'opencode' || engine === 'pi') {
      // An ACTIVE session holds its own model, and the configured default is
      // not it: on a reopened session whose model the discovered catalog
      // momentarily lacks (an alicloud provider that has not answered yet),
      // substituting the default names a model the session never ran and the
      // resume will not spawn. Preserve its identity without claiming that
      // absence from the curated picker means the live model is unavailable.
      if (activeSessionId && selectedModelValue) {
        return missingSelection
      }
      // Welcome screen: the SAME resolver the store seeds sessions with, so
      // the pill shows what will actually spawn. `null` = the user's
      // configured default is gone: show the unset row rather than a
      // substitute whose capabilities differ.
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
    startedSessionId,
    sdkActive,
    capabilities.reasoning
  ])
  useSeedModelWhenHarnessReady(
    activeSessionId,
    effectiveEngineId,
    selectedModelValue,
    pickerModels.length
  )
  const statusLine = useActiveSession((s) => s.statusLine)
  // The content-first load defers the status line (ADR-102 Arc 2): with none yet, the
  // footer says so instead of showing zeros. A previous one stays on screen until replaced.
  const statusLinePending = useActiveSession(
    (s) => s.statusLine === null && !!s.backgroundLoad?.statusPending
  )
  const billingType = useActiveSession((s) => s.status?.account?.billingType)
  const effort = useActiveSession((s) => s.effort)
  const setEffort = useSessionStore((s) => s.setEffort)
  const thinkingMode = useActiveSession((s) => s.thinkingMode)
  const setThinkingMode = useSessionStore((s) => s.setThinkingMode)
  const reasoningVariant = useActiveSession((s) => s.reasoningVariant)
  const setReasoningVariant = useSessionStore((s) => s.setReasoningVariant)
  const sandboxEnabled = useSessionStore((s) => s.engineConfig.sandbox?.enabled ?? false)

  // Voice input: the user's setting AND the session's capability. The session
  // value is false on engines without voice and on a Claude Code binary that
  // lacks the voice-server patch, so both the mic and its Tab shortcut go dark.
  const voiceEnabled = useSessionStore((s) => s.settings.voiceEnabled)
  const voiceAvailable = voiceEnabled && capabilities.voice
  const voiceLanguage = useSessionStore((s) => s.settings.voiceLanguage)
  const voiceState = useActiveSession((s) => s.voiceState) as VoiceStateType
  const voiceInterimTranscript = useActiveSession((s) => s.voiceInterimTranscript)
  const clearVoiceTranscript = useSessionStore((s) => s.clearVoiceTranscript)

  // Load models with one getEngineModels(engineId) request PER ENGINE, each
  // filling only its own slice of `availableModels` as it answers: a slow probe
  // (pi's runs up to 15s) holds back its own models, never Claude's. Every
  // engine re-fetches when cwd changes; one engine re-fetches when its entry in
  // `engineModelReloadNonces` is bumped — all of them on `reloadModels()` (e.g.
  // an opencode provider or default-model change in Settings), only the one
  // whose catalog main says recovered (`engine:models-changed`). Flattens
  // EngineModelGroup[] → ModelInfo[] (each entry has engineId/vendorId set).
  const engineModelReloadNonces = useSessionStore((s) => s.engineModelReloadNonces)
  const loadedModelsKey = useRef<string | null>(null)
  /**
   * Per engine: the nonce its slice was last requested at, and that request's
   * token. An answer lands only while its token is still the engine's latest,
   * so a superseded request (a cwd change, a newer reload of that engine) or
   * one answering after unmount is dropped — per request, because the effect
   * re-runs for ANY engine's nonce and must not orphan another engine's answer
   * still in flight.
   */
  const modelRequests = useRef<Partial<Record<EngineId, { nonce: number; token: object }>>>({})
  useEffect(() => {
    const key = cwd ?? ''
    const cwdChanged = loadedModelsKey.current !== key
    if (loadedModelsKey.current !== null && cwdChanged) {
      setAvailableModels([])
    }
    loadedModelsKey.current = key

    for (const engineId of HARNESS_IDS) {
      const nonce = engineModelReloadNonces[engineId]
      if (!cwdChanged && modelRequests.current[engineId]?.nonce === nonce) continue
      const token = {}
      modelRequests.current[engineId] = { nonce, token }
      const latest = (): boolean => modelRequests.current[engineId]?.token === token
      window.api
        .getEngineModels(engineId)
        .then((groups) => {
          // Filtered, not trusted: a host that predates the argument answers
          // every engine's groups to every request.
          const own = groups.filter((g) => g.engineId === engineId).flatMap((g) => g.models)
          if (latest()) setEngineModels(engineId, own)
        })
        .catch(() => {
          // Claude falls back to its own model list; the other engines are
          // optional and keep whatever they last showed.
          if (engineId !== 'claude') return
          window.api
            .getModels()
            .then((models) => {
              if (latest()) setEngineModels('claude', models)
            })
            .catch(() => {
              /* non-fatal */
            })
        })
    }
  }, [cwd, engineModelReloadNonces, setAvailableModels, setEngineModels])
  // Unmount (and StrictMode's rehearsal of it): no request in flight may land.
  // Emptying the map also makes the next mount's effect request every engine.
  useEffect(
    () => () => {
      modelRequests.current = {}
    },
    []
  )

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
    const { modelInfo } = catalogFor(state, {
      selectedModel: session?.selectedModel ?? '',
      selectedEngineId: engineId
    })
    const desiredThinking: ThinkingMode =
      session?.thinkingMode ?? modelDefaultThinkingMode(modelInfo)
    // Effort precedence (explicit pick > Claude's per-model starting effort >
    // cli.js heuristic, clamped to the model): `sessionSpawnEffort`, the SAME
    // function — fed the same inputs — as the pill and the retry / plan / review
    // spawns.
    const effort = session ? sessionSpawnEffort(state, session) : undefined
    return {
      model: session?.selectedModel,
      effort,
      thinkingMode: modelResolveThinkingMode(modelInfo, desiredThinking)
    }
  }

  /**
   * Refuse to spawn with an EMPTY model.
   *
   * An empty `selectedModel` only happens when the user's configured default
   * named a model that is gone (the store seeds `''` and banners it rather than
   * substituting). Passing that through would hand the spawn resolver
   * `undefined`, which for pi means "use pi's own default" — the silent
   * substitute this whole path exists to prevent. An unconfigured Claude seeds
   * its `'default'` alias, a real value, and never trips this.
   */
  function assertModelResolved(routingId: string): void {
    const state = useSessionStore.getState()
    const session = state.sessions[routingId]
    const engineId = session?.selectedEngineId ?? 'claude'
    if (session?.selectedModel) return
    // Claude's `'default'` alias is always a real value — EXCEPT when the user
    // configured a Claude default the account no longer offers, which seeds ''
    // (ADR-074 §8). Spawning that would let cli.js pick its own model: the
    // silent substitute ADR-059 forbids. Unconfigured, Claude passes as before.
    if (engineId === 'claude' && !state.claudeDefaultModelConfigured) return
    throw new Error(
      `No model selected for this ${engineId} session — the configured default model is no longer available. Pick one in the model picker.`
    )
  }

  const doSend = useCallback(
    async (prompt: string, attachments?: AttachmentUpload[]) => {
      if (!activeSessionId) return
      if (!sdkActive) {
        // The host seeds its own transcript the moment the engine spawns; a client
        // read still in flight would then lose the race and show only this turn.
        await awaitReloadBeforeSpawn(activeSessionId)
        assertModelResolved(activeSessionId)
        await createPendingWorktree(activeSessionId)
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
            session?.selectedEngineId,
            spawnAnnouncement(useSessionStore.getState(), session, opts.effort)
          )
        } else {
          const isHistorical = session && hasResumableTranscript(session)
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
            session?.selectedEngineId,
            spawnAnnouncement(useSessionStore.getState(), session, opts.effort)
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
      await awaitReloadBeforeSpawn(activeSessionId)
      assertModelResolved(activeSessionId)
      await createPendingWorktree(activeSessionId)
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
          session?.selectedEngineId,
          spawnAnnouncement(useSessionStore.getState(), session, opts.effort)
        )
      } else {
        const isHistorical = session && hasResumableTranscript(session) && !session.sdkActive
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
          session?.selectedEngineId,
          spawnAnnouncement(useSessionStore.getState(), session, opts.effort)
        )
      }
      markSdkActive(activeSessionId)
    }
  }, [activeSessionId, sdkActive, markSdkActive])

  /**
   * Is the push-to-talk still held? `ensureSession()` can spawn the engine first,
   * and a release during that await sends its stop BEFORE the start — which would
   * then open a microphone (and a main-side capture) nobody is holding.
   */
  const voiceHeldRef = useRef(false)
  /**
   * The same fact as {@link voiceHeldRef}, as RENDER state: the notice pill stays
   * while the push-to-talk is held and starts fading on release. The ref stays
   * the source of truth for the start/stop sequencing (it must be current inside
   * an await, which state is not).
   */
  const [voiceHeld, setVoiceHeld] = useState(false)
  /** The live microphone is digitally silent (the warning is up) — dims the mic. */
  const [voiceSilent, setVoiceSilent] = useState(false)
  /** Numbers each press, so a release-then-repress during one spawn starts once. */
  const voicePressRef = useRef(0)

  const handleVoiceStart = useCallback(async () => {
    if (!activeSessionId || isDisabled || harnessBlocked || voiceState !== 'idle') return
    const press = ++voicePressRef.current
    voiceHeldRef.current = true
    setVoiceHeld(true)
    setVoiceSilent(false)
    try {
      await ensureSession()
    } catch (err) {
      // The spawn's own failure is reported by the session path; log only.
      window.api.logRelay('error', 'Voice:InputBox', `voice start failed: ${err}`)
      return
    }
    if (!voiceHeldRef.current || voicePressRef.current !== press) return
    // An offer of the speech model nobody took up: this press either works now or
    // is refused again with a fresh offer.
    dismissStaleVoiceOffer(activeSessionId)
    try {
      await voiceController().start(activeSessionId, voiceLanguage)
    } catch (err) {
      // A denied microphone, a refused session, a dead transport: all things the
      // speaker can act on, so they land where a server-side `voice:error` does —
      // the notice pill above the mic.
      window.api.logRelay('error', 'Voice:InputBox', `voice start failed: ${err}`)
      reportVoiceError(activeSessionId, err)
    }
  }, [activeSessionId, isDisabled, harnessBlocked, voiceState, ensureSession, voiceLanguage])

  const handleVoiceStop = useCallback(async () => {
    voiceHeldRef.current = false
    setVoiceHeld(false)
    if (!activeSessionId) return
    try {
      await voiceController().stop(activeSessionId)
    } catch (err) {
      window.api.logRelay('error', 'Voice:InputBox', `voice stop failed: ${err}`)
      reportVoiceError(activeSessionId, err)
    }
  }, [activeSessionId])

  // The microphone itself failing mid-capture (unplugged, muted by the OS) is
  // the capture's news, not the server's — surfaced the same way.
  useEffect(() => {
    if (!activeSessionId) return
    return voiceController().onFault((message) => {
      showVoiceNotice(activeSessionId, message, 'warn')
    })
  }, [activeSessionId])

  // The capture moved to another microphone mid-press — grey: nothing to fix,
  // and what was being said carried on through the switch.
  useEffect(() => {
    if (!activeSessionId) return
    return voiceController().onSwitch((label) => {
      showVoiceNotice(activeSessionId, switchedMessage(label), 'info')
    })
  }, [activeSessionId])

  // The live silence warning: up while the microphone is producing digital
  // silence, taken down the moment a block has signal — only ITS notice, so a
  // newer message that replaced it is left alone.
  //
  // The id lives in a REF, not the effect's closure: a first press spawns cli.js,
  // which rekeys the session mid-capture, `activeSessionId` changes, and this
  // effect resubscribes — a closure variable would be lost with the old
  // subscription and the warning would outlive the silence. The notice store
  // follows the rekey, so the new id still finds it.
  const silenceWarningRef = useRef<number | null>(null)
  useEffect(() => {
    if (!activeSessionId) return
    return voiceController().onSilence(({ silent, trackLabel }) => {
      setVoiceSilent(silent)
      if (silent) {
        silenceWarningRef.current = showVoiceNotice(
          activeSessionId,
          noSignalMessage(trackLabel),
          'warn'
        )
      } else if (silenceWarningRef.current !== null) {
        dismissVoiceNotice(activeSessionId, silenceWarningRef.current)
        silenceWarningRef.current = null
      }
    })
  }, [activeSessionId])

  const voiceNotice = useVoiceNotice(activeSessionId)
  const handleVoiceNoticeExpire = useCallback(
    (id: number) => {
      if (activeSessionId) dismissVoiceNotice(activeSessionId, id)
    },
    [activeSessionId]
  )

  // A notice that offers the speech model follows the pack's live status: the
  // pill reads the pack store, which `voice:pack-changed` keeps current. The
  // status is re-read when such a notice appears — the event ring replays on
  // reconnect, and a stale `installing` must not stand in for the truth.
  const packStatus = useVoicePackStore((s) => s.status)
  const packInstallPending = useVoicePackStore((s) => s.pending === 'install')
  const voiceNoticeAction = voiceNotice?.action
  const voiceNoticeId = voiceNotice?.id
  useEffect(() => {
    if (voiceNoticeAction) void refreshVoicePackStatus()
  }, [voiceNoticeAction, voiceNoticeId])
  const packCommandFailed = useVoicePackStore((s) => s.commandFailed)
  const voiceNoticeShown = useMemo(
    () =>
      voiceNotice
        ? voiceNoticeView(voiceNotice, {
            status: packStatus,
            installPending: packInstallPending,
            commandFailed: packCommandFailed
          })
        : null,
    [voiceNotice, packStatus, packInstallPending, packCommandFailed]
  )

  // A download in progress, by anyone, is what this pill is about: follow it, so
  // that when it ends the pill shows how (ready, failed) instead of falling back
  // to the offer — whether this pill was pressed, re-issued by a second press of
  // the mic, or only watched another client's install.
  const packInstalling = packStatus?.state === 'installing'
  useEffect(() => {
    if (packInstalling && activeSessionId && voiceNotice?.action && !voiceNotice.following) {
      followVoiceNotice(activeSessionId, voiceNotice.id)
    }
  }, [packInstalling, activeSessionId, voiceNotice])

  // And once it ended, it stays ended: the outcome shown is latched, so a later
  // change of the pack (a Remove in Settings during the linger) cannot rewrite it.
  const shownOutcome = voiceNoticeShown ? outcomeOf(voiceNoticeShown) : null
  useEffect(() => {
    if (shownOutcome && activeSessionId && voiceNotice && !voiceNotice.outcome) {
      latchVoiceNoticeOutcome(activeSessionId, voiceNotice.id, shownOutcome)
    }
    // `shownOutcome` is rebuilt every render; its fields are what matter.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shownOutcome?.phase, shownOutcome?.text, activeSessionId, voiceNotice])

  // Download: the pill follows the pack from this press to its outcome. A refused
  // or broken COMMAND (a remote client without `admin`) replaces the pill with
  // that sentence; a failed INSTALL is the pack's own `failed` status, shown in
  // place; and a remote invoke that times out is an install still running.
  const handleVoiceNoticeAction = useCallback(async () => {
    if (!activeSessionId || !voiceNotice) return
    followVoiceNotice(activeSessionId, voiceNotice.id)
    const error = await installVoicePack()
    if (error) showVoiceNotice(activeSessionId, error, 'warn')
  }, [activeSessionId, voiceNotice])
  const handleVoiceNoticeCancel = useCallback(async () => {
    if (!activeSessionId) return
    const error = await cancelVoicePackInstall()
    if (error) showVoiceNotice(activeSessionId, error, 'warn')
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
  const spawningSendRef = useRef<string | null>(null)
  const handleSend = async (): Promise<void> => {
    if (harnessBlocked) return
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
        // A second send while the first is still spawning this session (making its worktree,
        // starting the engine) would spawn it twice: the draft stays, and the first send clears it.
        const spawning = action.type === 'send-prompt' && !sdkActive
        if (spawning) {
          if (spawningSendRef.current === sessionId) return
          spawningSendRef.current = sessionId
        }
        try {
          if (action.type === 'queue-prompt') {
            await window.api.sendPrompt(sessionId, action.prompt, action.attachments)
          } else {
            await doSend(action.prompt, action.attachments)
          }
        } catch (err) {
          // The welcome screen already shows why the worktree failed, with its own buttons.
          if (err instanceof WorktreeCreateError) return
          useSessionStore
            .getState()
            .addError(resolveRekeyed(sessionId), `Failed to send message: ${err}`)
          return
        } finally {
          if (spawning) spawningSendRef.current = null
        }
        // The engine can report its stable session id WHILE the send is in
        // flight — an engine may rekey on its first handshake, which lands well
        // before the send resolves this await — and the rekey retires `sessionId`
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

  // The welcome screen's Retry / Send without a worktree buttons send the draft from here.
  const handleSendRef = useRef(handleSend)
  useEffect(() => {
    handleSendRef.current = handleSend
  })
  useEffect(
    () =>
      onDraftSendRequest((routingId) => {
        if (routingId === activeSessionId) void handleSendRef.current()
      }),
    [activeSessionId]
  )

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
      // Auto-repeat of a held Tab is not a new press: while the renderer's state
      // still lags at idle, each repeat would start again and re-point the
      // native capture at a callback that drops the audio.
      if (e.repeat) return
      if (voiceAvailable && voiceState === 'idle' && !slashMenuOpen && !fileMentionOpen)
        handleVoiceStart()
    }
  }

  const handleKeyUp = (e: React.KeyboardEvent): void => {
    // `voiceHeldRef`: released before main reported `connecting` (the session
    // was still spawning) — the stop still has to cancel that pending start.
    if (
      e.key === 'Tab' &&
      (voiceState === 'recording' || voiceState === 'connecting' || voiceHeldRef.current)
    ) {
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
        if (!started && !session.sdkActive) {
          // Not started and nothing running: no process holds this effort, so it
          // is no one's value to keep. (A session spawned but not yet initialised
          // has `sdkActive` and no id: its process runs the frozen effort, so it
          // takes the coerce path below.) Clear it and the NEW model's remembered starting effort applies
          // (the pick that made the old one stuck was remembered for the old
          // model, not this one).
          setEffort(null)
        } else {
          // Started: the live process keeps its effort across `setModel`, so the
          // session keeps showing it, coerced to what the new model accepts.
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

  // THE predicate for "a process is there": a thread id AND a connected backend.
  // Everything else — not spawned yet, a historical read from the sidebar, a
  // session whose host died (ADR-045 projects `disconnected` as idle +
  // `sdkActive: false`) — has no live process, so the store is the only place a
  // pick can live until the next spawn or resume reads it (F15).
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
      session?.selectedEngineId,
      spawnAnnouncement(useSessionStore.getState(), session, opts.effort)
    )
    markSdkActive(activeSessionId)
  }, [activeSessionId, sdkActive, markSdkActive])

  const handleSelectEffort = useCallback(
    async (level: string) => {
      setEffort(level as EffortLevel)
      // Effort is remembered PER MODEL (Claude and pi — `rememberedEffortPatch`
      // writes nothing for another engine): the pick also becomes the model's
      // starting effort (Claude: the Settings table's own row; pi: its own
      // per-engine map), so the next session on it starts at — and displays —
      // what was last chosen. The session keeps its own pick
      // too: another open session on the same model must go on showing what IT
      // runs, not follow this one.
      const state = useSessionStore.getState()
      const session = activeSessionId ? state.sessions[activeSessionId] : undefined
      // Only while composer picks carry into new sessions (`newSessionModel`): with
      // "configured default" the pick changes this session alone.
      const remembered =
        session && carriesPicksIntoNewSessions(state.settings)
          ? rememberedEffortPatch(state, session, level as EffortLevel)
          : undefined
      if (remembered) state.updateSettings(remembered)
      await restartSdkSession()
    },
    [activeSessionId, setEffort, restartSdkSession]
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
            : `Ask ${engineMeta(effectiveEngineId).label} anything${
                capabilities.slashCommands ? ', / for commands' : ''
              }`

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
  const reasoning = useMemo(() => {
    const listed = models.some(
      (model) =>
        model.value === selectedModel.value && (model.engineId ?? 'claude') === effectiveEngineId
    )
    // A running model can outlive its picker entry. Its reported capabilities
    // remain valid; a synthetic row has no metadata to replace them with.
    if (
      liveBackend &&
      (!listed || effectiveEngineId === 'opencode' || effectiveEngineId === 'pi')
    ) {
      return capabilities.reasoning
    }
    return claudeModelCapabilities(selectedModel).reasoning
  }, [selectedModel, models, effectiveEngineId, liveBackend, capabilities.reasoning])
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
      // The SPAWN's own function over the SAME inputs, so the pill names the
      // effort the process starts with — Claude's per-model starting effort
      // included, and a model missing from the catalog resolved exactly as
      // spawn resolves it (this used to feed the picker's synthetic
      // "missing selection" row instead and disagree). With a session, the
      // inputs are the session's own model and engine; only the welcome
      // screen, which has no session, resolves from the picker's model.
      sessionSpawnEffort(
        {
          availableModels,
          settings: { modelEffortDefaults, engineEffortDefaults, newSessionModel }
        },
        activeSessionId
          ? {
              selectedModel: requestedModelValue,
              selectedEngineId: sessionEngineId,
              effort: effort ?? null
            }
          : {
              selectedModel: selectedModel.value,
              selectedEngineId: effectiveEngineId,
              effort: null
            }
      ),
    [
      effort,
      selectedModel.value,
      availableModels,
      activeSessionId,
      requestedModelValue,
      sessionEngineId,
      effectiveEngineId,
      modelEffortDefaults,
      engineEffortDefaults,
      newSessionModel
    ]
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
      models={harnessBlocked ? [] : pickerModels}
      modelNotice={
        harnessBlocked
          ? harnessReadiness === 'unavailable-here'
            ? `${HARNESS_LABEL[effectiveEngineId]} is not available here`
            : `Install ${HARNESS_LABEL[effectiveEngineId]} to choose a model`
          : undefined
      }
      sendBlocked={harnessBlocked}
      banner={harnessBlocked ? <HarnessInstallBanner engineId={effectiveEngineId} /> : null}
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
      showContextMeter={
        // An engine's window may be missing from the catalog and arrive on a
        // usage frame instead — the status line is the second source the meter
        // can come from.
        capabilities.contextWindow > 0 || (statusLine?.contextWindow.size ?? 0) > 0
      }
      visionEnabled={capabilities.vision}
      sandboxEnabled={sandboxEnabled}
      voiceEnabled={voiceAvailable}
      voiceState={voiceState}
      voiceHeld={voiceHeld}
      voiceSilent={voiceSilent && voiceState === 'recording'}
      voiceNotice={voiceNoticeShown}
      onVoiceNoticeExpire={handleVoiceNoticeExpire}
      onVoiceNoticeAction={handleVoiceNoticeAction}
      onVoiceNoticeCancel={handleVoiceNoticeCancel}
      subscribeVoiceLevel={subscribeVoiceLevel}
      statusLine={statusLine}
      statusLinePending={statusLinePending}
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
