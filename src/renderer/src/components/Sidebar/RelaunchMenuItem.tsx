import { useConnectionHoldsAdmin } from '../SettingsDialog/connection-admin'
import { useRelaunchOffered } from '../Updates/use-relaunch-offered'
import { updatesStore, useUpdatesStore } from '../Updates/app-update-store'
import { newBuildName } from '../Updates/utils'

const ITEM_CLASS =
  'w-full flex items-center justify-center gap-1.5 px-3 py-1.5 mt-1 text-[12px] text-text-muted hover:text-accent transition-colors cursor-default border-t border-border/30 pt-2'

function RestartGlyph(): React.JSX.Element {
  return (
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
  )
}

/**
 * The settings menu's "Relaunch ClaudeUI" (relaunch arc). Rendered only while
 * the popup is open, so the availability read happens when the menu opens. It
 * runs the Updates panel's restart flow: what a restart interrupts, confirmed
 * inline in the panel when anything would be, else a relaunch at once.
 */
export function RelaunchMenuItem({ onChosen }: { onChosen: () => void }): React.JSX.Element | null {
  const offered = useRelaunchOffered()
  if (!offered) return null
  const build = offered.newBuild
  return (
    <button
      data-testid="SettingsPanel.relaunch"
      data-id={build ? 'new-build' : undefined}
      onClick={() => {
        onChosen()
        void updatesStore.requestRestart('relaunch')
      }}
      className={ITEM_CLASS}
    >
      <RestartGlyph />
      {build ? `Relaunch into ${newBuildName(build)}` : 'Relaunch ClaudeUI'}
    </button>
  )
}

/**
 * "Rebuild & relaunch…" (auto-update design §8, D10): shown while the host
 * knows a source checkout to rebuild from and this client holds `admin`. It
 * opens the Updates panel on the ClaudeUI row with Rebuild picked.
 */
export function RebuildMenuItem({ onChosen }: { onChosen: () => void }): React.JSX.Element | null {
  const { view } = useUpdatesStore()
  const holdsAdmin = useConnectionHoldsAdmin()
  if (!view?.rebuildAvailable || !holdsAdmin) return null
  return (
    <button
      data-testid="SettingsPanel.rebuild"
      onClick={() => {
        onChosen()
        updatesStore.openPanel({ rebuild: true })
      }}
      className={ITEM_CLASS}
    >
      <RestartGlyph />
      Rebuild &amp; relaunch…
    </button>
  )
}
