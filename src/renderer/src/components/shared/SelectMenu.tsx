/**
 * `SelectMenu` — the themed, DOM-rendered replacement for a native `<select>`.
 *
 * Why this exists: a native option list is painted by the OS with UA colors,
 * so under a dark theme (Monokai in particular) the inherited light-on-dark
 * text is unreadable — the same defect that pushed the judge-model picker onto
 * `ModelPicker` in 8bc26d7. Rather than repeat that one-off per call site, the
 * remaining `<select>`s in the renderer share this control: options are real
 * DOM styled from the same theme tokens as everything else.
 *
 * Semantics are a deliberate drop-in for `<select>`:
 *   - `value` is the controlled string value; a value absent from `options`
 *     shows `fallbackLabel` (or the raw value) instead of silently reading as
 *     the first option, which is what a native select would do.
 *   - `onChange` receives the option's `value` string, so call sites keep the
 *     exact `e.target.value` payload they had.
 *   - an "empty" choice is never implicit: pass it as an explicit option with
 *     `value: ''` exactly as the replaced markup did.
 *
 * `triggerClassName` fully replaces the trigger's look, so each call site keeps
 * the classes its `<select>` had and the layout does not shift.
 *
 * ADR-027 testids: root = `testid` (carrying `data-value` for assertions),
 * trigger = `${testid}.trigger` (carries `disabled`), each option =
 * `${testid}.option` + a `data-id` discriminator.
 */
import { useEffect, useRef, useState } from 'react'

export interface SelectMenuOption {
  value: string
  label: string
  /** Rendered but unselectable — mirrors `<option disabled>`. */
  disabled?: boolean
}

const DEFAULT_TRIGGER_CLASS =
  'w-full bg-bg-primary/50 border border-border/50 rounded px-2 py-1 text-[11px] text-text-secondary outline-none focus:border-accent/50 transition-colors'

export function SelectMenu({
  value,
  options,
  onChange,
  testid,
  disabled = false,
  triggerClassName,
  fallbackLabel,
  title,
  ariaLabel,
  id,
  placement = 'down',
  dataAttrs
}: {
  value: string
  options: SelectMenuOption[]
  onChange: (value: string) => void
  testid?: string
  disabled?: boolean
  /** Replaces the trigger's classes entirely (call sites keep their own look). */
  triggerClassName?: string
  /** Shown when `value` matches no option. Defaults to the raw value. */
  fallbackLabel?: string
  title?: string
  ariaLabel?: string
  /** Mirrors the replaced `<select id>` so an existing `<label htmlFor>` still points at it. */
  id?: string
  placement?: 'up' | 'down'
  /** Extra `data-*` attributes for the root (e.g. `data-harness` on repeated instances). */
  dataAttrs?: Record<string, string>
}): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent): void => {
      const node = ref.current
      if (node && e.target instanceof Node && !node.contains(e.target)) setOpen(false)
    }
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  // A disabled control must never be left with an open menu (the trigger can be
  // disabled while open — e.g. RemoteServerSettings' TLS toggle).
  useEffect(() => {
    if (disabled) setOpen(false)
  }, [disabled])

  const selected = options.find((o) => o.value === value)
  const label = selected?.label ?? fallbackLabel ?? value

  return (
    <div
      ref={ref}
      data-testid={testid}
      data-value={value}
      {...dataAttrs}
      // Titlebar hosts (UsageView) are drag regions; the menu must stay clickable.
      className="relative [-webkit-app-region:no-drag]"
    >
      <button
        type="button"
        id={id}
        data-testid={testid ? `${testid}.trigger` : undefined}
        disabled={disabled}
        title={title}
        aria-label={ariaLabel}
        // A native <select> is role=combobox; keeping that role means assistive
        // tech (and role-based test queries) treat this exactly the same way.
        role="combobox"
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={(e) => {
          e.stopPropagation()
          setOpen((v) => !v)
        }}
        className={`${triggerClassName ?? DEFAULT_TRIGGER_CLASS} flex items-center justify-between gap-1 text-left cursor-pointer disabled:cursor-not-allowed`}
      >
        <span className="truncate">{label}</span>
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
      </button>
      {open && (
        <div
          role="listbox"
          data-testid={testid ? `${testid}.menu` : undefined}
          className={`absolute ${placement === 'down' ? 'top-full mt-1' : 'bottom-full mb-1'} left-0 min-w-full w-max max-w-[22rem] max-h-72 overflow-y-auto bg-bg-tertiary border border-border rounded-lg shadow-lg shadow-black/30 z-30`}
        >
          {options.map((opt) => {
            const active = opt.value === value
            return (
              <button
                key={opt.value}
                type="button"
                role="option"
                aria-selected={active}
                data-testid={testid ? `${testid}.option` : undefined}
                data-id={opt.value}
                disabled={opt.disabled}
                onClick={() => {
                  if (opt.disabled) return
                  onChange(opt.value)
                  setOpen(false)
                }}
                className={`w-full flex items-center px-3 py-1.5 text-[12px] text-left transition-colors ${
                  opt.disabled
                    ? 'text-text-muted opacity-40 cursor-not-allowed'
                    : active
                      ? 'text-text-primary bg-bg-hover cursor-pointer'
                      : 'text-text-secondary hover:bg-bg-hover hover:text-text-primary cursor-pointer'
                }`}
              >
                {opt.label}
              </button>
            )
          })}
        </div>
      )}
    </div>
  )
}
