/**
 * provider-editor-shell.tsx
 *
 * The frame primitives shared by the per-engine provider and model editors: the
 * stacked dialog, the block header that divides a pane, the clickable entity row
 * card those blocks are built from, the closed-set pill row, the inline create
 * form and the disclosure link.
 *
 * They were written for pi's models.json editor (PiCustomProviders.tsx, the
 * design source) and are lifted here unchanged so the opencode editors can wear
 * the same frame instead of re-deriving one. Nothing here talks to an engine:
 * every primitive takes its testid namespace, its copy and its callbacks from the
 * caller, so a pane still addresses its OWN controls (ADR-027 tier 2) after
 * moving onto them — `PiProviderDialog.segment` and `ModelCapabilityEditor.cost`
 * stay as distinguishable as they were when each pane owned its own markup.
 *
 * Z-ORDER, the whole ladder:
 *
 *  · The settings dialog root is z-50.
 *  · A dialog opened from it is `DialogShell` at its default z-[100].
 *  · A dialog opened from THAT one passes `stacked` → z-[105].
 *  · A ConfirmModal launched from either passes `stackedAbove` → z-[110]
 *    (ConfirmModal.tsx), so it clears both.
 *
 * Three levels are all there are. A fourth would mean a dialog opened from a
 * dialog opened from a dialog, which is a design problem rather than a missing
 * z value.
 */

import { useState } from 'react'
import { inputClass } from './OpencodeSchemaForm'

// ── Dialog frame ─────────────────────────────────────────────────────────────

/**
 * Modal shell: title block + close affordance, a scrolling body, and a footer
 * the caller fills (destructive action left, confirming action right).
 *
 * The backdrop closes on click and the panel stops propagation, so a click
 * inside never dismisses. `onClose` is the ONLY way out — every editor built on
 * this saves immediately, so there is nothing to cancel and no unsaved-changes
 * prompt to owe the user.
 */
export function DialogShell({
  testid,
  dataId,
  title,
  subtitle,
  stacked = false,
  onClose,
  footer,
  children
}: {
  testid: string
  dataId: string
  title: string
  subtitle: string
  /** True when opened from ANOTHER dialog — must clear its z-[100]. */
  stacked?: boolean
  onClose: () => void
  footer: React.ReactNode
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <div
      data-testid={testid}
      data-id={dataId}
      className={`fixed inset-0 ${stacked ? 'z-[105]' : 'z-[100]'} flex items-center justify-center bg-black/50 backdrop-blur-sm animate-fade-in`}
      onClick={onClose}
    >
      <div
        className="w-[min(620px,94vw)] max-h-[85vh] flex flex-col bg-bg-primary border border-border rounded-lg shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="px-4 py-3 border-b border-border/50 flex items-center justify-between gap-3">
          <div className="min-w-0">
            <div className="text-[13px] font-medium text-text-primary truncate">{title}</div>
            <div className="text-[11px] text-text-muted/70">{subtitle}</div>
          </div>
          <button
            data-testid={`${testid}.close`}
            aria-label="Close"
            onClick={onClose}
            className="shrink-0 text-text-muted/60 hover:text-text-primary transition-colors text-[16px] leading-none px-1"
          >
            ✕
          </button>
        </div>
        <div className="flex-1 overflow-y-auto py-1 text-[13px] text-text-secondary">
          {children}
        </div>
        <div className="px-4 py-2.5 border-t border-border/50 flex items-center justify-between gap-2">
          {footer}
        </div>
      </div>
    </div>
  )
}

// ── Pane blocks ──────────────────────────────────────────────────────────────

/** Small caps divider with a right-hand action, as in the mockup. */
export function BlockHeader({
  label,
  note,
  actionLabel,
  onAction,
  actionTestid,
  secondary
}: {
  label: string
  note: string
  actionLabel: string
  onAction: () => void
  actionTestid: string
  /**
   * A SECOND right-hand action, for a block with two genuinely different ways
   * in — opencode's "+ Add from catalog" beside "+ Custom provider". Absent (the
   * pi panes) renders the single button exactly as before, with no wrapper.
   */
  secondary?: { label: string; onAction: () => void; testid: string }
}): React.JSX.Element {
  const action = (
    <button
      type="button"
      data-testid={actionTestid}
      onClick={onAction}
      className="shrink-0 text-[10px] text-accent hover:text-accent/80 transition-colors"
    >
      {actionLabel}
    </button>
  )
  return (
    <div className="mt-3 mb-1 mx-3 pb-1 border-b border-border/20 flex items-center justify-between gap-2">
      <div className="text-[10px] font-semibold uppercase tracking-wider text-text-muted/70">
        {label}
        <span className="ml-1.5 normal-case tracking-normal font-normal">— {note}</span>
      </div>
      {secondary ? (
        <div className="shrink-0 flex items-center gap-3">
          {action}
          <button
            type="button"
            data-testid={secondary.testid}
            onClick={secondary.onAction}
            className="shrink-0 text-[10px] text-accent hover:text-accent/80 transition-colors"
          >
            {secondary.label}
          </button>
        </div>
      ) : (
        action
      )}
    </div>
  )
}

/**
 * The clickable card a provider / model / override list is built from: the
 * identifying title, an optional mono tag beside it (a wire protocol, a model
 * family), a badges slot for lock markers, one summary line under it, and a
 * right-hand word naming what the click does ("Edit", "View").
 *
 * The whole card is the hit target — there is no second affordance to aim at —
 * and it keeps `cursor-default` like every other in-app control.
 *
 * ONE EXCEPTION, `actions`. opencode's provider rows keep one-click
 * disable/remove icons beside the card (a deliberate deviation from the mockup:
 * those two are reversible-veto and destructive, and burying them a dialog deep
 * would cost the whole point of separating them). A `<button>` cannot legally
 * contain buttons, so passing `actions` re-frames the card as a `<div>` holding
 * the click target — same classes, same testid, same look.
 */
export function EntityRowCard({
  testid,
  dataId,
  title,
  tag,
  badges,
  subtitle,
  action,
  onClick,
  actions,
  dimmed
}: {
  testid: string
  dataId: string
  title: string
  /** Mono secondary identifier shown next to the title. */
  tag?: string
  /** Rendered after the tag — lock badges and the like. */
  badges?: React.ReactNode
  subtitle: React.ReactNode
  /** Right-hand affordance label. */
  action: string
  onClick: () => void
  /**
   * Row-level controls rendered BESIDE the click target. Their presence swaps
   * the card's root element for a `<div>` — see the note above.
   */
  actions?: React.ReactNode
  /**
   * The entity is switched off: dims the card and marks it `data-disabled`, so
   * "this is here but ignored" is legible structurally and not only by badge.
   * Left undefined (every pi row) the attribute is not emitted at all.
   */
  dimmed?: boolean
}): React.JSX.Element {
  const frame = `mx-3 mb-1.5 w-[calc(100%-1.5rem)] flex items-center gap-3 rounded-md border ${
    dimmed ? 'border-border/20 opacity-55' : 'border-border/30'
  } px-3 py-2 text-left hover:border-accent/40 transition-colors cursor-default`
  const marker = dimmed === undefined ? {} : { 'data-disabled': dimmed ? 'true' : 'false' }
  const body = (
    <>
      <span className="min-w-0">
        <span className="flex items-center gap-2">
          <span className="text-[12px] text-text-primary truncate">{title}</span>
          {tag && <span className="font-mono text-[10px] text-text-muted/60 truncate">{tag}</span>}
          {badges}
        </span>
        <span className="block text-[10px] text-text-muted/70 truncate">{subtitle}</span>
      </span>
      <span className="ml-auto shrink-0 text-[10px] text-accent">{action}</span>
    </>
  )

  if (!actions) {
    return (
      <button
        type="button"
        data-testid={testid}
        data-id={dataId}
        {...marker}
        onClick={onClick}
        className={frame}
      >
        {body}
      </button>
    )
  }

  return (
    <div data-testid={testid} data-id={dataId} {...marker} className={`${frame} group`}>
      <button
        type="button"
        data-testid={`${testid}.open`}
        data-id={dataId}
        onClick={onClick}
        className="min-w-0 flex-1 flex items-center gap-3 text-left cursor-default"
      >
        {body}
      </button>
      {actions}
    </div>
  )
}

// ── Pills ────────────────────────────────────────────────────────────────────

/**
 * The pill look, split out from `SegmentPills` below because the MULTI-select
 * chip rows (opencode's modality lists) cannot use that component and would
 * otherwise carry a copied class string that drifts from it.
 */
export function pillClass(on: boolean): string {
  return `text-[10px] px-2 py-0.5 rounded-full border transition-colors ${
    on
      ? 'bg-accent/20 text-accent border-accent/40'
      : 'bg-bg-hover text-text-muted border-border hover:text-text-secondary'
  }`
}

/** Closed-set pill row. `undefined` current = nothing selected (absent key). */
export function SegmentPills({
  testid,
  idPrefix,
  options,
  current,
  onSelect,
  align = 'end'
}: {
  testid: string
  idPrefix: string
  options: readonly string[]
  current: string | undefined
  onSelect: (value: string) => void
  /** Dialog rows right-align their control column; a create form reads left. */
  align?: 'start' | 'end'
}): React.JSX.Element {
  return (
    <div className={`flex flex-wrap gap-1 ${align === 'end' ? 'justify-end' : 'justify-start'}`}>
      {options.map((option) => {
        const on = current === option
        return (
          <button
            key={option}
            type="button"
            data-testid={testid}
            data-id={`${idPrefix}:${option}`}
            aria-pressed={on}
            onClick={() => onSelect(option)}
            className={pillClass(on)}
          >
            {option}
          </button>
        )
      })}
    </div>
  )
}

// ── Disclosure ───────────────────────────────────────────────────────────────

/**
 * Inline disclosure link. The caller owns the whole label — including the ▸/▾
 * marker — because these double as create affordances ("+ Add tier") when the
 * thing they would reveal does not exist yet.
 */
export function Disclosure({
  testid,
  id,
  label,
  open,
  onToggle
}: {
  testid: string
  id: string
  label: string
  open: boolean
  onToggle: () => void
}): React.JSX.Element {
  return (
    <button
      type="button"
      data-testid={testid}
      data-id={id}
      aria-expanded={open}
      onClick={onToggle}
      className="text-[10px] text-accent hover:text-accent/80 transition-colors"
    >
      {label}
    </button>
  )
}

// ── Create form ──────────────────────────────────────────────────────────────

/**
 * A single-column create form: one text field per `fields` entry, an inline
 * error slot for the writer's refusal, and a submit disabled until every field
 * is non-blank. Values are trimmed on submit and handed back keyed by field.
 *
 * Forms needing more than text (pi's provider form, with its `api` segment row)
 * are written out at their call site rather than bent into this shape.
 */
export function AddForm({
  testidPrefix,
  fields,
  submitLabel,
  error,
  onSubmit,
  onCancel
}: {
  testidPrefix: string
  fields: { key: string; label: string; placeholder: string }[]
  submitLabel: string
  error: string | null
  onSubmit: (values: Record<string, string>) => void
  onCancel: () => void
}): React.JSX.Element {
  const [values, setValues] = useState<Record<string, string>>({})
  const complete = fields.every((field) => (values[field.key] ?? '').trim() !== '')
  return (
    <div
      data-testid={`${testidPrefix}.form`}
      className="mx-3 my-1 border border-border/30 rounded-md p-2 space-y-1.5"
    >
      {fields.map((field) => (
        <label key={field.key} className="block">
          <span className="block text-[10px] text-text-muted mb-0.5">{field.label}</span>
          <input
            type="text"
            data-testid={`${testidPrefix}.field`}
            data-id={field.key}
            placeholder={field.placeholder}
            value={values[field.key] ?? ''}
            spellCheck={false}
            onChange={(e) => setValues((prev) => ({ ...prev, [field.key]: e.target.value }))}
            className={`${inputClass} w-full`}
          />
        </label>
      ))}
      {error && (
        <div
          data-testid={`${testidPrefix}.error`}
          className="text-[10px] text-red-400 leading-relaxed"
        >
          {error}
        </div>
      )}
      <div className="flex items-center gap-2">
        <button
          type="button"
          data-testid={`${testidPrefix}.submit`}
          disabled={!complete}
          onClick={() =>
            onSubmit(Object.fromEntries(fields.map((f) => [f.key, (values[f.key] ?? '').trim()])))
          }
          className="px-2 py-1 text-[11px] rounded bg-accent/20 hover:bg-accent/30 text-accent disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
        >
          {submitLabel}
        </button>
        <button
          type="button"
          data-testid={`${testidPrefix}.cancel`}
          onClick={onCancel}
          className="text-[11px] text-text-muted/70 hover:text-text-primary transition-colors"
        >
          Cancel
        </button>
      </div>
    </div>
  )
}
