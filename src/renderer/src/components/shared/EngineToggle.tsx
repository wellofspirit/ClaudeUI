/**
 * Segmented toggle for choosing the AI engine at session creation time.
 * Reads/writes `lastSelectedEngineId` in the session store, and — when the
 * active session has not yet started (no backend sessionId) — switches that
 * session's engine and resets its model to the engine default.
 */
import { useSessionStore, defaultModelForEngine } from '../../stores/session-store'
import type { EngineId } from '../../../../shared/types'

// Signature colours applied to the selected button only.
const ENGINES: { id: EngineId; label: string; activeClassName: string }[] = [
  { id: 'claude', label: 'Claude', activeClassName: 'bg-[#D97757] text-white' },
  { id: 'opencode', label: 'opencode', activeClassName: 'bg-[#3B82F6] text-white' }
]

export function EngineToggle({
  compact = false
}: {
  compact?: boolean
}): React.JSX.Element | null {
  const lastSelectedEngineId = useSessionStore((s) => s.lastSelectedEngineId)
  const setLastSelectedEngineId = useSessionStore((s) => s.setLastSelectedEngineId)
  const setSelectedModel = useSessionStore((s) => s.setSelectedModel)
  const activeSessionId = useSessionStore((s) => s.activeSessionId)

  // Hide the toggle when only one engine is registered — it's degenerate.
  if (ENGINES.length <= 1) return null

  const buttonSize = compact ? 'px-2 h-[18px] text-[10px]' : 'px-3 h-7 text-[11px]'

  const handleSelect = (id: EngineId): void => {
    setLastSelectedEngineId(id)
    // If the active session hasn't started yet, switch its engine + reset its
    // model to that engine's default (so an opencode session never gets
    // model='default'). A started session (has a backend sessionId) keeps its
    // engine — the choice applies to the next new session via lastSelectedEngineId.
    if (!activeSessionId) return
    const session = useSessionStore.getState().sessions[activeSessionId]
    if (!session || session.status.sessionId || session.selectedEngineId === id) return
    setSelectedModel(defaultModelForEngine(id), id)
  }

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
            onClick={() => handleSelect(id)}
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
