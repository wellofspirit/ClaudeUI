import { sanitizeSvg } from '../../utils/sanitize-svg'

/** Render a plugin-supplied SVG icon string safely (strips event handlers and non-SVG elements) */
export function SafeSvgIcon({ svg }: { svg: string }): React.JSX.Element {
  const sanitized = sanitizeSvg(svg)
  if (!sanitized) {
    // Fallback: default plugin icon if SVG is invalid
    return (
      <svg
        width="15"
        height="15"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <path d="M12 2L2 7l10 5 10-5-10-5z" />
        <path d="M2 17l10 5 10-5" />
        <path d="M2 12l10 5 10-5" />
      </svg>
    )
  }
  // Safe: sanitizeSvg has stripped all event handlers and disallowed elements

  return <span dangerouslySetInnerHTML={{ __html: sanitized }} />
}

export function NavItem({
  label,
  icon,
  active,
  onClick,
  onDoubleClick,
  badge
}: {
  label: string
  icon: React.ReactNode
  active?: boolean
  onClick?: () => void
  onDoubleClick?: () => void
  badge?: number
}): React.JSX.Element {
  return (
    <div
      style={{ padding: '0 5px' }}
      onClick={onClick}
      onDoubleClick={onDoubleClick}
      className={`
        flex items-center gap-2.5 h-8 rounded-md text-[13px] cursor-default transition-colors
        ${active ? 'text-text-primary bg-bg-tertiary' : 'text-text-secondary hover:text-text-primary hover:bg-bg-hover'}
      `}
    >
      <span className="shrink-0 text-text-muted">{icon}</span>
      <span className="truncate flex-1">{label}</span>
      {badge != null && badge > 0 && (
        <span className="shrink-0 min-w-[16px] h-4 px-1 flex items-center justify-center rounded-full bg-red-500 text-white text-[10px] font-semibold leading-none">
          {badge > 99 ? '99+' : badge}
        </span>
      )}
    </div>
  )
}
