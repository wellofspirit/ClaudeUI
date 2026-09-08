import { useEffect, useRef, useState } from 'react'
import type { EngineId } from '../../../../shared/types'
import { engineMeta } from '../../../../shared/engine-meta'
import { SelectMenu, type SelectMenuOption } from '../shared/SelectMenu'

// ── The row vocabulary (ADR-065) ─────────────────────────────────────
//
// Every setting in the dialog renders through `SettingRow`: label (13px,
// text-primary), optional description (12px, text-SECONDARY — the contrast fix
// that motivated the redesign; the 10px text-muted/60 helper text it replaces
// measured 1.6:1 on dark), optional config key (11px mono), a 240px
// right-aligned control column, and inline state badges. Wide controls (text,
// lists, chip sets) go under the label at full width via `layout="stacked"`.
//
// Nothing else may invent its own row: the controls below are the whole
// vocabulary, and the legacy exports (`SettingsToggle`, `SettingsSelect`, …) are
// thin wrappers over it, so their call sites and testids did not have to move.

/** The three — and only three — "this applies later" phrasings (ADR-065). */
export type AppliesOn = 'next-session' | 'next-server-start' | 'next-launch'

export const APPLIES_ON_LABEL: Record<AppliesOn, string> = {
  'next-session': 'Next session',
  'next-server-start': 'Next server start',
  'next-launch': 'Next launch'
}

/** Which element the row renders as. `button`/`label` make the whole row a hit. */
type RowElement = 'div' | 'button' | 'label'

/** The 9px padlock of the `locked` badge. */
function LockIcon(): React.JSX.Element {
  return (
    <svg
      width="9"
      height="9"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      className="shrink-0"
    >
      <rect x="4" y="10" width="16" height="10" rx="2" />
      <path d="M8 10V7a4 4 0 018 0v3" />
    </svg>
  )
}

export interface SettingRowProps {
  /** Omit for an explanatory row: the description then occupies the label slot. */
  label?: string
  description?: string
  /** The engine-native config key this row writes (11px mono, under the text). */
  keyText?: string
  /** Outlined chip after the label — the setting exists for this engine only. */
  engine?: EngineId
  appliesOn?: AppliesOn
  /** Accent dot after the label; with `onReset`, a Reset link on row hover. */
  modified?: boolean
  onReset?: () => void
  /** Validation or write failure, in the danger colour under the description. */
  error?: string
  /**
   * Testid for the error node, defaulting to `${testid}.error`.
   *
   * The engine panes namespace their error as `<pane>.error` while the ROW is
   * `<pane>.row` / `<pane>.toggle`, and four components outside this file plus
   * their tests address it that way. An override keeps that contract while the
   * error itself moves onto the primitive.
   */
  errorTestid?: string
  /**
   * Lock badge after the label for a value ClaudeUI forces — "Forced off" /
   * "Forced on" (the Managed keys pattern, ADR-065). The control still renders,
   * so the user can see what is pinned; pair it with `disabled`.
   */
  locked?: string
  layout?: 'inline' | 'stacked'
  /** Dependent-disabled: 50% opacity on label, description and control. */
  dimmed?: boolean
  /** Dependent rows nest exactly one level. */
  indent?: boolean
  /** Rendered before the label block (the radio circle of a `RadioRow`). */
  leading?: React.ReactNode
  as?: RowElement
  onClick?: () => void
  ariaPressed?: boolean
  disabled?: boolean
  /** Overrides the label's colour class (legacy `SandboxListSetting` callers). */
  labelClassName?: string
  className?: string
  testid?: string
  /** ADR-027 discriminator for repeated instances sharing one `testid`. */
  dataId?: string
  children?: React.ReactNode
}

export function SettingRow({
  label,
  description,
  keyText,
  engine,
  appliesOn,
  modified = false,
  onReset,
  error,
  errorTestid,
  locked,
  layout = 'inline',
  dimmed = false,
  indent = false,
  leading,
  as = 'div',
  onClick,
  ariaPressed,
  disabled = false,
  labelClassName,
  className,
  testid,
  dataId,
  children
}: SettingRowProps): React.JSX.Element {
  const tid = testid ?? 'SettingRow'
  const hasLabel = label !== undefined && label !== ''
  const hasControl = children !== undefined && children !== null && children !== false

  // A span, not a <button>: the row itself can BE a button (`SettingsToggle`),
  // and nesting real buttons is invalid HTML. Suppressed on a disabled row —
  // a dependent that cannot be edited must not be resettable either.
  const resetNode =
    modified && onReset && !disabled ? (
      <span
        role="button"
        tabIndex={-1}
        data-testid={`${tid}.reset`}
        onClick={(e) => {
          e.preventDefault()
          e.stopPropagation()
          onReset()
        }}
        className="shrink-0 text-[12px] text-accent opacity-0 group-hover/row:opacity-100 transition-opacity cursor-default"
      >
        Reset
      </span>
    ) : null

  const inner = (
    <>
      {leading}
      <span className={`flex-1 min-w-0 ${dimmed ? 'opacity-50' : ''}`}>
        {hasLabel && (
          <span
            className={`flex items-center gap-2 text-[13px] leading-[18px] ${labelClassName ?? 'text-text-primary'}`}
          >
            <span className="min-w-0">{label}</span>
            {engine && (
              <span
                data-testid={`${tid}.engine`}
                data-id={engine}
                className="shrink-0 border border-border rounded-full px-[7px] text-[10.5px] leading-4 text-text-secondary"
              >
                {engineMeta(engine).label}
              </span>
            )}
            {locked && (
              <span
                data-testid={`${tid}.locked`}
                className="shrink-0 inline-flex items-center gap-1 border border-border rounded-full pl-1.5 pr-[7px] text-[10.5px] leading-4 text-text-secondary"
              >
                <LockIcon />
                {locked}
              </span>
            )}
            {modified && (
              <span
                data-testid={`${tid}.modified`}
                title="Changed from default"
                className="shrink-0 w-1.5 h-1.5 rounded-full bg-accent"
              />
            )}
            {appliesOn && (
              <span
                data-testid={`${tid}.badge`}
                data-id={appliesOn}
                className="shrink-0 bg-warning/15 text-warning text-[10.5px] font-semibold tracking-[0.02em] leading-4 px-[7px] rounded-full"
              >
                {APPLIES_ON_LABEL[appliesOn]}
              </span>
            )}
            {/* A stacked row's control column is the full width under the
                label, so Reset belongs on the label line there. */}
            {layout === 'stacked' && resetNode}
          </span>
        )}
        {description && (
          <span
            className={`block text-[12px] leading-4 text-text-secondary ${hasLabel ? 'mt-px' : ''}`}
          >
            {description}
          </span>
        )}
        {keyText && (
          <span className="block font-mono text-[11px] leading-4 text-text-muted mt-px">
            {keyText}
          </span>
        )}
        {error && (
          <span
            data-testid={errorTestid ?? `${tid}.error`}
            data-id={dataId}
            className="block text-[12px] leading-4 text-danger mt-1"
          >
            {error}
          </span>
        )}
      </span>
      {(hasControl || (layout === 'inline' && resetNode)) && (
        <span
          className={
            layout === 'stacked'
              ? `block w-full ${dimmed ? 'opacity-50' : ''}`
              : `w-[240px] shrink-0 flex items-center justify-end gap-2 ${dimmed ? 'opacity-50' : ''}`
          }
        >
          {layout === 'inline' && resetNode}
          {children}
        </span>
      )}
    </>
  )

  const rootClass = [
    'group/row w-full box-border flex px-3.5 py-2.5 min-h-[44px] text-left',
    layout === 'stacked' ? 'flex-col items-stretch gap-2' : 'items-center gap-4',
    indent ? 'pl-[38px] bg-bg-primary/35' : '',
    className ?? ''
  ]
    .filter(Boolean)
    .join(' ')

  if (as === 'button') {
    return (
      <button
        type="button"
        data-testid={tid}
        data-id={dataId}
        aria-pressed={ariaPressed}
        disabled={disabled}
        onClick={onClick}
        className={`${rootClass} cursor-default`}
      >
        {inner}
      </button>
    )
  }
  if (as === 'label') {
    return (
      <label data-testid={tid} data-id={dataId} className={`${rootClass} cursor-pointer`}>
        {inner}
      </label>
    )
  }
  return (
    <div data-testid={tid} data-id={dataId} className={rootClass}>
      {inner}
    </div>
  )
}

// ── Controls that live in the 240px column ───────────────────────────

/**
 * The switch visual itself, split out of `SettingsToggle` so a READ-ONLY row —
 * a value ClaudeUI forces and the user cannot change — can show the same
 * affordance without pretending to be an interactive button.
 */
export function ToggleSwitch({ checked }: { checked: boolean }): React.JSX.Element {
  // inline-block is load-bearing: inside SettingsToggle the span is a flex item
  // (blockified), but a standalone use sits in inline context where a plain span
  // ignores w-8/h-[18px] — the track collapses and the absolute knob overhangs.
  return (
    <span
      data-testid="ToggleSwitch"
      className={`inline-block shrink-0 w-8 h-[18px] rounded-full relative transition-colors ${checked ? 'bg-accent' : 'bg-text-muted/60'}`}
    >
      <span
        className={`absolute top-0.5 w-3.5 h-3.5 rounded-full bg-white transition-[left] ${checked ? 'left-4' : 'left-0.5'}`}
      />
    </span>
  )
}

export interface SegmentedOption<T extends string> {
  value: T
  label: string
  /** Offered but unselectable — mirrors `SelectMenuOption.disabled`. */
  disabled?: boolean
}

/**
 * Up to five short options. Six or more becomes a `SelectField` — the caller
 * decides, because only it knows the option count.
 */
export function Segmented<T extends string>({
  value,
  options,
  onChange,
  disabled = false,
  testid,
  optionTestid
}: {
  value: T
  options: SegmentedOption<T>[]
  onChange: (value: T) => void
  disabled?: boolean
  testid?: string
  /** Defaults to `${testid}.option`; set it when the root carries another id. */
  optionTestid?: string
}): React.JSX.Element {
  const root = testid ?? 'Segmented'
  return (
    <span
      data-testid={root}
      className="inline-flex items-center gap-0.5 bg-bg-input border border-border rounded-md p-0.5"
    >
      {options.map((opt) => (
        <button
          key={opt.value}
          type="button"
          // Repeated instance: stable testid + `data-id` discriminator (ADR-027).
          data-testid={optionTestid ?? `${root}.option`}
          data-id={opt.value}
          disabled={disabled || opt.disabled}
          onClick={() => onChange(opt.value)}
          className={`px-2.5 py-[3px] text-[12px] leading-4 rounded transition-colors cursor-default disabled:opacity-40 ${
            value === opt.value
              ? 'bg-accent/15 text-accent font-medium'
              : 'text-text-secondary hover:text-text-primary'
          }`}
        >
          {opt.label}
        </button>
      ))}
    </span>
  )
}

/** One of many. Always the same bordered menu, never a bare caret. */
export function SelectField({
  value,
  options,
  onChange,
  placeholder,
  width = 'min-w-[150px]',
  disabled = false,
  testid,
  dataId
}: {
  value: string
  options: SelectMenuOption[]
  onChange: (value: string) => void
  /** Shown when `value` matches no option (how "default"/"unset" reads). */
  placeholder?: string
  /** A literal Tailwind width class — Tailwind v4 cannot see built strings. */
  width?: string
  disabled?: boolean
  testid?: string
  /** ADR-027 discriminator for repeated instances sharing one `testid`. */
  dataId?: string
}): React.JSX.Element {
  return (
    <SelectMenu
      value={value}
      options={options}
      onChange={onChange}
      disabled={disabled}
      testid={testid}
      dataAttrs={dataId === undefined ? undefined : { 'data-id': dataId }}
      fallbackLabel={placeholder}
      triggerClassName={`h-7 ${width} bg-bg-input border border-border rounded-md px-2.5 text-[12px] text-text-primary outline-none focus:border-accent/50 transition-colors`}
    />
  )
}

/**
 * Right-aligned, tabular numerals; the placeholder shows what an EMPTY field
 * means ("default", "unlimited", "no cap"). Commits on blur and on Enter, so a
 * half-typed number never reaches the store; an empty value commits `undefined`.
 */
export function NumberField({
  value,
  onChange,
  placeholder,
  unit,
  min,
  max,
  step,
  disabled = false,
  testid,
  dataId
}: {
  value: number | undefined
  onChange: (value: number | undefined) => void
  placeholder?: string
  unit?: string
  min?: number
  max?: number
  step?: number
  disabled?: boolean
  testid?: string
  /** ADR-027 discriminator for repeated instances sharing one `testid`. */
  dataId?: string
}): React.JSX.Element {
  // null = not being edited, so the prop is the truth. Anything else is the
  // draft the user is part-way through typing.
  const [draft, setDraft] = useState<string | null>(null)
  const shown = draft ?? (value === undefined ? '' : String(value))

  const commit = (): void => {
    if (draft === null) return
    const raw = draft.trim()
    setDraft(null)
    if (raw === '') {
      onChange(undefined)
      return
    }
    const parsed = Number(raw)
    if (!Number.isFinite(parsed)) return // reverts to the prop
    let next = parsed
    if (min !== undefined) next = Math.max(min, next)
    if (max !== undefined) next = Math.min(max, next)
    onChange(next)
  }

  return (
    <>
      <input
        type="text"
        inputMode="numeric"
        data-testid={testid ?? 'NumberField'}
        data-id={dataId}
        value={shown}
        placeholder={placeholder}
        disabled={disabled}
        step={step}
        spellCheck={false}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault()
            commit()
          }
        }}
        className="w-[88px] h-7 shrink-0 bg-bg-input border border-border rounded-md px-2.5 text-[12px] text-text-primary text-right tabular-nums placeholder:text-text-muted outline-none focus:border-accent/50 transition-colors"
      />
      {unit && <span className="text-[12px] text-text-secondary whitespace-nowrap">{unit}</span>}
    </>
  )
}

/** Paths, URLs and commands. Mono by default, full width in a stacked row. */
export function TextField({
  value,
  onChange,
  placeholder,
  mono = true,
  type = 'text',
  className = 'w-full',
  disabled = false,
  testid,
  dataId,
  onBlur,
  onKeyDown,
  inputMode
}: {
  value: string
  onChange: (value: string) => void
  placeholder?: string
  mono?: boolean
  type?: 'text' | 'password'
  /**
   * `numeric` for a dial held as TEXT (the batch-edited auth timings): the
   * phone keyboard is the whole reason the hint exists, and `NumberField`
   * cannot be used there because it commits per field.
   */
  inputMode?: 'text' | 'numeric'
  /** A literal Tailwind width class — Tailwind v4 cannot see built strings. */
  className?: string
  disabled?: boolean
  testid?: string
  /** ADR-027 discriminator for repeated instances sharing one `testid`. */
  dataId?: string
  /** Commit-on-blur / commit-on-Enter callers (the record-key editor). */
  onBlur?: React.FocusEventHandler<HTMLInputElement>
  onKeyDown?: React.KeyboardEventHandler<HTMLInputElement>
}): React.JSX.Element {
  return (
    <input
      type={type}
      inputMode={inputMode}
      data-testid={testid ?? 'TextField'}
      data-id={dataId}
      onBlur={onBlur}
      onKeyDown={onKeyDown}
      value={value}
      placeholder={placeholder}
      disabled={disabled}
      spellCheck={false}
      // No settings field wants autofill: a `type="password"` proxy credential
      // would otherwise trigger the browser's save-password prompt on the web
      // client, and a path/URL field gets the wrong suggestions everywhere.
      autoComplete="off"
      onChange={(e) => onChange(e.target.value)}
      className={`${className} h-7 bg-bg-input border border-border rounded-md px-2.5 text-[12px] text-text-primary placeholder:text-text-muted outline-none focus:border-accent/50 transition-colors ${mono ? 'font-mono' : ''}`}
    />
  )
}

/** Continuous value; the number is always shown next to it, never on hover. */
export function SliderField({
  value,
  min,
  max,
  step,
  onChange,
  display,
  disabled = false,
  testid
}: {
  value: number
  min: number
  max: number
  step?: number
  onChange: (value: number) => void
  /** The formatted value shown beside the track. */
  display: string
  disabled?: boolean
  testid?: string
}): React.JSX.Element {
  const pct = ((value - min) / (max - min)) * 100
  return (
    <>
      <input
        type="range"
        data-testid={testid ?? 'SliderField'}
        min={min}
        max={max}
        step={step}
        value={value}
        disabled={disabled}
        onChange={(e) => onChange(Number(e.target.value))}
        style={{
          // The accent fill is full strength, as on the board. Muting the whole
          // control (the old `opacity-40`) washed the fill out to nothing; the
          // unfilled half carries the muting instead.
          background: `linear-gradient(to right, var(--color-accent) ${pct}%, color-mix(in srgb, var(--color-text-muted) 45%, transparent) ${pct}%)`
        }}
        // flex-1 rather than the board's fixed 200px track: a formatted value
        // like "50,000 chars" is far wider than the board's "115%", and a fixed
        // track would push it out of the 240px column.
        className="flex-1 min-w-0 h-1 appearance-none rounded-full cursor-pointer [&::-webkit-slider-thumb]:w-3 [&::-webkit-slider-thumb]:h-3 [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:bg-accent"
      />
      <span className="min-w-9 shrink-0 text-right text-[12px] text-text-secondary tabular-nums whitespace-nowrap">
        {display}
      </span>
    </>
  )
}

/** Chips with remove, one add field. Domains, paths, globs, packages. */
export function ListEditor({
  items,
  placeholder,
  onUpdate,
  disabled = false,
  testid
}: {
  items: string[]
  placeholder: string
  onUpdate: (items: string[]) => void
  /** A dependent list whose parent is off: chips stay visible, nothing edits. */
  disabled?: boolean
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
    <span className="block">
      {items.length > 0 && (
        <span className="flex flex-wrap gap-1.5 mb-2">
          {items.map((item, i) => (
            <span
              key={i}
              // Repeated instance: stable testid + `data-id` discriminator (ADR-027).
              data-testid={testid ? `${testid}.item` : undefined}
              data-id={item}
              className="inline-flex items-center gap-1 bg-bg-input border border-border rounded-full pl-2.5 pr-1 text-[11px] leading-[18px] text-text-primary"
            >
              {item}
              <button
                type="button"
                data-testid={testid ? `${testid}.remove` : undefined}
                data-id={item}
                disabled={disabled}
                onClick={() => onUpdate(items.filter((_, idx) => idx !== i))}
                className="px-[3px] text-text-muted hover:text-danger transition-colors cursor-default"
              >
                ×
              </button>
            </span>
          ))}
        </span>
      )}
      <span className="flex items-center gap-2">
        <input
          data-testid={testid ? `${testid}.input` : undefined}
          type="text"
          value={inputVal}
          onChange={(e) => setInputVal(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') handleAdd()
          }}
          placeholder={placeholder}
          spellCheck={false}
          disabled={disabled}
          className="flex-1 min-w-0 h-7 bg-bg-input border border-border rounded-md px-2.5 text-[12px] text-text-primary placeholder:text-text-muted outline-none focus:border-accent/50 transition-colors"
        />
        <Button
          testid={testid ? `${testid}.add` : undefined}
          onClick={handleAdd}
          disabled={disabled || !inputVal.trim()}
        >
          Add
        </Button>
      </span>
    </span>
  )
}

/** Toggle a fixed set on or off. Selected is filled, unselected is outlined. */
export function ChipSet({
  value,
  options,
  onToggle,
  testid,
  chipTestid,
  trailing
}: {
  value: string[]
  options: SegmentedOption<string>[]
  onToggle: (value: string) => void
  testid?: string
  /**
   * Defaults to `${testid}.chip`; set it when the CHIPS carry an id the call
   * site already had (the dispatch allowlist's `${pane}.allowedModel`), exactly
   * as `Segmented` takes an `optionTestid`.
   */
  chipTestid?: string
  /**
   * Rendered as the last item INSIDE the wrap flow — a "Show all 13" link that
   * has to sit on the chips' last line rather than on a line of its own.
   */
  trailing?: React.ReactNode
}): React.JSX.Element {
  const root = testid ?? 'ChipSet'
  return (
    <span data-testid={root} className="flex flex-wrap items-center gap-1.5">
      {options.map((opt) => {
        const on = value.includes(opt.value)
        return (
          <button
            key={opt.value}
            type="button"
            data-testid={chipTestid ?? `${root}.chip`}
            data-id={opt.value}
            aria-pressed={on}
            onClick={() => onToggle(opt.value)}
            className={`rounded-full px-2.5 py-px text-[11px] leading-[18px] transition-colors cursor-default ${
              on
                ? 'bg-accent/15 text-accent'
                : 'border border-border text-text-secondary hover:text-text-primary'
            }`}
          >
            {opt.label}
          </button>
        )
      })}
      {trailing}
    </span>
  )
}

/** For 2 to 5 choices that each need a sentence of explanation. */
export function RadioRow({
  label,
  description,
  checked,
  onSelect,
  name,
  value,
  testid,
  dataId
}: {
  label: string
  description?: string
  checked: boolean
  onSelect: () => void
  /** Radio-group name. `value` is what a `getByDisplayValue` query finds. */
  name: string
  value: string
  testid?: string
  dataId?: string
}): React.JSX.Element {
  return (
    <SettingRow
      as="label"
      testid={testid ?? 'RadioRow'}
      dataId={dataId ?? value}
      label={label}
      description={description}
      className={checked ? 'bg-accent/5' : 'hover:bg-bg-hover/40'}
      leading={
        <input
          type="radio"
          name={name}
          value={value}
          checked={checked}
          onChange={onSelect}
          // The inset ring is drawn in the CARD's background, which is what
          // makes the selected state read as a ring rather than a filled dot.
          className="appearance-none w-4 h-4 shrink-0 rounded-full border-[1.5px] border-border-bright bg-transparent checked:border-accent checked:bg-accent checked:shadow-[inset_0_0_0_3.5px_var(--color-bg-secondary)] cursor-pointer"
        />
      }
    />
  )
}

/** Opens an editor for content too big for a row. */
export function ActionRow({
  label,
  description,
  engine,
  action,
  onAction,
  disabled = false,
  testid,
  dataId
}: {
  label: string
  description?: string
  engine?: EngineId
  action: string
  onAction: () => void
  disabled?: boolean
  testid?: string
  dataId?: string
}): React.JSX.Element {
  const tid = testid ?? 'ActionRow'
  return (
    <SettingRow
      testid={tid}
      dataId={dataId}
      label={label}
      description={description}
      engine={engine}
    >
      <button
        type="button"
        data-testid={`${tid}.action`}
        onClick={onAction}
        disabled={disabled}
        className="inline-flex items-center gap-1 text-[12px] text-accent hover:text-accent-hover transition-colors cursor-default disabled:opacity-40"
      >
        {action}
        <svg
          width="12"
          height="12"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <polyline points="9 18 15 12 9 6" />
        </svg>
      </button>
    </SettingRow>
  )
}

/**
 * Filled = the one primary action on a page. Tinted = secondary. Link =
 * tertiary. Red = destructive, always with a confirm.
 */
export function Button({
  children,
  onClick,
  variant = 'tinted',
  disabled = false,
  title,
  testid,
  dataId,
  ariaExpanded
}: {
  children: React.ReactNode
  onClick: () => void
  variant?: 'primary' | 'tinted' | 'link' | 'danger'
  disabled?: boolean
  title?: string
  testid?: string
  dataId?: string
  /** For a button that opens a disclosure below it (the `Overrides…` leaf). */
  ariaExpanded?: boolean
}): React.JSX.Element {
  const look =
    variant === 'primary'
      ? 'bg-accent text-bg-secondary font-semibold hover:bg-accent-hover'
      : variant === 'danger'
        ? 'bg-danger/10 text-danger hover:bg-danger/15'
        : variant === 'link'
          ? 'px-0 text-accent hover:text-accent-hover'
          : 'bg-accent/10 text-accent hover:bg-accent/15'
  return (
    <button
      type="button"
      data-testid={testid}
      data-id={dataId}
      aria-expanded={ariaExpanded}
      onClick={onClick}
      disabled={disabled}
      title={title}
      className={`h-[26px] shrink-0 inline-flex items-center gap-1.5 px-2.5 rounded-md text-[12px] transition-colors cursor-default disabled:opacity-40 ${look}`}
    >
      {children}
    </button>
  )
}

// ── Legacy exports, restyled THROUGH the primitive ───────────────────

export function SettingsToggle({
  label,
  checked,
  onChange,
  tooltip,
  description,
  keyText,
  engine,
  appliesOn,
  modified,
  onReset,
  error,
  errorTestid,
  locked,
  dimmed,
  indent,
  disabled,
  labelClassName,
  testid,
  dataId
}: {
  label: string
  checked: boolean
  onChange: (value: boolean) => void
  /**
   * Legacy name for the row description. It used to hide behind an ⓘ; ADR-065
   * makes it visible at 12px/text-secondary, because a hover-only explanation is
   * unreachable on a phone and the 10px muted variant failed WCAG AA.
   */
  tooltip?: string
  description?: string
  /** The engine-native config key this toggle writes (11px mono, under the text). */
  keyText?: string
  engine?: EngineId
  appliesOn?: AppliesOn
  modified?: boolean
  onReset?: () => void
  error?: string
  errorTestid?: string
  /** "Forced off" / "Forced on" — see `SettingRowProps.locked`. */
  locked?: string
  dimmed?: boolean
  indent?: boolean
  disabled?: boolean
  /** Overrides the label's colour class (a row whose label IS a config key). */
  labelClassName?: string
  testid?: string
  /** ADR-027 discriminator for repeated instances sharing one `testid`. */
  dataId?: string
}): React.JSX.Element {
  return (
    <SettingRow
      as="button"
      testid={testid ?? 'SettingsToggle'}
      dataId={dataId}
      ariaPressed={checked}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      label={label}
      description={description ?? tooltip}
      keyText={keyText}
      engine={engine}
      appliesOn={appliesOn}
      modified={modified}
      onReset={onReset}
      error={error}
      errorTestid={errorTestid}
      locked={locked}
      dimmed={dimmed}
      indent={indent}
      labelClassName={labelClassName}
      className="hover:bg-bg-hover/40 transition-colors"
    >
      <ToggleSwitch checked={checked} />
    </SettingRow>
  )
}

export function SettingsSlider({
  label,
  description,
  value,
  min,
  max,
  step,
  onChange,
  formatValue,
  modified,
  onReset,
  dimmed,
  testid
}: {
  label: string
  description?: string
  value: number
  min: number
  max: number
  step?: number
  onChange: (value: number) => void
  formatValue?: (value: number) => string
  modified?: boolean
  onReset?: () => void
  dimmed?: boolean
  testid?: string
}): React.JSX.Element {
  return (
    <SettingRow
      testid={testid ?? 'SettingsSlider'}
      label={label}
      description={description}
      modified={modified}
      onReset={onReset}
      dimmed={dimmed}
    >
      <SliderField
        value={value}
        min={min}
        max={max}
        step={step}
        onChange={onChange}
        display={formatValue ? formatValue(value) : String(value)}
      />
    </SettingRow>
  )
}

/** Up to five options stay inline; six or more stack under the label. */
const SEGMENTED_INLINE_MAX = 5

export function SettingsSelect<T extends string>({
  label,
  description,
  value,
  options,
  onChange,
  modified,
  onReset,
  dimmed,
  disabled,
  testid
}: {
  label: string
  description?: string
  value: T
  options: { value: T; label: string }[]
  onChange: (value: T) => void
  modified?: boolean
  onReset?: () => void
  dimmed?: boolean
  disabled?: boolean
  testid?: string
}): React.JSX.Element {
  const tid = testid ?? 'SettingsSelect'
  return (
    <SettingRow
      testid={tid}
      label={label}
      description={description}
      layout={options.length > SEGMENTED_INLINE_MAX ? 'stacked' : 'inline'}
      modified={modified}
      onReset={onReset}
      dimmed={dimmed}
    >
      <Segmented
        value={value}
        options={options}
        onChange={onChange}
        disabled={disabled}
        // The control keeps its own id so the row and the segment are distinct
        // nodes, while `${testid}.option` stays the contract call sites assert.
        testid={`${tid}.segmented`}
        optionTestid={`${tid}.option`}
      />
    </SettingRow>
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
 *
 * ONE row, not two (ADR-065): the day count shares the control column with the
 * switch, since a dependent that is a single number does not earn a nested row.
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
    return (
      <SettingRow
        testid="ChatRetentionSetting"
        label="Auto-delete old chats"
        description="Loading…"
      />
    )
  }

  const autoDelete = !isOff(days)

  const persist = (v: number): void => {
    setDays(v)
    if (!isOff(v)) setLastFinite(v)
    window.api.setCleanupPeriodDays(v).catch(() => {})
  }

  return (
    <SettingRow
      testid="ChatRetentionSetting"
      label="Auto-delete old chats"
      description="Claude Code removes transcripts past the window on startup. Deletion goes by file modified-time, so resuming an old session resets its clock."
    >
      {autoDelete && (
        <>
          <span className="text-[12px] text-text-secondary whitespace-nowrap">after</span>
          <NumberField
            testid="ChatRetentionSetting.days"
            value={days}
            min={1}
            max={NEVER_DAYS - 1}
            unit="days"
            onChange={(v) => persist(v === undefined ? DEFAULT_DAYS : Math.round(v))}
          />
        </>
      )}
      <button
        type="button"
        data-testid="ChatRetentionSetting.toggle"
        aria-pressed={autoDelete}
        onClick={() => persist(autoDelete ? NEVER_DAYS : lastFinite)}
        className="cursor-default"
      >
        <ToggleSwitch checked={autoDelete} />
      </button>
    </SettingRow>
  )
}

/**
 * The ⓘ affordance next to a setting's label.
 *
 * ADR-065 retires this for settings ROWS — an explanation belongs in the visible
 * description — but it stays exported for the surfaces outside the redesign that
 * still carry one, and for the list/textarea controls whose callers pass both a
 * description and a long tooltip. No new usage.
 *
 * Hover is the desktop behaviour and is untouched. Touch has no hover, so the
 * icon is also tappable: a tap pins the popover open, a second tap or a tap
 * anywhere outside dismisses it. Dependency-free — one `pointerdown` listener on
 * the document, attached only while a popover is actually pinned.
 *
 * The two states must not be allowed to mix, and on a phone they try to.
 * Android Chrome and iOS Safari SYNTHESIZE a mouse sequence after a tap
 * (`pointerdown → pointerup → mouseenter → click`), and no `mouseleave` ever
 * follows because the finger is gone. Trusting that `mouseenter` would leave
 * `hovered` stuck true forever: the first tap pins AND hovers, the second tap
 * un-pins but the popover stays up on the phantom hover, and the ⓘ appears
 * broken. So hover is accepted only when the last pointer over this element was
 * a real mouse, and a touch/pen press clears it outright.
 */
export function InfoTooltip({ text }: { text: string }): React.JSX.Element {
  const [hovered, setHovered] = useState(false)
  const [pinned, setPinned] = useState(false)
  const rootRef = useRef<HTMLSpanElement>(null)
  /**
   * Pointer type of the last `pointerenter`/`pointerdown` here. Seeded to
   * 'mouse' so a browser that reports no pointer events at all still hovers.
   */
  const lastPointerType = useRef<string>('mouse')

  useEffect(() => {
    if (!pinned) return
    const handler = (e: Event): void => {
      const node = e.target
      if (node instanceof Node && rootRef.current?.contains(node)) return
      setPinned(false)
    }
    // `pointerdown` (not click) so a tap that starts a scroll also dismisses,
    // and capture so a handler that stops propagation can't strand it open.
    document.addEventListener('pointerdown', handler, true)
    return () => document.removeEventListener('pointerdown', handler, true)
  }, [pinned])

  return (
    <span
      data-testid="InfoTooltip"
      ref={rootRef}
      className="relative inline-flex items-center"
      // Fires before the mouse events in both the real-mouse and the
      // synthesized-from-touch sequences, so it is what tells them apart.
      onPointerEnter={(e) => {
        lastPointerType.current = e.pointerType
      }}
      onPointerDown={(e) => {
        lastPointerType.current = e.pointerType
        if (e.pointerType !== 'mouse') setHovered(false)
      }}
      onMouseEnter={() => {
        if (lastPointerType.current === 'mouse') setHovered(true)
      }}
      onMouseLeave={() => setHovered(false)}
    >
      {/* A span, not a <button>: the icon usually sits INSIDE another button
          (SettingsToggle's row), and nesting real buttons is invalid HTML. */}
      <span
        role="button"
        tabIndex={-1}
        data-testid="InfoTooltip.toggle"
        aria-expanded={pinned}
        aria-label="More information"
        // Without stopPropagation the tap would toggle the setting it explains.
        onClick={(e) => {
          e.preventDefault()
          e.stopPropagation()
          setPinned((v) => !v)
        }}
        className="inline-flex items-center justify-center cursor-default"
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
      </span>
      {(hovered || pinned) && (
        <div
          data-testid="InfoTooltip.popover"
          className="absolute bottom-full left-1/2 -translate-x-1/2 mb-1.5 pointer-events-none z-50"
        >
          {/* max-w is a no-op on desktop (the viewport is far wider than 14rem)
              and keeps the popover inside a 360px phone. */}
          <div className="bg-bg-tertiary border border-border rounded-md px-2.5 py-1.5 shadow-lg text-[10px] text-text-secondary leading-relaxed w-56 max-w-[calc(100vw-1.5rem)]">
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
  modified,
  onReset,
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
  modified?: boolean
  onReset?: () => void
  testid?: string
}): React.JSX.Element {
  return (
    <SettingRow
      testid={testid ?? 'SettingsTextarea'}
      layout="stacked"
      label={label}
      description={description ?? tooltip}
      modified={modified}
      onReset={onReset}
    >
      <textarea
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        rows={rows}
        spellCheck={false}
        className={`w-full bg-bg-input border border-border rounded-md px-2.5 py-1.5 text-[12px] text-text-primary placeholder:text-text-muted outline-none focus:border-accent/50 transition-colors resize-y ${
          monospace ? 'font-mono' : ''
        }`}
      />
    </SettingRow>
  )
}

export function SandboxListSetting({
  label,
  labelColor,
  items,
  placeholder,
  onUpdate,
  tooltip,
  description,
  dimmed,
  disabled,
  indent,
  testid
}: {
  label: string
  labelColor: string
  items: string[]
  placeholder: string
  onUpdate: (items: string[]) => void
  tooltip?: string
  /** Always-visible helper line under the label. Use it (rather than
   *  `tooltip`) when the semantics are load-bearing — e.g. what an EMPTY list
   *  means to the backend. */
  description?: string
  /** Dependent-disabled presentation (ADR-065): 50% opacity, one nesting level. */
  dimmed?: boolean
  disabled?: boolean
  indent?: boolean
  testid?: string
}): React.JSX.Element {
  const editor = (
    <ListEditor
      items={items}
      placeholder={placeholder}
      onUpdate={onUpdate}
      disabled={disabled}
      testid={testid}
    />
  )

  // An empty label means the caller already rendered its own label block above
  // the control (the opencode/pi `StackedRow` panes, out of scope this phase) —
  // no row chrome, and the padding those panes were built against is kept.
  if (!label) {
    return (
      <div data-testid={testid ?? 'SandboxListSetting'} className="px-3 py-1.5">
        {editor}
      </div>
    )
  }

  return (
    <SettingRow
      testid={testid ?? 'SandboxListSetting'}
      layout="stacked"
      label={label}
      labelClassName={labelColor}
      description={description}
      dimmed={dimmed}
      indent={indent}
    >
      <span className="block">
        {/* Callers pass BOTH a description and a long tooltip (the trust lists),
            so neither can be folded into the other without losing text. Both
            render, at the description's size and contrast — the ⓘ is gone. */}
        {tooltip && (
          <span className="block text-[12px] leading-4 text-text-secondary mb-2">{tooltip}</span>
        )}
        {editor}
      </span>
    </SettingRow>
  )
}
