/**
 * Segmented toggle for choosing the AI provider (Claude / Codex) at session
 * creation time. Reads/writes `lastSelectedProvider` in the session store.
 *
 * Creation-time only — switching mid-session is not supported.
 */
import { useSessionStore } from '../../stores/session-store'
import type { ProviderId } from '../../../../shared/types'

// Signature colours applied to the selected button only: Claude orange,
// OpenAI/Codex blue. Unselected buttons stay neutral/muted.
const PROVIDERS: { id: ProviderId; label: string; activeClassName: string }[] = [
  { id: 'claude', label: 'Claude', activeClassName: 'bg-[#D97757] text-white' },
  { id: 'codex', label: 'Codex', activeClassName: 'bg-[#0A84FF] text-white' }
]

export function ProviderToggle({ compact = false }: { compact?: boolean }): React.JSX.Element {
  const lastSelectedProvider = useSessionStore((s) => s.lastSelectedProvider)
  const setLastSelectedProvider = useSessionStore((s) => s.setLastSelectedProvider)

  // `compact` is used for the inline sidebar row; the default size suits the
  // roomier welcome-screen placements.
  const buttonSize = compact ? 'px-2 h-[18px] text-[10px]' : 'px-3 h-7 text-[11px]'

  return (
    <div
      className={`flex items-center bg-bg-secondary border border-border overflow-hidden ${
        compact ? 'rounded' : 'rounded-lg'
      }`}
      role="radiogroup"
      aria-label="AI provider"
    >
      {PROVIDERS.map(({ id, label, activeClassName }) => {
        const active = lastSelectedProvider === id
        return (
          <button
            key={id}
            role="radio"
            aria-checked={active}
            onClick={() => setLastSelectedProvider(id)}
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
