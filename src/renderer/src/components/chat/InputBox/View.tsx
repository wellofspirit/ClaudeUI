import { useState, useEffect, useLayoutEffect, useRef } from 'react'
import type {
  FileAttachment,
  StatusLineData,
  SlashCommandInfo,
  DirEntry,
  VoiceState,
  EngineId,
  PermissionMode
} from '../../../../../shared/types'
import { useSessionStore } from '../../../stores/session-store'
import { SlashCommandMenu } from '../SlashCommandMenu'
import { FileMentionMenu } from '../FileMentionMenu'
import { FileAttachmentBar } from '../FileAttachmentBar'
import { type EffortLevel, type ThinkingMode } from '../../../../../shared/model-capabilities'
import {
  ModelPicker,
  EnginePicker,
  EffortPicker,
  ThinkingPicker,
  ReasoningPicker,
  AccountPicker,
  type AccountChoice,
  type ModelDisplay
} from '../../shared/InlinePickers'
import { MobileConfigSheet } from './MobileConfigSheet'
import { formatCostOrUnknown } from '../../../utils/cost'
import { AgentTab } from '../../agents/AgentTab'
import type { VoiceNotice } from '../../../lib/voice/voice-notice'

export type { ModelDisplay }

const DEFAULT_STATUS_LINE: StatusLineData = {
  totalCostUsd: 0,
  totalDurationMs: 0,
  totalApiDurationMs: 0,
  totalInputTokens: 0,
  totalOutputTokens: 0,
  cachedTokens: 0,
  totalTokens: 0,
  contextWindow: { used: 0, size: 0 },
  usedPercentage: 0,
  remainingPercentage: 100
}

// ---------------------------------------------------------------------------
// Shared types
// ---------------------------------------------------------------------------

export interface InputBoxViewProps {
  // Refs
  textareaRef: React.RefObject<HTMLTextAreaElement | null>
  fileInputRef: React.RefObject<HTMLInputElement | null>

  // Layout
  isMobile: boolean

  // Text / input state
  text: string
  displayValue: string
  isDisabled: boolean
  isRunning: boolean
  isVoiceActive: boolean
  placeholder: string
  textClassName: string

  // Permission mode
  permissionMode: string
  /** Show/hide the mobile mode-picker row (MobileConfigSheet). Hidden pre-session (welcome screen has no session to target). */
  showModePicker?: boolean
  /** Engine capability gate for the 'plan' mode option. */
  canPlan?: boolean
  /** Availability gate for the 'auto' mode option (Claude account/org gate; always true for other engines). */
  autoAvailable?: boolean

  // Menus
  slashMenuOpen: boolean
  /**
   * The MERGED list (engine ∪ filesystem, capability-gated) — the same array
   * `filteredSlashCommands` is derived from. Feeding the menu anything else
   * (e.g. the raw engine list) desynchronises its rows from the keyboard
   * selection index and hides filesystem-scanned commands entirely.
   */
  slashCommands: SlashCommandInfo[]
  slashFilter: string
  slashMenuIndex: number
  filteredSlashCommands: SlashCommandInfo[]
  fileMentionOpen: boolean
  fileMentionIndex: number
  filteredFileMentionEntries: DirEntry[]

  // Attachments
  attachedFiles: FileAttachment[]

  // Controls
  models: ModelDisplay[]
  selectedModel: ModelDisplay
  /**
   * Replaces the model picker with this line while the session's harness does
   * not run (ADR-082 §8): "Install opencode to choose a model".
   */
  modelNotice?: string
  /** Send (and Enter) stay off while the session's harness does not run. */
  sendBlocked?: boolean
  /** Shown above the input: the harness install banner, or nothing. */
  banner?: React.ReactNode
  selectedEngineId: EngineId
  engineLocked: boolean
  showEnginePicker: boolean
  effort: string
  /** Engine-native effort tiers (Codex's model catalog) in place of the fixed Claude ladder. */
  nativeEffortOptions?: ReadonlyArray<{ value: string; description: string }>
  effortSupported: boolean
  allowedEffortLevels: readonly EffortLevel[]
  /**
   * The per-session ChatGPT account picker (ADR-068 §2). Shown only when the
   * engine declares `auth.perSessionAccount`, the provider's Per-session
   * accounts toggle is on, AND at least two accounts are stored — a picker with
   * one option is a control that cannot be used.
   */
  showAccountPicker?: boolean
  accounts?: readonly AccountChoice[]
  /** The globally ACTIVE account, described under "Follow active account". */
  activeAccountId?: string | null
  /** This session's pin, or null when it follows the active account. */
  pinnedAccountId?: string | null
  onSelectAccount?: (accountId: string | null) => void
  onAddAccount?: () => void
  /** Re-read the account list (the picker calls it as its menu opens). */
  onAccountMenuOpen?: () => void
  thinkingMode: ThinkingMode
  adaptiveSupported: boolean
  /** Show/hide the thinking-mode picker. Gated on capabilities.reasoning.thinking. */
  showThinkingPicker?: boolean
  /** Show/hide the model picker. Always shown for Claude; the picker tolerates an empty/loading model list. */
  showModelPicker?: boolean
  /** Whether to include cost in the status line. Hidden when billingType === 'free' (ROADMAP #3). */
  showCostInStatusLine?: boolean
  /** Show the context-usage meter in the status line. Gated on capabilities.contextWindow > 0. */
  showContextMeter?: boolean
  /** Show/hide the image/PDF attach affordance (button + drag/drop + paste). Gated on capabilities.vision. */
  visionEnabled?: boolean
  sandboxEnabled: boolean
  voiceEnabled: boolean
  voiceState: VoiceState
  /** The push-to-talk is held (Tab or the mic) — the notice pill stays while it is. */
  voiceHeld?: boolean
  /** The live microphone is digitally silent while recording — the mic dims. */
  voiceSilent?: boolean
  /** The one voice message to show above the mic, or null. */
  voiceNotice?: VoiceNotice | null
  /** The notice's linger ran out: remove notice `id` (and nothing newer). */
  onVoiceNoticeExpire?: (id: number) => void
  /** Subscribe to the live microphone level (0..1) for the recording mic's ring. */
  subscribeVoiceLevel?: (listener: (level: number) => void) => () => void
  statusLine: StatusLineData | null

  // Callbacks
  onSend: () => void
  onCancel: () => void
  onInput: (e: React.ChangeEvent<HTMLTextAreaElement>) => void
  onKeyDown: (e: React.KeyboardEvent) => void
  onKeyUp: (e: React.KeyboardEvent) => void
  onPaste: (e: React.ClipboardEvent) => void
  onFileChange: (e: React.ChangeEvent<HTMLInputElement>) => void
  onRemoveFile: (id: string) => void
  onSlashSelect: (name: string) => void
  onFileMentionConfirm: (entry: DirEntry) => void
  onSelectMode?: (mode: PermissionMode) => void
  onSelectModel: (value: string) => void
  onSelectEngine: (engineId: EngineId) => void
  onSelectEffort: (level: string) => void
  onSelectThinking: (mode: ThinkingMode) => void
  /** Available reasoning variant keys for the selected opencode model. Empty = hide picker. */
  reasoningVariants?: string[]
  /** Current reasoning variant selection, or null for the opencode default. */
  reasoningVariant?: string | null
  onSelectReasoningVariant?: (variant: string | null) => void
  onOpenSandboxSettings: () => void
  onVoiceStart: () => void
  onVoiceStop: () => void
}

// ---------------------------------------------------------------------------
// StatusLine (reads its own store slices — not part of InputBox props)
// ---------------------------------------------------------------------------

function StatusLine({
  data,
  showCost = true,
  showContextMeter = true
}: {
  data: StatusLineData
  showCost?: boolean
  showContextMeter?: boolean
}): React.JSX.Element {
  const align = useSessionStore((s) => s.settings.statusLineAlign)
  const rawTemplate = useSessionStore((s) => s.settings.statusLineTemplate)

  // Strip the cost placeholder when the engine doesn't report cost. An
  // unavailable context meter renders as the SAME em-dash `interpolateTemplate`
  // uses for a null percentage: stripping the placeholder left a bare `%` in
  // the default template, a third spelling of "unknown" that read as a bug.
  let template = showCost ? rawTemplate : rawTemplate.replace(/\{cost\}/g, '')
  if (!showContextMeter) {
    template = template.replace(/\{used\}/g, '–').replace(/\{remaining\}/g, '–')
  }

  // usedPercentage/remainingPercentage are computed in the main process (live:
  // claude-session, history: session-history), keyed on the *resolved* model id
  // so the `default` alias and implicit-1M models (Fable 5, Opus 4.8) resolve
  // correctly. setModel re-emits the status line on a model switch, so trusting
  // the main-computed value stays reactive without duplicating window logic here.
  return (
    <div
      data-testid="InputBox.statusLine"
      className={`text-[10px] text-text-muted ${ALIGN_CLASS[align]} pt-1.5 select-none truncate`}
    >
      {interpolateTemplate(template, data)}
    </div>
  )
}

const ALIGN_CLASS = {
  left: 'text-left px-4',
  center: 'text-center',
  right: 'text-right px-4'
} as const

// ---------------------------------------------------------------------------
// Sub-components — each receives props from InputBoxView
// ---------------------------------------------------------------------------

function AttachMenu({
  fileInputRef,
  onFileChange
}: {
  fileInputRef: React.RefObject<HTMLInputElement | null>
  onFileChange: (e: React.ChangeEvent<HTMLInputElement>) => void
}): React.JSX.Element {
  const [open, setOpen] = useState(false)

  return (
    <div className="relative shrink-0">
      <button
        onClick={(e) => {
          e.stopPropagation()
          setOpen(!open)
        }}
        className="w-7 h-7 flex items-center justify-center rounded-lg text-text-muted hover:text-text-secondary hover:bg-bg-hover transition-colors cursor-pointer"
      >
        <svg
          width="16"
          height="16"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
        >
          <line x1="12" y1="5" x2="12" y2="19" />
          <line x1="5" y1="12" x2="19" y2="12" />
        </svg>
      </button>
      {open && (
        <div className="absolute bottom-full mb-1 left-0 w-48 bg-bg-tertiary border border-border rounded-lg overflow-hidden shadow-lg shadow-black/30 z-20">
          <button
            onClick={() => {
              setOpen(false)
              fileInputRef.current?.click()
            }}
            className="w-full flex items-center gap-2.5 px-3 h-9 text-[12px] text-text-secondary hover:bg-bg-hover hover:text-text-primary transition-colors cursor-pointer"
          >
            <svg
              width="14"
              height="14"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.8"
              strokeLinecap="round"
              strokeLinejoin="round"
              className="text-text-muted"
            >
              <path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48" />
            </svg>
            Attach file
          </button>
        </div>
      )}
      <input
        ref={fileInputRef}
        type="file"
        accept="image/jpeg,image/png,image/gif,image/webp,application/pdf"
        multiple
        className="hidden"
        onChange={onFileChange}
      />
    </div>
  )
}

/** How long a released notice lingers, its fade included (Approved UI). */
export const VOICE_NOTICE_LINGER_MS = 5000
/** The fade-out at the end of the linger. */
export const VOICE_NOTICE_FADE_MS = 400
/** How much the level ring grows at full level (scale 1 → 1 + this). */
const VOICE_RING_GROWTH = 0.45

/**
 * The one voice message, as a pill above the mic with its tail pointing at it:
 * grey for an outcome, amber for an error or something to fix (`data-tone`).
 *
 * The fade rule: while the push-to-talk is HELD the notice stays. Once released
 * — or for a notice that arrives while not held — it lingers
 * {@link VOICE_NOTICE_LINGER_MS}, fading out over the last
 * {@link VOICE_NOTICE_FADE_MS}, and is then removed. Hovering holds it; leaving
 * restarts the linger. A replacement (new `id`) restarts it too. Reduced motion:
 * no fade or entrance, the same timing.
 *
 * Mounted only while there is a notice, so the hover state never outlives one.
 * It lives on the input box (above its top edge, where it covers nothing being
 * typed) and is aligned to the mic by measurement — the mic's distance from the
 * box's right edge depends on the controls beside it — re-measured whenever the
 * window or the box resizes.
 */
function VoiceNoticePill({
  notice,
  held,
  onExpire,
  micRef
}: {
  notice: VoiceNotice
  held: boolean
  onExpire?: (id: number) => void
  micRef: React.RefObject<HTMLButtonElement | null>
}): React.JSX.Element {
  const pillRef = useRef<HTMLDivElement>(null)
  const [hovered, setHovered] = useState(false)
  const [fading, setFading] = useState(false)
  const [place, setPlace] = useState<{ right: number; maxWidth: number } | null>(null)
  const onExpireRef = useRef(onExpire)
  onExpireRef.current = onExpire
  const { id, text, tone } = notice

  useEffect(() => {
    setFading(false)
    if (held || hovered) return
    const fade = setTimeout(() => setFading(true), VOICE_NOTICE_LINGER_MS - VOICE_NOTICE_FADE_MS)
    const expire = setTimeout(() => onExpireRef.current?.(id), VOICE_NOTICE_LINGER_MS)
    return () => {
      clearTimeout(fade)
      clearTimeout(expire)
    }
  }, [id, held, hovered])

  // The box is the pill's own parent — read through the pill's ref, which is
  // attached before this layout effect runs (a parent's ref is not yet, when
  // both mount in one commit). The mic is a later sibling subtree, so a commit
  // that mounts both gets one more measurement on the next frame.
  useLayoutEffect(() => {
    const box = pillRef.current?.parentElement ?? null
    const measure = (): void => {
      const boxRect = box?.getBoundingClientRect()
      const micRect = micRef.current?.getBoundingClientRect()
      if (!boxRect || !micRect || boxRect.width === 0) return
      setPlace({
        right: Math.max(0, boxRect.right - micRect.right),
        maxWidth: micRect.right - boxRect.left
      })
    }
    measure()
    const frame = requestAnimationFrame(measure)
    window.addEventListener('resize', measure)
    // The box resizes without the window doing so — a control appearing beside
    // the mic, a sidebar opening — and the tail must stay over the mic.
    const observer =
      box && typeof ResizeObserver !== 'undefined' ? new ResizeObserver(measure) : null
    if (box) observer?.observe(box)
    return () => {
      cancelAnimationFrame(frame)
      window.removeEventListener('resize', measure)
      observer?.disconnect()
    }
  }, [micRef])

  const toneClass =
    tone === 'info' ? 'text-text-secondary border-border-bright' : 'text-warning border-warning/40'
  return (
    <div
      ref={pillRef}
      data-testid="InputBox.voiceNotice"
      data-tone={tone}
      data-fading={fading || undefined}
      role="status"
      aria-live="polite"
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      style={{
        transitionDuration: `${VOICE_NOTICE_FADE_MS}ms`,
        ...(place ? { right: place.right, maxWidth: place.maxWidth } : {})
      }}
      // The entrance is `motion-safe:` rather than `animate-fade-in` +
      // `motion-reduce:animate-none`: main.css's `.animate-fade-in` is unlayered,
      // so it would beat any layered Tailwind override.
      className={`absolute bottom-full right-0 mb-2 z-30 w-max motion-safe:animate-[fade-in_0.15s_ease-out] transition-opacity ease-out motion-reduce:transition-none ${
        fading ? 'opacity-0 motion-reduce:opacity-100' : 'opacity-100'
      }`}
    >
      <div
        className={`flex items-center gap-2 rounded-[14px] border bg-bg-tertiary px-3 py-1 text-[12px] leading-[18px] shadow-lg shadow-black/30 ${toneClass}`}
      >
        <span
          aria-hidden
          className={`w-1.5 h-1.5 shrink-0 rounded-full ${tone === 'info' ? 'bg-text-muted' : 'bg-warning'}`}
        />
        <span>{text}</span>
      </div>
      {/* The tail, centred over the mic (a 28 px button: 14 px in from its right edge). */}
      <div
        aria-hidden
        className={`absolute right-[9px] -bottom-[5px] w-2.5 h-2.5 rotate-45 border-r border-b bg-bg-tertiary ${
          tone === 'info' ? 'border-border-bright' : 'border-warning/40'
        }`}
      />
    </div>
  )
}

function VoiceButton({
  voiceEnabled,
  voiceState,
  voiceSilent,
  isDisabled,
  buttonRef,
  subscribeLevel,
  onVoiceStart,
  onVoiceStop
}: {
  voiceEnabled: boolean
  voiceState: VoiceState
  voiceSilent: boolean
  isDisabled: boolean
  buttonRef: React.RefObject<HTMLButtonElement | null>
  subscribeLevel?: (listener: (level: number) => void) => () => void
  onVoiceStart: () => void
  onVoiceStop: () => void
}): React.JSX.Element | null {
  /**
   * TOUCH is not decoration here (phase 5 S3). Hold-to-talk was mouse-only, and
   * a mobile browser synthesizes the compatibility mouse pair only AFTER
   * `touchend` — so a press-and-hold on a phone produced mousedown+mouseup back
   * to back, i.e. a zero-length capture, and `onMouseLeave` never fired at all.
   * That makes remote voice input, whose whole point is speaking into a phone,
   * unusable.
   *
   * **Why this is a native listener and not `onTouchStart`.** React registers
   * `touchstart` (with `touchmove` and `wheel`) as a PASSIVE root listener, so
   * `e.preventDefault()` inside a React `onTouchStart` handler is silently
   * ignored — the synthesized mouse pair would still arrive and start a SECOND
   * capture the moment the first one finished. That second start is not merely
   * noise: server-side it tears the finalizing capture down, which is exactly
   * the moment the last transcript is being flushed. The suppression has to be
   * real, so the listener is attached directly with `{ passive: false }`.
   *
   * `startRef` keeps the effect's dependency list empty: the callback identity
   * changes on every parent render (InputBox does not memoize), and re-binding a
   * DOM listener per keystroke to call the same function is pure churn.
   */
  const startRef = useRef(onVoiceStart)
  startRef.current = onVoiceStart

  useEffect(() => {
    const el = buttonRef.current
    if (!el) return
    const handleTouchStart = (e: TouchEvent): void => {
      e.preventDefault()
      startRef.current()
    }
    el.addEventListener('touchstart', handleTouchStart, { passive: false })
    return () => el.removeEventListener('touchstart', handleTouchStart)
    // Bound once per mounted button; `voiceEnabled: false` unmounts it entirely.
  }, [voiceEnabled, buttonRef])

  /**
   * The level ring follows the microphone WITHOUT a React render per block: the
   * newest level is written straight to the ring's transform, at most once per
   * animation frame (blocks arrive every ~150 ms; frames far more often, so the
   * throttle only matters for a burst — the drained pre-arm queue).
   */
  const ringRef = useRef<HTMLSpanElement>(null)
  const showRing = voiceState === 'recording' && !voiceSilent
  useEffect(() => {
    if (!showRing || !subscribeLevel) return
    let frame = 0
    let latest = 0
    const off = subscribeLevel((level) => {
      latest = level
      if (frame) return
      frame = requestAnimationFrame(() => {
        frame = 0
        const ring = ringRef.current
        if (ring) ring.style.transform = `scale(${1 + Math.min(1, latest) * VOICE_RING_GROWTH})`
      })
    })
    return () => {
      off()
      if (frame) cancelAnimationFrame(frame)
    }
  }, [showRing, subscribeLevel])

  // AFTER the hooks — a conditional return above them would break the rules of
  // hooks the moment the voice setting is toggled at runtime.
  if (!voiceEnabled) return null

  const live = voiceState === 'recording' || voiceState === 'connecting'
  return (
    <button
      data-testid="InputBox.voice"
      data-state={voiceState}
      data-silent={voiceSilent || undefined}
      ref={buttonRef}
      onMouseDown={(e) => {
        e.preventDefault()
        onVoiceStart()
      }}
      onMouseUp={onVoiceStop}
      onMouseLeave={(e) => {
        // Primary button still down: the press is being abandoned, even if it is
        // still spawning the session and the state has not left idle yet — a
        // release elsewhere would never reach this button's mouseup.
        if (live || (e.buttons & 1) === 1) onVoiceStop()
      }}
      // The release half stays on React's synthetic events: only `touchstart` is
      // passive, and only the start needs to preventDefault.
      onTouchEnd={onVoiceStop}
      // A gesture the OS took over (an incoming call, a system swipe) ends with
      // `touchcancel` and no `touchend`. Without this the microphone would stay
      // open with nobody holding the button.
      onTouchCancel={onVoiceStop}
      disabled={isDisabled || voiceState === 'processing'}
      title="Hold to record"
      // Connecting: the mic is already open (nothing said is lost) — a pulse.
      // Recording: a filled disc with the level ring around it, dimmed while the
      // microphone is digitally silent. Processing: a spinner while the last
      // words come back. Not faded when merely busy — only when unavailable.
      className={`relative w-7 h-7 flex items-center justify-center rounded-lg transition-colors cursor-pointer disabled:cursor-default ${
        isDisabled ? 'opacity-15' : ''
      } ${
        voiceState === 'recording'
          ? voiceSilent
            ? 'text-white/70'
            : 'text-white'
          : voiceState === 'connecting'
            ? 'text-accent animate-pulse motion-reduce:animate-none'
            : voiceState === 'processing'
              ? 'text-accent'
              : 'text-text-muted hover:text-text-secondary hover:bg-bg-hover'
      }`}
    >
      {voiceState === 'recording' && (
        <>
          {showRing && (
            <span
              data-testid="InputBox.voiceLevel"
              ref={ringRef}
              aria-hidden
              className="absolute inset-0 rounded-full bg-danger/30 pointer-events-none transition-transform duration-75 motion-reduce:transition-none"
            />
          )}
          <span
            aria-hidden
            className={`absolute inset-0.5 rounded-full pointer-events-none ${
              voiceSilent ? 'bg-danger/45' : 'bg-danger'
            }`}
          />
        </>
      )}
      {voiceState === 'processing' && (
        <span
          aria-hidden
          className="absolute inset-0 rounded-full border-2 border-accent/30 border-t-accent pointer-events-none animate-spin motion-reduce:animate-none"
        />
      )}
      <svg
        className="relative"
        width="14"
        height="14"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <path d="M12 1a3 3 0 00-3 3v8a3 3 0 006 0V4a3 3 0 00-3-3z" />
        <path d="M19 10v2a7 7 0 01-14 0v-2" />
        <line x1="12" y1="19" x2="12" y2="23" />
        <line x1="8" y1="23" x2="16" y2="23" />
      </svg>
    </button>
  )
}

function SandboxPill({
  sandboxEnabled,
  onOpenSandboxSettings
}: {
  sandboxEnabled: boolean
  onOpenSandboxSettings: () => void
}): React.JSX.Element | null {
  if (!sandboxEnabled) return null

  return (
    <button
      onClick={onOpenSandboxSettings}
      className="h-7 px-2 flex items-center gap-1 rounded-lg text-[11px] text-success/70 hover:text-success hover:bg-success/5 transition-colors cursor-pointer shrink-0"
      title="Sandbox enabled — click to configure"
    >
      <svg
        width="10"
        height="10"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <rect x="3" y="11" width="18" height="11" rx="2" ry="2" />
        <path d="M7 11V7a5 5 0 0110 0v4" />
      </svg>
      <span>Sandboxed</span>
    </button>
  )
}

// ---------------------------------------------------------------------------
// Utility functions (pure, no store access)
// ---------------------------------------------------------------------------

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

function interpolateTemplate(template: string, data: StatusLineData): string {
  return (
    template
      .replace(/\{in\}/g, formatTokens(data.totalInputTokens))
      .replace(/\{out\}/g, formatTokens(data.totalOutputTokens))
      .replace(/\{cached\}/g, formatTokens(data.cachedTokens))
      .replace(/\{total\}/g, formatTokens(data.totalTokens))
      // null = unpriced/unknown, which renders as the word rather than a
      // fabricated "$0.00" (see SessionStatus.totalCostUsd).
      .replace(/\{cost\}/g, formatCostOrUnknown(data.totalCostUsd))
      .replace(/\{used\}/g, data.usedPercentage !== null ? String(data.usedPercentage) : '–')
      .replace(
        /\{remaining\}/g,
        data.usedPercentage !== null ? String(100 - data.usedPercentage) : '–'
      )
      .replace(/\{duration\}/g, formatDuration(data.totalDurationMs))
  )
}

// ---------------------------------------------------------------------------
// Main view — layout shell that composes sub-components via props
// ---------------------------------------------------------------------------

export function InputBoxView(props: InputBoxViewProps): React.JSX.Element {
  const {
    isMobile,
    textareaRef,
    text,
    displayValue,
    isDisabled,
    isRunning,
    isVoiceActive,
    placeholder,
    textClassName,
    permissionMode,
    slashMenuOpen,
    slashCommands,
    slashFilter,
    slashMenuIndex,
    filteredSlashCommands,
    fileMentionOpen,
    fileMentionIndex,
    filteredFileMentionEntries,
    attachedFiles,
    statusLine,
    onSend,
    onCancel,
    onInput,
    onKeyDown,
    onKeyUp,
    onPaste,
    onRemoveFile,
    onSlashSelect,
    onFileMentionConfirm
  } = props

  // The mic, for the voice notice pill to align itself by.
  const micRef = useRef<HTMLButtonElement>(null)

  // Close any open dropdown on outside click — sub-components manage their own
  // open state, but this handles clicks outside the entire input box
  const [, setTick] = useState(0)
  useEffect(() => {
    // Force a re-render when clicking outside to close sub-component dropdowns
    // Sub-components close themselves via stopPropagation + local state
    const handler = (): void => setTick((t) => t + 1)
    document.addEventListener('click', handler)
    return () => document.removeEventListener('click', handler)
  }, [])

  return (
    <div
      data-testid="InputBox"
      style={{
        padding: isMobile ? '8px 8px 16px' : '8px 13px 16px',
        paddingBottom: isMobile ? 'max(16px, env(safe-area-inset-bottom))' : '16px'
      }}
      className="shrink-0"
    >
      <div className={`${isMobile ? 'max-w-full' : 'max-w-[740px]'} mx-auto`}>
        {props.banner}
        <div
          className={`group relative rounded-2xl bg-bg-input transition-colors ${
            permissionMode === 'acceptEdits'
              ? 'border border-mode-edit-dim focus-within:border-mode-edit'
              : permissionMode === 'plan'
                ? 'border border-mode-plan-dim focus-within:border-mode-plan'
                : permissionMode === 'auto'
                  ? 'border border-mode-auto-dim focus-within:border-mode-auto'
                  : 'shadow-[0_1px_6px_rgba(0,0,0,0.12),0_2px_16px_rgba(0,0,0,0.08)] focus-within:shadow-[0_1px_8px_rgba(0,0,0,0.18),0_4px_20px_rgba(0,0,0,0.12)]'
          }`}
        >
          {/* Mode tab */}
          {permissionMode !== 'default' && (
            <div
              data-testid="InputBox.modeTab"
              data-mode={permissionMode}
              className={`absolute bottom-full left-3 px-1.5 pt-0.5 pb-px rounded-t text-[9px] font-semibold tracking-wider uppercase text-text-primary border border-b-0 transition-colors ${
                permissionMode === 'acceptEdits'
                  ? 'border-mode-edit-dim group-focus-within:border-mode-edit bg-mode-edit-dim group-focus-within:bg-mode-edit'
                  : permissionMode === 'auto'
                    ? 'border-mode-auto-dim group-focus-within:border-mode-auto bg-mode-auto-dim group-focus-within:bg-mode-auto'
                    : 'border-mode-plan-dim group-focus-within:border-mode-plan bg-mode-plan-dim group-focus-within:bg-mode-plan'
              }`}
            >
              {permissionMode === 'acceptEdits'
                ? 'Accept Edits'
                : permissionMode === 'auto'
                  ? 'Auto ⏵⏵'
                  : 'Plan'}
            </div>
          )}

          {/* The agent tab — the mode tab's mirror on the opposite corner of the
              same edge, so neither can collide with the other and neither costs
              the composer any height (ADR-073). Self-hides when nothing runs. */}
          <AgentTab />

          {/* The voice notice — one pill above the mic, its tail pointing down at it. */}
          {props.voiceEnabled && props.voiceNotice && (
            <VoiceNoticePill
              notice={props.voiceNotice}
              held={props.voiceHeld ?? false}
              onExpire={props.onVoiceNoticeExpire}
              micRef={micRef}
            />
          )}

          {/* Slash command autocomplete */}
          {slashMenuOpen && filteredSlashCommands.length > 0 && (
            <SlashCommandMenu
              commands={slashCommands}
              filter={slashFilter}
              selectedIndex={slashMenuIndex}
              onSelect={onSlashSelect}
            />
          )}

          {/* @ file mention autocomplete */}
          {fileMentionOpen &&
            (filteredFileMentionEntries.length > 0 ? (
              <FileMentionMenu
                entries={filteredFileMentionEntries}
                selectedIndex={fileMentionIndex}
                onSelect={onFileMentionConfirm}
              />
            ) : (
              <div className="absolute bottom-full left-0 mb-1 w-72 rounded-lg border border-[var(--border-primary)] bg-[var(--bg-secondary)] px-3 py-2 text-xs text-[var(--text-tertiary)] shadow-lg">
                No matching files
              </div>
            ))}

          {/* File preview row */}
          <FileAttachmentBar attachments={attachedFiles} onRemove={onRemoveFile} />

          {/* Textarea */}
          <textarea
            data-testid="InputBox.textarea"
            ref={textareaRef}
            value={displayValue}
            onChange={onInput}
            onKeyDown={onKeyDown}
            onKeyUp={onKeyUp}
            onPaste={onPaste}
            readOnly={isVoiceActive}
            placeholder={placeholder}
            disabled={isDisabled}
            rows={2}
            className={`w-full bg-transparent text-[13px] placeholder:text-text-muted pt-2 pl-3 pr-2 pb-1 resize-none outline-none disabled:opacity-30 leading-relaxed ${textClassName}`}
          />

          {/* Controls bar */}
          <div className="flex items-center justify-between px-1.5 pb-1.5">
            {/* Left controls */}
            <div className="flex items-center gap-1 min-w-0 flex-1">
              {(props.visionEnabled ?? true) && (
                <AttachMenu fileInputRef={props.fileInputRef} onFileChange={props.onFileChange} />
              )}
              {isMobile ? (
                <MobileConfigSheet
                  models={props.models}
                  selectedModel={
                    props.modelNotice
                      ? {
                          ...props.selectedModel,
                          value: '',
                          displayName: props.modelNotice,
                          shortName: props.modelNotice
                        }
                      : props.selectedModel
                  }
                  selectedEngineId={props.selectedEngineId}
                  engineLocked={props.engineLocked}
                  showModePicker={props.showModePicker ?? false}
                  permissionMode={props.permissionMode as PermissionMode}
                  canPlan={props.canPlan ?? true}
                  autoAvailable={props.autoAvailable ?? true}
                  showEnginePicker={props.showEnginePicker}
                  showModelPicker={props.showModelPicker ?? true}
                  showThinkingPicker={props.showThinkingPicker ?? true}
                  thinkingMode={props.thinkingMode}
                  adaptiveSupported={props.adaptiveSupported}
                  reasoningVariants={props.reasoningVariants ?? []}
                  reasoningVariant={props.reasoningVariant ?? null}
                  effort={props.effort}
                  effortSupported={props.effortSupported}
                  allowedEffortLevels={props.allowedEffortLevels}
                  nativeEffortOptions={props.nativeEffortOptions}
                  showAccountPicker={props.showAccountPicker ?? false}
                  accounts={props.accounts ?? []}
                  activeAccountId={props.activeAccountId ?? null}
                  pinnedAccountId={props.pinnedAccountId ?? null}
                  onSelectAccount={props.onSelectAccount ?? (() => {})}
                  onAddAccount={props.onAddAccount ?? (() => {})}
                  onAccountMenuOpen={props.onAccountMenuOpen}
                  onSelectMode={props.onSelectMode ?? (() => {})}
                  onSelectEngine={props.onSelectEngine}
                  onSelectModel={props.onSelectModel}
                  onSelectThinking={props.onSelectThinking}
                  onSelectReasoningVariant={props.onSelectReasoningVariant ?? (() => {})}
                  onSelectEffort={props.onSelectEffort}
                />
              ) : (
                <>
                  {props.showEnginePicker && (
                    <EnginePicker
                      selectedEngineId={props.selectedEngineId}
                      locked={props.engineLocked}
                      onSelectEngine={props.onSelectEngine}
                    />
                  )}
                  {(props.showModelPicker ?? true) &&
                    (props.modelNotice ? (
                      <span
                        data-testid="InputBox.modelNotice"
                        className="h-7 px-2 flex items-center text-[11px] text-text-muted truncate"
                      >
                        {props.modelNotice}
                      </span>
                    ) : (
                      <ModelPicker
                        models={props.models}
                        selectedModel={props.selectedModel}
                        onSelectModel={props.onSelectModel}
                      />
                    ))}
                  {(props.showThinkingPicker ?? true) && (
                    <ThinkingPicker
                      thinkingMode={props.thinkingMode}
                      adaptiveSupported={props.adaptiveSupported}
                      onSelectThinking={props.onSelectThinking}
                    />
                  )}
                  {(props.reasoningVariants?.length ?? 0) > 0 && (
                    <ReasoningPicker
                      variants={props.reasoningVariants!}
                      selected={props.reasoningVariant ?? null}
                      onSelect={props.onSelectReasoningVariant ?? (() => {})}
                    />
                  )}
                  <EffortPicker
                    effort={props.effort}
                    allowedEffortLevels={props.allowedEffortLevels}
                    nativeOptions={props.nativeEffortOptions}
                    supported={props.effortSupported}
                    onSelectEffort={props.onSelectEffort}
                  />
                  {props.showAccountPicker && (
                    <AccountPicker
                      accounts={props.accounts ?? []}
                      activeAccountId={props.activeAccountId ?? null}
                      pinned={props.pinnedAccountId ?? null}
                      onSelectAccount={props.onSelectAccount ?? (() => {})}
                      onAddAccount={props.onAddAccount ?? (() => {})}
                      onOpen={props.onAccountMenuOpen}
                    />
                  )}
                </>
              )}
              <SandboxPill
                sandboxEnabled={props.sandboxEnabled}
                onOpenSandboxSettings={props.onOpenSandboxSettings}
              />
            </div>

            {/* Right controls */}
            <div className="flex items-center gap-1.5 shrink-0">
              {isRunning && (
                <button
                  data-testid="InputBox.cancel"
                  onClick={onCancel}
                  className="h-7 px-2.5 flex items-center gap-1.5 text-[11px] text-text-secondary rounded-lg border border-border hover:border-border-bright transition-colors cursor-pointer"
                >
                  <svg width="8" height="8" viewBox="0 0 24 24" fill="currentColor">
                    <rect x="4" y="4" width="16" height="16" rx="2" />
                  </svg>
                  Stop
                </button>
              )}
              <VoiceButton
                voiceEnabled={props.voiceEnabled}
                voiceState={props.voiceState}
                voiceSilent={props.voiceSilent ?? false}
                isDisabled={isDisabled}
                buttonRef={micRef}
                subscribeLevel={props.subscribeVoiceLevel}
                onVoiceStart={props.onVoiceStart}
                onVoiceStop={props.onVoiceStop}
              />
              <button
                data-testid="InputBox.send"
                onClick={onSend}
                disabled={
                  (!text.trim() && attachedFiles.length === 0) || isDisabled || !!props.sendBlocked
                }
                title={isRunning ? 'Queue message' : 'Send message'}
                className="w-7 h-7 flex items-center justify-center rounded-full bg-text-primary text-bg-primary transition-opacity disabled:opacity-15 cursor-pointer disabled:cursor-default"
              >
                <svg
                  width="13"
                  height="13"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2.5"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <line x1="12" y1="19" x2="12" y2="5" />
                  <polyline points="5 12 12 5 19 12" />
                </svg>
              </button>
            </div>
          </div>
        </div>
        <StatusLine
          data={statusLine ?? DEFAULT_STATUS_LINE}
          showCost={props.showCostInStatusLine ?? true}
          showContextMeter={props.showContextMeter ?? true}
        />
      </div>
    </div>
  )
}
