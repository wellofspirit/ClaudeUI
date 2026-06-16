/**
 * Segmented toggle for choosing the AI provider (Claude / Codex) at session
 * creation time. Reads/writes `lastSelectedProvider` in the session store.
 *
 * Creation-time only — switching mid-session is not supported.
 */
import { useSessionStore } from '../../stores/session-store'
import type { ProviderId } from '../../../../shared/types'

const PROVIDERS: { id: ProviderId; label: string }[] = [
  { id: 'claude', label: 'Claude' },
  { id: 'codex', label: 'Codex' }
]

export function ProviderToggle(): React.JSX.Element {
  const lastSelectedProvider = useSessionStore((s) => s.lastSelectedProvider)
  const setLastSelectedProvider = useSessionStore((s) => s.setLastSelectedProvider)

  return (
    <div
      className="flex items-center rounded-lg bg-bg-secondary border border-border overflow-hidden"
      role="radiogroup"
      aria-label="AI provider"
    >
      {PROVIDERS.map(({ id, label }) => {
        const active = lastSelectedProvider === id
        return (
          <button
            key={id}
            role="radio"
            aria-checked={active}
            onClick={() => setLastSelectedProvider(id)}
            className={`px-3 h-7 text-[11px] font-medium transition-colors cursor-pointer ${
              active
                ? 'bg-bg-hover text-text-primary'
                : 'text-text-muted hover:text-text-secondary'
            }`}
          >
            {label}
          </button>
        )
      })}
    </div>
  )
}
