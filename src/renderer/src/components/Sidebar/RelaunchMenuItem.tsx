import { useRelaunchOffered } from '../RelaunchConfirm'
import { requestRelaunch } from '../../lib/relaunch-store'

/**
 * The settings menu's "Relaunch ClaudeUI" (relaunch arc, S1). Rendered only while
 * the popup is open, so the availability read happens when the menu opens.
 */
export function RelaunchMenuItem({ onChosen }: { onChosen: () => void }): React.JSX.Element | null {
  const offered = useRelaunchOffered()
  if (!offered) return null
  return (
    <button
      data-testid="SettingsPanel.relaunch"
      onClick={() => {
        onChosen()
        void requestRelaunch()
      }}
      className="w-full flex items-center justify-center gap-1.5 px-3 py-1.5 mt-1 text-[12px] text-text-muted hover:text-accent transition-colors cursor-default border-t border-border/30 pt-2"
    >
      <svg
        width="12"
        height="12"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <path d="M21 12a9 9 0 11-2.64-6.36" />
        <path d="M21 3v6h-6" />
      </svg>
      Relaunch ClaudeUI
    </button>
  )
}
