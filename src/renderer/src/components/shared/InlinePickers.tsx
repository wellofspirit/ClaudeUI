/**
 * Inline picker dropdowns used in the InputBox controls bar and in the
 * AutomationConfig form. Sharing keeps capability-awareness (effort levels,
 * adaptive-thinking support) consistent wherever the user picks a model.
 */
import { useEffect, useRef, useState } from 'react'
import {
  EFFORT_LEVELS,
  THINKING_MODES,
  type EffortLevel,
  type ThinkingMode
} from '../../../../shared/model-capabilities'

export interface ModelDisplay {
  value: string
  displayName: string
  description?: string
  shortName: string
  supportsEffort?: boolean
  supportedEffortLevels?: EffortLevel[]
  supportsAdaptiveThinking?: boolean
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
          {models.map((m) => (
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
