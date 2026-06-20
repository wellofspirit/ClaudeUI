/**
 * Segmented toggle for choosing the AI engine at session creation time.
 * Reads/writes `lastSelectedEngineId` in the session store.
 *
 * Currently only 'claude' is registered. The component renders null when a
 * single engine is available — opencode re-enables it in Phase 5.
 */
import { useSessionStore } from '../../stores/session-store'
import type { EngineId } from '../../../../shared/types'

// Signature colours applied to the selected button only.
const ENGINES: { id: EngineId; label: string; activeClassName: string }[] = [
  { id: 'claude', label: 'Claude', activeClassName: 'bg-[#D97757] text-white' }
]

export function EngineToggle({
  compact = false
}: {
  compact?: boolean
}): React.JSX.Element | null {
  const lastSelectedEngineId = useSessionStore((s) => s.lastSelectedEngineId)
  const setLastSelectedEngineId = useSessionStore((s) => s.setLastSelectedEngineId)

  // Hide the toggle when only one engine is registered — it's degenerate.
  if (ENGINES.length <= 1) return null

  const buttonSize = compact ? 'px-2 h-[18px] text-[10px]' : 'px-3 h-7 text-[11px]'

  return (
    <div
      className={`flex items-center bg-bg-secondary border border-border overflow-hidden ${
        compact ? 'rounded' : 'rounded-lg'
      }`}
      role="radiogroup"
      aria-label="AI engine"
    >
      {ENGINES.map(({ id, label, activeClassName }) => {
        const active = lastSelectedEngineId === id
        return (
          <button
            key={id}
            role="radio"
            aria-checked={active}
            onClick={() => setLastSelectedEngineId(id)}
            className={`${buttonSize} font-medium transition-colors cursor-pointer ${
              active ? activeClassName : 'text-text-muted hover:text-text-secondary'
            }`}
          >
            {label}
          </button>
        )
      })}
    </div>
  )
}
