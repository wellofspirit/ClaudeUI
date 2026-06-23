/**
 * Inline picker dropdowns used in the InputBox controls bar and in the
 * AutomationConfig form. Sharing keeps capability-awareness (effort levels,
 * adaptive-thinking support) consistent wherever the user picks a model.
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import {
  EFFORT_LEVELS,
  THINKING_MODES,
  type EffortLevel,
  type ThinkingMode
} from '../../../../shared/model-capabilities'
import type { EngineId, VendorId } from '../../../../shared/types'

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

function unsupportedTooltip(level: EffortLevel): string {
  if (level === 'xhigh') return 'xhigh effort is only available on Opus 4.7'
  if (level === 'max') return 'max effort is not supported on this model'
  return 'Not supported on this model'
}

/** Derive groups from a flat model list by (engineId, vendorId) pairing. */
function deriveModelGroups(
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
      const engineLabel = engineId === 'claude' ? 'Claude' : engineId
      groupMap.set(key, { label: `${engineLabel} · ${vendorLabel}`, items: [] })
    }
    groupMap.get(key)!.items.push(m)
  }
  return Array.from(groupMap.entries()).map(([key, g]) => ({ key, ...g }))
}

export function ModelPicker({
  models,
  selectedModel,
  onSelectModel
}: {
  models: ModelDisplay[]
  selectedModel: ModelDisplay
  onSelectModel: (value: string) => void
}): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement | null>(null)
  useClickOutside(ref, open, () => setOpen(false))

  // Derive groups only when models change (avoids re-grouping every render)
  const groups = useMemo(() => deriveModelGroups(models), [models])
  const isGrouped = groups.length > 1

  return (
    <div className="relative" ref={ref}>
      <button
        onClick={(e) => {
          e.stopPropagation()
          setOpen(!open)
        }}
        className="h-7 px-2 flex items-center gap-1 rounded-lg text-[11px] text-text-muted hover:text-text-secondary hover:bg-bg-hover transition-colors cursor-pointer"
        title="Model"
      >
        <span>{selectedModel.shortName}</span>
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
        <div className="absolute bottom-full mb-1 left-0 w-56 bg-bg-tertiary border border-border rounded-lg overflow-hidden shadow-lg shadow-black/30 z-20">
          {groups.map((group) => (
            <div key={group.key}>
              {isGrouped && (
                <div className="px-3 pt-2 pb-0.5 text-[10px] text-text-muted font-medium uppercase tracking-wider">
                  {group.label}
                </div>
              )}
              {group.items.map((m) => (
                <button
                  key={m.value}
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
                  <span className="text-[12px]">{m.shortName}</span>
                  {m.description && (
                    <span className="text-text-muted text-[10px]">
                      {m.description.split('·')[1]?.trim()}
                    </span>
                  )}
                </button>
              ))}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

export function EffortPicker({
  effort,
  allowedEffortLevels,
  supported,
  onSelectEffort
}: {
  effort: string
  allowedEffortLevels: readonly EffortLevel[]
  supported: boolean
  onSelectEffort: (level: EffortLevel) => void
}): React.JSX.Element | null {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement | null>(null)
  useClickOutside(ref, open, () => setOpen(false))
  if (!supported) return null
  const allowed = new Set<EffortLevel>(allowedEffortLevels)

  return (
    <div className="relative" ref={ref}>
      <button
        onClick={(e) => {
          e.stopPropagation()
          setOpen(!open)
        }}
        className="h-7 px-2 flex items-center gap-1 rounded-lg text-[11px] text-text-muted hover:text-text-secondary hover:bg-bg-hover transition-colors cursor-pointer capitalize"
        title="Effort level"
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
        <div className="absolute bottom-full mb-1 left-0 w-28 bg-bg-tertiary border border-border rounded-lg overflow-hidden shadow-lg shadow-black/30 z-20">
          {EFFORT_LEVELS.map((level) => {
            const enabled = allowed.has(level)
            return (
              <button
                key={level}
                disabled={!enabled}
                title={enabled ? undefined : unsupportedTooltip(level)}
                onClick={() => {
                  if (enabled) {
                    onSelectEffort(level)
                    setOpen(false)
                  }
                }}
                className={`w-full flex items-center px-3 h-8 text-[12px] transition-colors text-left capitalize ${
                  !enabled
                    ? 'text-text-muted opacity-40 cursor-not-allowed'
                    : level === effort
                      ? 'text-text-primary bg-bg-hover cursor-pointer'
                      : 'text-text-secondary hover:bg-bg-hover hover:text-text-primary cursor-pointer'
                }`}
              >
                {level}
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
    <div className="relative" ref={ref}>
      <button
        onClick={(e) => {
          e.stopPropagation()
          setOpen(!open)
        }}
        className="h-7 px-2 flex items-center gap-1 rounded-lg text-[11px] text-text-muted hover:text-text-secondary hover:bg-bg-hover transition-colors cursor-pointer capitalize"
        title="Reasoning variant"
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
    <div className="relative" ref={ref}>
      <button
        onClick={(e) => {
          e.stopPropagation()
          setOpen(!open)
        }}
        className="h-7 px-2 flex items-center gap-1 rounded-lg text-[11px] text-text-muted hover:text-text-secondary hover:bg-bg-hover transition-colors cursor-pointer capitalize"
        title="Thinking mode"
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
                disabled={!enabled}
                title={
                  enabled
                    ? undefined
                    : 'Adaptive thinking is only supported on Opus 4.6+, Opus 4.7, and Sonnet 4.6'
                }
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
