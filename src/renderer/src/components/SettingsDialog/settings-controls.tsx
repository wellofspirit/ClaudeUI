import { useEffect, useState } from 'react'

// ── Shared setting control components ────────────────────────────────

export function SettingsToggle({
  label,
  checked,
  onChange,
  tooltip,
  testid
}: {
  label: string
  checked: boolean
  onChange: (value: boolean) => void
  tooltip?: string
  testid?: string
}): React.JSX.Element {
  return (
    <button
      data-testid={testid ?? 'SettingsToggle'}
      onClick={() => onChange(!checked)}
      className="w-full flex items-center justify-between px-3 py-1.5 text-[13px] text-text-secondary hover:bg-bg-hover rounded transition-colors cursor-default"
    >
      <span className="flex items-center gap-1">
        {label}
        {tooltip && <InfoTooltip text={tooltip} />}
      </span>
      <span
        className={`w-7 h-4 rounded-full relative transition-colors ${checked ? 'bg-accent' : 'bg-text-muted/30'}`}
      >
        <span
          className={`absolute top-0.5 w-3 h-3 rounded-full bg-white transition-transform ${checked ? 'left-3.5' : 'left-0.5'}`}
        />
      </span>
    </button>
  )
}

export function SettingsSlider({
  label,
  value,
  min,
  max,
  step,
  onChange,
  formatValue,
  testid
}: {
  label: string
  value: number
  min: number
  max: number
  step?: number
  onChange: (value: number) => void
  formatValue?: (value: number) => string
  testid?: string
}): React.JSX.Element {
  const pct = ((value - min) / (max - min)) * 100
  return (
    <div data-testid={testid ?? 'SettingsSlider'} className="px-3 py-1.5 text-[13px] text-text-secondary">
      <div className="flex items-center justify-between mb-1">
        <span>{label}</span>
        <span className="text-[11px] text-text-muted tabular-nums">
          {formatValue ? formatValue(value) : value}
        </span>
      </div>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        style={{
          background: `linear-gradient(to right, var(--color-accent) ${pct}%, var(--color-text-muted) ${pct}%)`
        }}
        className="w-full h-1 appearance-none rounded-full opacity-30 [&]:hover:opacity-50 transition-opacity cursor-pointer [&::-webkit-slider-thumb]:w-3 [&::-webkit-slider-thumb]:h-3 [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:bg-accent [&::-webkit-slider-thumb]:opacity-100"
      />
    </div>
  )
}

export function SettingsSelect<T extends string>({
  label,
  value,
  options,
  onChange,
  testid
}: {
  label: string
  value: T
  options: { value: T; label: string }[]
  onChange: (value: T) => void
  testid?: string
}): React.JSX.Element {
  return (
    <div data-testid={testid ?? 'SettingsSelect'} className="px-3 py-1.5 text-[13px] text-text-secondary">
      <div className="mb-1">{label}</div>
      <div className="flex items-center gap-1 bg-bg-primary/50 rounded-md p-0.5">
        {options.map((opt) => (
          <button
            key={opt.value}
            onClick={() => onChange(opt.value)}
            className={`flex-1 text-[11px] py-1 rounded transition-colors ${
              value === opt.value
                ? 'bg-accent/20 text-accent'
                : 'text-text-muted hover:text-text-secondary hover:bg-white/5'
            }`}
          >
            {opt.label}
          </button>
        ))}
      </div>
    </div>
  )
}

// Retention window written when auto-delete is OFF (~10 years ≈ "never").
// Upstream marks 0 as schema-invalid and steers toward a large window, so we
// use 3650 rather than 0 to keep settings.json valid and avoid the startup
// validation warning. See ADR-009.
const NEVER_DAYS = 3650
// Default retention the CLI applies when cleanupPeriodDays is unset.
const DEFAULT_DAYS = 30

// Off = no auto-delete. Treat a large window as off, and also 0/negatives
// (a legacy or hand-edited "disable" value) so the toggle reads correctly.
const isOff = (d: number): boolean => d <= 0 || d >= NEVER_DAYS

/**
 * Controls Claude Code's transcript retention (`cleanupPeriodDays` in
 * ~/.claude/settings.json). Self-contained: reads/writes via window.api rather
 * than the UISettings store, since this setting lives in Claude's own file.
 *
 * OFF → writes NEVER_DAYS (keep history indefinitely, schema-valid).
 * ON  → writes a finite day count (min 1) entered in the number field.
 */
export function ChatRetentionSetting(): React.JSX.Element {
  const [days, setDays] = useState<number | null>(null) // null = still loading
  const [lastFinite, setLastFinite] = useState(DEFAULT_DAYS)

  useEffect(() => {
    let cancelled = false
    window.api
      .getCleanupPeriodDays()
      .then((v) => {
        if (cancelled) return
        // undefined = key unset → CLI default of 30 (cleanup on).
        const val = typeof v === 'number' ? v : DEFAULT_DAYS
        setDays(val)
        if (!isOff(val)) setLastFinite(val)
      })
      .catch(() => {
        if (!cancelled) setDays(DEFAULT_DAYS)
      })
    return () => {
      cancelled = true
    }
  }, [])

  if (days === null) {
    return <div className="px-3 py-1.5 text-[13px] text-text-muted">Loading…</div>
  }

  const autoDelete = !isOff(days)

  const persist = (v: number): void => {
    setDays(v)
    if (!isOff(v)) setLastFinite(v)
    window.api.setCleanupPeriodDays(v).catch(() => {})
  }

  return (
    <div data-testid="ChatRetentionSetting">
      <SettingsToggle
        label="Auto-delete old chats"
        checked={autoDelete}
        onChange={(on) => persist(on ? lastFinite : NEVER_DAYS)}
        tooltip="Claude Code deletes chat transcripts under ~/.claude/projects once they pass the retention window, on startup. Turn off to keep history indefinitely. Deletion is by file modified-time, so resuming an old session resets its clock."
      />
      {autoDelete && (
        <div className="px-3 py-1.5 text-[13px] text-text-secondary flex items-center justify-between">
          <span>Delete after</span>
          <span className="flex items-center gap-1.5">
            <input
              type="number"
              min={1}
              value={days}
              onChange={(e) =>
                persist(
                  Math.max(1, Math.min(NEVER_DAYS - 1, Math.round(Number(e.target.value) || 1)))
                )
              }
              className="w-16 bg-bg-primary/50 border border-border/50 rounded px-2 py-1 text-[11px] text-text-secondary outline-none focus:border-accent/50 transition-colors tabular-nums text-right"
            />
            <span className="text-[11px] text-text-muted">days</span>
          </span>
        </div>
      )}
    </div>
  )
}

export function InfoTooltip({ text }: { text: string }): React.JSX.Element {
  const [hovered, setHovered] = useState(false)

  return (
    <span
      data-testid="InfoTooltip"
      className="relative inline-flex items-center"
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
    >
      <svg
        width="12"
        height="12"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        className="text-text-muted/40 hover:text-text-muted transition-colors cursor-default shrink-0"
      >
        <circle cx="12" cy="12" r="10" />
        <path d="M12 16v-4" />
        <path d="M12 8h.01" />
      </svg>
      {hovered && (
        <div className="absolute bottom-full left-1/2 -translate-x-1/2 mb-1.5 pointer-events-none z-50">
          <div className="bg-bg-tertiary border border-border rounded-md px-2.5 py-1.5 shadow-lg text-[10px] text-text-secondary leading-relaxed w-56">
            {text}
          </div>
          <div className="flex justify-center -mt-px">
            <div className="w-2 h-2 bg-bg-tertiary border-r border-b border-border rotate-45 -translate-y-1" />
          </div>
        </div>
      )}
    </span>
  )
}

export function SettingsTextarea({
  label,
  value,
  placeholder,
  rows = 4,
  onChange,
  tooltip,
  description,
  monospace = false,
  testid
}: {
  label: string
  value: string
  placeholder?: string
  rows?: number
  onChange: (value: string) => void
  tooltip?: string
  description?: string
  monospace?: boolean
  testid?: string
}): React.JSX.Element {
  return (
    <div data-testid={testid ?? 'SettingsTextarea'} className="px-3 py-1.5 text-[13px] text-text-secondary">
      <div className="mb-1 flex items-center gap-1">
        {label}
        {tooltip && <InfoTooltip text={tooltip} />}
      </div>
      <textarea
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        rows={rows}
        spellCheck={false}
        className={`w-full bg-bg-primary/50 border border-border/50 rounded px-2 py-1 text-[11px] text-text-secondary outline-none focus:border-accent/50 transition-colors resize-y ${
          monospace ? 'font-mono' : ''
        }`}
      />
      {description && (
        <div className="text-[10px] text-text-muted/60 mt-1 leading-relaxed">{description}</div>
      )}
    </div>
  )
}

export function SandboxListSetting({
  label,
  labelColor,
  items,
  placeholder,
  onUpdate,
  tooltip,
  testid
}: {
  label: string
  labelColor: string
  items: string[]
  placeholder: string
  onUpdate: (items: string[]) => void
  tooltip?: string
  testid?: string
}): React.JSX.Element {
  const [inputVal, setInputVal] = useState('')

  const handleAdd = (): void => {
    const trimmed = inputVal.trim()
    if (trimmed && !items.includes(trimmed)) {
      onUpdate([...items, trimmed])
      setInputVal('')
    }
  }

  return (
    <div data-testid={testid ?? 'SandboxListSetting'} className="px-3 py-1.5 text-[13px] text-text-secondary">
      <div className={`mb-1.5 flex items-center gap-1 ${labelColor}`}>
        {label}
        {tooltip && <InfoTooltip text={tooltip} />}
      </div>
      {items.length > 0 && (
        <div className="flex flex-wrap gap-1 mb-1.5">
          {items.map((item, i) => (
            <span
              key={i}
              className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-bg-primary/50 border border-border/50 text-[11px] text-text-secondary"
            >
              {item}
              <button
                onClick={() => onUpdate(items.filter((_, idx) => idx !== i))}
                className="text-text-muted hover:text-danger transition-colors cursor-default"
              >
                ×
              </button>
            </span>
          ))}
        </div>
      )}
      <div className="flex items-center gap-1.5">
        <input
          type="text"
          value={inputVal}
          onChange={(e) => setInputVal(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') handleAdd()
          }}
          placeholder={placeholder}
          className="flex-1 bg-bg-primary/50 border border-border/50 rounded px-2 py-1 text-[11px] text-text-secondary outline-none focus:border-accent/50 transition-colors"
        />
        <button
          onClick={handleAdd}
          disabled={!inputVal.trim()}
          className="px-2 py-1 text-[11px] font-medium text-accent hover:text-accent-hover bg-accent/10 hover:bg-accent/15 rounded transition-colors cursor-default disabled:opacity-40"
        >
          Add
        </button>
      </div>
    </div>
  )
}
