import { useState, useEffect } from 'react'
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
  type ModelDisplay
} from '../../shared/InlinePickers'
import { MobileConfigSheet } from './MobileConfigSheet'

export type { ModelDisplay }

const DEFAULT_STATUS_LINE: StatusLineData = {
  totalCostUsd: 0,
  totalDurationMs: 0,
  totalApiDurationMs: 0,
  totalInputTokens: 0,
  totalOutputTokens: 0,
  cachedTokens: 0,
  totalTokens: 0,
  contextWindowSize: 0,
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
  selectedEngineId: EngineId
  engineLocked: boolean
  showEnginePicker: boolean
  effort: string
  effortSupported: boolean
  allowedEffortLevels: readonly EffortLevel[]
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
  onSelectEffort: (level: EffortLevel) => void
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

  // Strip the cost placeholder when the engine doesn't report cost, and the
  // context-usage placeholders when the model has no known context window
  // (contextWindow === 0 — the meter would be meaningless).
  let template = showCost ? rawTemplate : rawTemplate.replace(/\{cost\}/g, '')
  if (!showContextMeter) {
    template = template.replace(/\{used\}/g, '').replace(/\{remaining\}/g, '')
  }

  // usedPercentage/remainingPercentage are computed in the main process (live:
  // claude-session, history: session-history), keyed on the *resolved* model id
  // so the `default` alias and implicit-1M models (Fable 5, Opus 4.8) resolve
  // correctly. setModel re-emits the status line on a model switch, so trusting
  // the main-computed value stays reactive without duplicating window logic here.
  return (
    <div
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

function VoiceButton({
  voiceEnabled,
  voiceState,
  isDisabled,
  onVoiceStart,
  onVoiceStop
}: {
  voiceEnabled: boolean
  voiceState: VoiceState
  isDisabled: boolean
  onVoiceStart: () => void
  onVoiceStop: () => void
}): React.JSX.Element | null {
  if (!voiceEnabled) return null

  return (
    <button
      data-testid="InputBox.voice"
      onMouseDown={(e) => {
        e.preventDefault()
        onVoiceStart()
      }}
      onMouseUp={onVoiceStop}
      onMouseLeave={() => {
        if (voiceState === 'recording' || voiceState === 'connecting') onVoiceStop()
      }}
      disabled={isDisabled || voiceState === 'processing'}
      title="Hold to record"
      className={`w-7 h-7 flex items-center justify-center rounded-lg transition-colors cursor-pointer disabled:cursor-default disabled:opacity-15 ${
        voiceState === 'recording' || voiceState === 'connecting'
          ? 'text-danger bg-danger/15 animate-pulse'
          : voiceState === 'processing'
            ? 'text-warning bg-warning/10'
            : 'text-text-muted hover:text-text-secondary hover:bg-bg-hover'
      }`}
    >
      <svg
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

function formatCost(usd: number): string {
  if (usd < 0.01) return '$' + usd.toFixed(4)
  return '$' + usd.toFixed(2)
}

function interpolateTemplate(template: string, data: StatusLineData): string {
  return template
    .replace(/\{in\}/g, formatTokens(data.totalInputTokens))
    .replace(/\{out\}/g, formatTokens(data.totalOutputTokens))
    .replace(/\{cached\}/g, formatTokens(data.cachedTokens))
    .replace(/\{total\}/g, formatTokens(data.totalTokens))
    .replace(/\{cost\}/g, formatCost(data.totalCostUsd))
    .replace(/\{used\}/g, data.usedPercentage !== null ? String(data.usedPercentage) : '–')
    .replace(
      /\{remaining\}/g,
      data.usedPercentage !== null ? String(100 - data.usedPercentage) : '–'
    )
    .replace(/\{duration\}/g, formatDuration(data.totalDurationMs))
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
                  selectedModel={props.selectedModel}
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
                  {(props.showModelPicker ?? true) && (
                    <ModelPicker
                      models={props.models}
                      selectedModel={props.selectedModel}
                      onSelectModel={props.onSelectModel}
                    />
                  )}
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
                    supported={props.effortSupported}
                    onSelectEffort={props.onSelectEffort}
                  />
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
                isDisabled={isDisabled}
                onVoiceStart={props.onVoiceStart}
                onVoiceStop={props.onVoiceStop}
              />
              <button
                data-testid="InputBox.send"
                onClick={onSend}
                disabled={(!text.trim() && attachedFiles.length === 0) || isDisabled}
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
