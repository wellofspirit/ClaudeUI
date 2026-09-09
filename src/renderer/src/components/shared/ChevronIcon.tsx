/**
 * The one chevron. Every disclosure trigger in the app — `SelectMenu` (and so
 * `SelectField`, the settings row select) and `ModelPicker`'s field variant —
 * paints the SAME glyph and the SAME flip, so a settings row reads as one
 * control vocabulary rather than a handful of hand-rolled carets (ADR-065,
 * "one row vocabulary").
 *
 * Closed points DOWN; open rotates 180° to point UP. The rotation is a CSS
 * transform on a single path, not a second icon, so the two states cannot drift
 * apart and the transition is free.
 *
 * `testid` is optional because most call sites are decoration inside an already
 * assertable trigger; pass one only where the open/closed state itself is the
 * thing a test needs to read (`data-open`).
 */

export function ChevronIcon({
  open = false,
  size = 12,
  className = '',
  testid
}: {
  open?: boolean
  /** Both the width and the height, in px. The 24×24 viewBox scales to it. */
  size?: number
  /** Extra classes (colour, usually `text-text-muted`). */
  className?: string
  testid?: string
}): React.JSX.Element {
  return (
    <svg
      data-testid={testid}
      data-open={testid ? (open ? 'true' : 'false') : undefined}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      // Literal Tailwind classes only — Tailwind v4 cannot see built strings.
      className={`shrink-0 transition-transform duration-150 ${open ? 'rotate-180' : ''} ${className}`}
    >
      <path d="m6 9 6 6 6-6" />
    </svg>
  )
}
