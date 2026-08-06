/**
 * Icons for the opencode provider row.
 *
 * Hand-rolled inline SVG, matching this codebase's existing convention (see
 * settings-controls.tsx / SettingsDialog/View.tsx) — the app has no icon library
 * and one is not worth adding for five glyphs. Paths follow Lucide's
 * `sliders-horizontal`, `key-round`, `pencil`, `power`, and `trash-2` (ISC).
 *
 * `currentColor` throughout so each button owns its own colour state.
 */

const base = {
  width: 14,
  height: 14,
  viewBox: '0 0 24 24',
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 1.8,
  strokeLinecap: 'round' as const,
  strokeLinejoin: 'round' as const
}

/** Manage which models this provider surfaces in the picker. */
export function SlidersIcon(): React.JSX.Element {
  return (
    <svg {...base} aria-hidden="true">
      <line x1="21" y1="4" x2="14" y2="4" />
      <line x1="10" y1="4" x2="3" y2="4" />
      <line x1="21" y1="12" x2="12" y2="12" />
      <line x1="8" y1="12" x2="3" y2="12" />
      <line x1="21" y1="20" x2="16" y2="20" />
      <line x1="12" y1="20" x2="3" y2="20" />
      <line x1="14" y1="2" x2="14" y2="6" />
      <line x1="8" y1="10" x2="8" y2="14" />
      <line x1="16" y1="18" x2="16" y2="22" />
    </svg>
  )
}

/** Update the stored credential (API key or OAuth). */
export function KeyIcon(): React.JSX.Element {
  return (
    <svg {...base} aria-hidden="true">
      <circle cx="7.5" cy="15.5" r="4.5" />
      <path d="M10.7 12.3 21 2" />
      <path d="m16 7 3 3" />
    </svg>
  )
}

/** Configure the provider declaration (name, base URL, models). */
export function PencilIcon(): React.JSX.Element {
  return (
    <svg {...base} aria-hidden="true">
      <path d="M21.174 6.812a1 1 0 0 0-3.986-3.987L3.842 16.174a2 2 0 0 0-.5.83l-1.321 4.352a.5.5 0 0 0 .623.622l4.353-1.32a2 2 0 0 0 .83-.497z" />
      <path d="m15 5 4 4" />
    </svg>
  )
}

/** Enable / disable — the reversible veto, never destructive. */
export function PowerIcon(): React.JSX.Element {
  return (
    <svg {...base} aria-hidden="true">
      <path d="M12 2v10" />
      <path d="M18.4 6.6a9 9 0 1 1-12.77.04" />
    </svg>
  )
}

/** Remove — destroys the credential and/or declaration ClaudeUI owns. */
export function TrashIcon(): React.JSX.Element {
  return (
    <svg {...base} aria-hidden="true">
      <path d="M3 6h18" />
      <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6" />
      <path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
      <line x1="10" y1="11" x2="10" y2="17" />
      <line x1="14" y1="11" x2="14" y2="17" />
    </svg>
  )
}

/**
 * Shared shell for a row action. Icon-only controls lose their label, so
 * `aria-label` + `title` are REQUIRED (ADR-027 keeps assertions structural, and
 * a title is the only affordance explaining a greyed trash icon).
 */
export function IconButton({
  testId,
  id,
  label,
  onClick,
  disabled = false,
  danger = false,
  active = false,
  children
}: {
  testId: string
  /** Provider id, mirrored to data-id so rows stay addressable. */
  id: string
  /** Becomes both aria-label and title — say what happens, or why it can't. */
  label: string
  onClick?: () => void
  disabled?: boolean
  /** Destructive affordance: hover goes red. */
  danger?: boolean
  /** Currently-on state for the enable/disable toggle. */
  active?: boolean
  children: React.ReactNode
}): React.JSX.Element {
  const tone = disabled
    ? 'text-text-muted/30 cursor-not-allowed'
    : danger
      ? 'text-text-muted/70 hover:text-red-400 hover:bg-bg-hover'
      : active
        ? 'text-accent hover:bg-bg-hover'
        : 'text-text-muted/70 hover:text-text-primary hover:bg-bg-hover'

  return (
    <button
      data-testid={testId}
      data-id={id}
      aria-label={label}
      title={label}
      onClick={disabled ? undefined : onClick}
      disabled={disabled}
      className={`p-1 rounded transition-colors cursor-default ${tone}`}
    >
      {children}
    </button>
  )
}
