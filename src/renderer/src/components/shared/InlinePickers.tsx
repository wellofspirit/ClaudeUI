/**
 * Inline picker dropdowns used in the InputBox controls bar and in the
 * AutomationConfig form. Sharing keeps capability-awareness (effort levels,
 * adaptive-thinking support) consistent wherever the user picks a model.
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import { useSessionStore } from '../../stores/session-store'
import {
  EFFORT_LEVELS,
  THINKING_MODES,
  type EffortLevel,
  type ThinkingMode
} from '../../../../shared/model-capabilities'
import type { EngineId, VendorId } from '../../../../shared/types'
import { ENGINE_META, engineMeta } from '../../../../shared/engine-meta'
import { ChevronIcon } from './ChevronIcon'
import { EngineLogo } from './EngineLogo'
import { useAnchoredMenu } from './use-anchored-menu'
import { useEscapeLayer } from './use-escape-layer'

export interface ModelDisplay {
  value: string
  displayName: string
  description?: string
  shortName: string
  supportsEffort?: boolean
  supportedEffortLevels?: EffortLevel[]
  supportsAdaptiveThinking?: boolean
  /** Engine that owns this model (used for group header rendering). */
  engineId?: EngineId
  /** Vendor id within the engine (used for group header rendering). */
  vendorId?: VendorId
  /** true when the provider catalog reports zero input+output cost (e.g. opencode zen free tier). */
  free?: boolean
}

function useClickOutside(
  ref: React.RefObject<HTMLElement | null>,
  open: boolean,
  close: () => void
): void {
  useEffect(() => {
    if (!open) return
    function onDown(e: MouseEvent): void {
      const node = ref.current
      if (node && e.target instanceof Node && !node.contains(e.target)) close()
    }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [ref, open, close])
}

/** Tooltip for a disabled EffortPicker option. Shared with MobileConfigSheet's EffortPage. */
export function unsupportedTooltip(level: EffortLevel): string {
  if (level === 'xhigh') return 'xhigh effort is only available on Opus 4.7'
  if (level === 'max') return 'max effort is not supported on this model'
  return 'Not supported on this model'
}

/** Tooltip for a disabled Adaptive thinking option. Shared with MobileConfigSheet's ThinkingPage. */
export const ADAPTIVE_UNSUPPORTED_TOOLTIP =
  'Adaptive thinking is only supported on Opus 4.6+, Opus 4.7, and Sonnet 4.6'

/** Derive groups from a flat model list by (engineId, vendorId) pairing. Shared with MobileConfigSheet's ModelPage. */
export function deriveModelGroups(
  models: ModelDisplay[]
): Array<{ key: string; label: string; items: ModelDisplay[] }> {
  const groupMap = new Map<string, { label: string; items: ModelDisplay[] }>()
  for (const m of models) {
    const engineId = m.engineId ?? 'claude'
    const vendorId = m.vendorId ?? 'anthropic'
    const key = `${engineId}:${vendorId}`
    if (!groupMap.has(key)) {
      // Build a human label: "Claude · Anthropic" or "opencode · <vendorName>"
      const vendorLabel = vendorId.charAt(0).toUpperCase() + vendorId.slice(1)
      const engineLabel = engineMeta(engineId).label
      groupMap.set(key, { label: `${engineLabel} · ${vendorLabel}`, items: [] })
    }
    groupMap.get(key)!.items.push(m)
  }
  return Array.from(groupMap.entries()).map(([key, g]) => ({ key, ...g }))
}

export function EnginePicker({
  selectedEngineId,
  locked,
  onSelectEngine
}: {
  selectedEngineId: EngineId
  locked: boolean
  onSelectEngine: (engineId: EngineId) => void
}): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement | null>(null)
  useClickOutside(ref, open, () => setOpen(false))
  const selected = engineMeta(selectedEngineId)
  const codexAvailable = useSessionStore((state) =>
    state.availableModels.some((model) => model.engineId === 'codex')
  )

  return (
    <div className="relative" ref={ref} data-testid="EnginePicker">
      <button
        type="button"
        disabled={locked}
        title={
          locked
            ? 'Engine cannot change after session initialization or for historical sessions'
            : 'Engine'
        }
        data-testid="EnginePicker.trigger"
        onClick={(e) => {
          e.stopPropagation()
          setOpen(!open)
        }}
        className="h-7 px-2 flex items-center gap-1 rounded-lg text-[11px] text-text-muted hover:text-text-secondary hover:bg-bg-hover transition-colors cursor-pointer disabled:cursor-not-allowed disabled:opacity-50"
      >
        <EngineLogo engineId={selectedEngineId} size={11} className="shrink-0" />
        <span>{selected.label}</span>
        <svg
          width="8"
          height="8"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2.5"
        >
          <polyline points="6 9 12 15 18 9" />
        </svg>
      </button>
      {open && (
        <div className="absolute bottom-full mb-1 left-0 w-36 bg-bg-tertiary border border-border rounded-lg overflow-hidden shadow-lg shadow-black/30 z-20">
          {Object.values(ENGINE_META)
            .filter((meta) => meta.id !== 'codex' || codexAvailable)
            .map((meta) => (
              <button
                key={meta.id}
                type="button"
                data-testid="EnginePicker.option"
                data-engine={meta.id}
                onClick={() => {
                  onSelectEngine(meta.id)
                  setOpen(false)
                }}
                className={`w-full flex items-center gap-2 px-3 h-8 text-[12px] transition-colors text-left cursor-pointer ${
                  meta.id === selectedEngineId
                    ? 'text-text-primary bg-bg-hover'
                    : 'text-text-secondary hover:bg-bg-hover hover:text-text-primary'
                }`}
              >
                <EngineLogo engineId={meta.id} size={12} className="shrink-0" />
                {meta.label}
              </button>
            ))}
        </div>
      )}
    </div>
  )
}

export function ModelPicker({
  models,
  selectedModel,
  onSelectModel,
  placement = 'up',
  emptyOption,
  trailingOption,
  variant = 'compact',
  width = 'min-w-[150px]'
}: {
  models: ModelDisplay[]
  selectedModel: ModelDisplay
  onSelectModel: (value: string) => void
  /** Which way the menu opens. 'up' (the default, and every pre-existing call
   *  site) suits the InputBox controls bar pinned to the window bottom; a
   *  settings panel grows downward and passes 'down' so the menu isn't clipped
   *  off the top of the scroll container. */
  placement?: 'up' | 'down'
  /** Optional pinned first row meaning "no explicit choice" — picking it calls
   *  `onSelectModel('')`. The settings judge-model pickers use it for "same as
   *  the session's model", where an empty stored value means inherit. It is NOT
   *  subject to the Free filter: it is not a model. */
  emptyOption?: { label: string }
  /** Optional pinned LAST row for a non-model escape hatch — pi's settings
   *  picker uses it for "Custom model ID…", which is a mode switch rather than
   *  a selectable model. Like `emptyOption` it bypasses the Free filter and the
   *  group headers; picking it calls `onSelectModel(trailingOption.value)`. */
  trailingOption?: { value: string; label: string }
  /** 'compact' (default; the InputBox controls bar and AutomationConfig —
   *  UNCHANGED) or 'field' — the settings row control, styled exactly like
   *  `SelectField` (settings-controls.tsx) so the two read as one control in a
   *  row (ADR-065's one row vocabulary). */
  variant?: 'compact' | 'field'
  /** field variant only: a LITERAL Tailwind width class for the trigger
   *  (Tailwind v4 cannot see built strings). Defaults to `SelectField`'s. */
  width?: string
}): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement | null>(null)
  useClickOutside(ref, open, () => setOpen(false))

  // BOTH VARIANTS: an open menu is the top Escape layer, so the key closes the
  // menu and stops there instead of falling through to the sheet or dialog
  // behind it (see use-escape-layer). A closed picker registers nothing, which
  // is what lets a settings page hold a dozen of them.
  useEscapeLayer(() => setOpen(false), true, open)

  const field = variant === 'field'

  // FIELD ONLY: the settings row control lives inside an `overflow-hidden`
  // group card, which clipped an absolutely-positioned menu (see
  // use-anchored-menu). The compact composer picker is not clipped by anything
  // and keeps its absolute menu byte-for-byte.
  const triggerRef = useRef<HTMLButtonElement | null>(null)
  const menuRef = useRef<HTMLDivElement | null>(null)
  const anchored = useAnchoredMenu({
    open: open && field,
    anchorRef: triggerRef,
    menuRef,
    placement,
    onClose: () => setOpen(false)
  })

  // Local-only filter toggle — intentionally not persisted across dropdown
  // open/close (or model list changes); it simply resets on remount.
  const [freeOnly, setFreeOnly] = useState(false)

  // Derive groups only when models change (avoids re-grouping every render)
  const groups = useMemo(() => deriveModelGroups(models), [models])
  const isGrouped = groups.length > 1
  const hasFreeModels = useMemo(() => models.some((m) => m.free), [models])
  const displayedGroups = useMemo(() => {
    // Ignore a stale toggle when the list no longer contains free models
    // (e.g. the session became engine-locked to Claude and upstream filtering
    // stripped all opencode models) — the chip is unmounted then, so an active
    // filter would otherwise leave a permanently empty dropdown.
    if (!freeOnly || !hasFreeModels) return groups
    return groups
      .map((g) => ({ ...g, items: g.items.filter((m) => m.free) }))
      .filter((g) => g.items.length > 0)
  }, [groups, freeOnly, hasFreeModels])

  return (
    <div className="relative" ref={ref} data-testid="ModelPicker" data-variant={variant}>
      <button
        ref={triggerRef}
        type="button"
        onClick={(e) => {
          e.stopPropagation()
          setOpen(!open)
        }}
        // The field trigger IS `SelectField`'s trigger (settings-controls.tsx)
        // plus the flex/centring set, spelled out literally — Tailwind v4
        // cannot see built strings, and the two controls must not drift.
        className={
          field
            ? `h-7 ${width} max-w-[min(240px,100%)] bg-bg-input border border-border rounded-md px-2.5 text-[12px] text-text-primary outline-none focus:border-accent/50 transition-colors flex items-center justify-between gap-2 text-left cursor-pointer`
            : 'h-7 px-2 flex items-center gap-1 rounded-lg text-[11px] text-text-muted hover:text-text-secondary hover:bg-bg-hover transition-colors cursor-pointer'
        }
        title="Model"
        aria-haspopup="listbox"
        aria-expanded={open}
        data-testid="ModelPicker.trigger"
      >
        {field ? (
          <span className="truncate">{selectedModel.shortName}</span>
        ) : (
          <span>{selectedModel.shortName}</span>
        )}
        {field ? (
          <ChevronIcon open={open} className="text-text-muted" testid="ModelPicker.chevron" />
        ) : (
          <svg
            width="8"
            height="8"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2.5"
            className="shrink-0"
          >
            <polyline points="6 9 12 15 18 9" />
          </svg>
        )}
      </button>
      {open && (
        <div
          ref={menuRef}
          data-side={anchored?.side}
          style={anchored?.style}
          // The field menu is placed by the hook — `position: fixed`, offsets and
          // a min-width measured from the trigger, so no `overflow` ancestor in
          // the settings tree clips it. The compact one keeps the composer's
          // absolute menu and its fixed 14rem list.
          className={
            field
              ? 'w-max max-w-[22rem] max-h-72 overflow-y-auto bg-bg-tertiary border border-border rounded-lg shadow-lg shadow-black/30 z-20'
              : `absolute ${placement === 'down' ? 'top-full mt-1' : 'bottom-full mb-1'} left-0 w-56 max-h-72 overflow-y-auto bg-bg-tertiary border border-border rounded-lg shadow-lg shadow-black/30 z-20`
          }
        >
          {emptyOption && (
            <button
              data-testid="ModelPicker.option"
              data-value=""
              onClick={() => {
                onSelectModel('')
                setOpen(false)
              }}
              className={`w-full flex flex-col px-3 py-1.5 transition-colors cursor-pointer text-left ${
                selectedModel.value === ''
                  ? 'text-text-primary bg-bg-hover'
                  : 'text-text-secondary hover:bg-bg-hover hover:text-text-primary'
              }`}
            >
              <span className="text-[12px]">{emptyOption.label}</span>
            </button>
          )}
          {hasFreeModels && (
            <div className="px-2 pt-2 pb-1 flex items-center border-b border-border/50">
              <button
                type="button"
                data-testid="ModelPicker.freeFilter"
                aria-pressed={freeOnly}
                onClick={(e) => {
                  e.stopPropagation()
                  setFreeOnly((v) => !v)
                }}
                className={`text-[10px] px-2 py-0.5 rounded-full font-medium uppercase tracking-wide transition-colors cursor-pointer border ${
                  freeOnly
                    ? 'bg-emerald-500/25 text-emerald-300 border-emerald-500/40'
                    : 'bg-bg-hover text-text-muted border-border hover:text-text-secondary'
                }`}
              >
                Free
              </button>
            </div>
          )}
          {displayedGroups.map((group) => (
            <div key={group.key}>
              {isGrouped && (
                <div className="px-3 pt-2 pb-0.5 text-[10px] text-text-muted font-medium uppercase tracking-wider">
                  {group.label}
                </div>
              )}
              {group.items.map((m) => (
                <button
                  key={m.value}
                  data-testid="ModelPicker.option"
                  data-value={m.value}
                  onClick={() => {
                    onSelectModel(m.value)
                    setOpen(false)
                  }}
                  className={`w-full flex flex-col px-3 py-1.5 transition-colors cursor-pointer text-left ${
                    m.value === selectedModel.value
                      ? 'text-text-primary bg-bg-hover'
                      : 'text-text-secondary hover:bg-bg-hover hover:text-text-primary'
                  }`}
                >
                  <span className="flex items-center gap-1.5">
                    <span className="text-[12px]">{m.shortName}</span>
                    {m.free && (
                      <span
                        data-testid="ModelPicker.freeBadge"
                        className="text-[9px] px-1 py-0.5 rounded bg-emerald-500/15 text-emerald-300 font-medium uppercase tracking-wide"
                      >
                        Free
                      </span>
                    )}
                  </span>
                  {m.description && (
                    <span className="text-text-muted text-[10px]">
                      {m.description.split('·')[1]?.trim()}
                    </span>
                  )}
                </button>
              ))}
            </div>
          ))}
          {trailingOption && (
            <button
              data-testid="ModelPicker.option"
              data-value={trailingOption.value}
              onClick={() => {
                onSelectModel(trailingOption.value)
                setOpen(false)
              }}
              className={`w-full flex flex-col px-3 py-1.5 border-t border-border/50 transition-colors cursor-pointer text-left ${
                selectedModel.value === trailingOption.value
                  ? 'text-text-primary bg-bg-hover'
                  : 'text-text-secondary hover:bg-bg-hover hover:text-text-primary'
              }`}
            >
              <span className="text-[12px]">{trailingOption.label}</span>
            </button>
          )}
        </div>
      )}
    </div>
  )
}

/**
 * `nativeOptions` REPLACES the fixed Claude ladder rather than merging with it:
 * an engine that publishes its own reasoning tiers (Codex's model catalog, via
 * `capabilities.reasoning.nativeEffort`) has no low/medium/high/xhigh/max axis
 * to grey out, and showing five inapplicable rows next to two real ones reads
 * as five broken options.
 */
export function EffortPicker({
  effort,
  allowedEffortLevels,
  nativeOptions,
  supported,
  onSelectEffort
}: {
  effort: string
  allowedEffortLevels: readonly EffortLevel[]
  nativeOptions?: ReadonlyArray<{ value: string; description: string }>
  supported: boolean
  onSelectEffort: (level: string) => void
}): React.JSX.Element | null {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement | null>(null)
  useClickOutside(ref, open, () => setOpen(false))
  if (!supported) return null
  const allowed = new Set<EffortLevel>(allowedEffortLevels)
  const options: Array<{ value: string; label: string; detail?: string; enabled: boolean }> =
    nativeOptions?.length
      ? nativeOptions.map((option) => ({
          value: option.value,
          label: option.value,
          detail: option.description,
          enabled: true
        }))
      : EFFORT_LEVELS.map((level) => ({ value: level, label: level, enabled: allowed.has(level) }))

  return (
    <div className="relative" ref={ref} data-testid="EffortPicker">
      <button
        onClick={(e) => {
          e.stopPropagation()
          setOpen(!open)
        }}
        className="h-7 px-2 flex items-center gap-1 rounded-lg text-[11px] text-text-muted hover:text-text-secondary hover:bg-bg-hover transition-colors cursor-pointer capitalize"
        title="Effort level"
        data-testid="EffortPicker.trigger"
      >
        <span>{effort}</span>
        <svg
          width="8"
          height="8"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2.5"
        >
          <polyline points="6 9 12 15 18 9" />
        </svg>
      </button>
      {open && (
        <div
          className={`absolute bottom-full mb-1 left-0 ${nativeOptions?.length ? 'w-48' : 'w-28'} bg-bg-tertiary border border-border rounded-lg overflow-hidden shadow-lg shadow-black/30 z-20`}
        >
          {options.map(({ value, label, detail, enabled }) => {
            return (
              <button
                key={value}
                data-testid="EffortPicker.option"
                data-value={value}
                disabled={!enabled}
                title={enabled ? detail : unsupportedTooltip(value as EffortLevel)}
                onClick={() => {
                  if (enabled) {
                    onSelectEffort(value)
                    setOpen(false)
                  }
                }}
                className={`w-full flex flex-col items-start px-3 py-1.5 text-[12px] transition-colors text-left capitalize ${
                  !enabled
                    ? 'text-text-muted opacity-40 cursor-not-allowed'
                    : value === effort
                      ? 'text-text-primary bg-bg-hover cursor-pointer'
                      : 'text-text-secondary hover:bg-bg-hover hover:text-text-primary cursor-pointer'
                }`}
              >
                <span>{label}</span>
                {detail && (
                  <span className="text-[10px] text-text-muted normal-case leading-tight">
                    {detail}
                  </span>
                )}
              </button>
            )
          })}
        </div>
      )}
    </div>
  )
}

/**
 * Reasoning variant picker for opencode models.
 * Renders when the selected model has `reasoningVariants.length > 0`.
 * Options: "Default" (null) + the model's variant keys.
 * Claude models have no variants → hidden.
 */
export function ReasoningPicker({
  variants,
  selected,
  onSelect
}: {
  /** The available variant keys for the currently selected model. */
  variants: string[]
  /** The currently selected variant, or null for the opencode default. */
  selected: string | null
  onSelect: (variant: string | null) => void
}): React.JSX.Element | null {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement | null>(null)
  useClickOutside(ref, open, () => setOpen(false))

  if (variants.length === 0) return null

  const displayLabel = selected ?? 'Default'

  return (
    <div className="relative" ref={ref} data-testid="ReasoningPicker">
      <button
        onClick={(e) => {
          e.stopPropagation()
          setOpen(!open)
        }}
        className="h-7 px-2 flex items-center gap-1 rounded-lg text-[11px] text-text-muted hover:text-text-secondary hover:bg-bg-hover transition-colors cursor-pointer capitalize"
        title="Reasoning variant"
        data-testid="ReasoningPicker.trigger"
      >
        <span>{displayLabel}</span>
        <svg
          width="8"
          height="8"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2.5"
        >
          <polyline points="6 9 12 15 18 9" />
        </svg>
      </button>
      {open && (
        <div className="absolute bottom-full mb-1 left-0 w-28 bg-bg-tertiary border border-border rounded-lg overflow-hidden shadow-lg shadow-black/30 z-20">
          {(['Default', ...variants] as const).map((option) => {
            const value = option === 'Default' ? null : (option as string)
            const isActive = value === selected
            return (
              <button
                key={option}
                data-testid="ReasoningPicker.option"
                data-value={option}
                onClick={() => {
                  onSelect(value)
                  setOpen(false)
                }}
                className={`w-full flex items-center px-3 h-8 text-[12px] transition-colors text-left capitalize cursor-pointer ${
                  isActive
                    ? 'text-text-primary bg-bg-hover'
                    : 'text-text-secondary hover:bg-bg-hover hover:text-text-primary'
                }`}
              >
                {option}
              </button>
            )
          })}
        </div>
      )}
    </div>
  )
}

export function ThinkingPicker({
  thinkingMode,
  adaptiveSupported,
  onSelectThinking
}: {
  thinkingMode: ThinkingMode
  adaptiveSupported: boolean
  onSelectThinking: (mode: ThinkingMode) => void
}): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement | null>(null)
  useClickOutside(ref, open, () => setOpen(false))

  return (
    <div className="relative" ref={ref} data-testid="ThinkingPicker">
      <button
        onClick={(e) => {
          e.stopPropagation()
          setOpen(!open)
        }}
        className="h-7 px-2 flex items-center gap-1 rounded-lg text-[11px] text-text-muted hover:text-text-secondary hover:bg-bg-hover transition-colors cursor-pointer capitalize"
        title="Thinking mode"
        data-testid="ThinkingPicker.trigger"
      >
        <span>{thinkingMode}</span>
        <svg
          width="8"
          height="8"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2.5"
        >
          <polyline points="6 9 12 15 18 9" />
        </svg>
      </button>
      {open && (
        <div className="absolute bottom-full mb-1 left-0 w-32 bg-bg-tertiary border border-border rounded-lg overflow-hidden shadow-lg shadow-black/30 z-20">
          {THINKING_MODES.map((mode) => {
            const enabled = mode !== 'adaptive' || adaptiveSupported
            return (
              <button
                key={mode}
                data-testid="ThinkingPicker.option"
                data-value={mode}
                disabled={!enabled}
                title={enabled ? undefined : ADAPTIVE_UNSUPPORTED_TOOLTIP}
                onClick={() => {
                  if (enabled) {
                    onSelectThinking(mode)
                    setOpen(false)
                  }
                }}
                className={`w-full flex items-center px-3 h-8 text-[12px] transition-colors text-left capitalize ${
                  !enabled
                    ? 'text-text-muted opacity-40 cursor-not-allowed'
                    : mode === thinkingMode
                      ? 'text-text-primary bg-bg-hover cursor-pointer'
                      : 'text-text-secondary hover:bg-bg-hover hover:text-text-primary cursor-pointer'
                }`}
              >
                {mode}
              </button>
            )
          })}
        </div>
      )}
    </div>
  )
}
