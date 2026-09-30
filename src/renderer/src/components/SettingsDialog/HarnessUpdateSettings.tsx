/**
 * Settings › Harnesses › Installed › Updates (ADR-082 §6; mockup `04c3853c`,
 * tab A): Install updates (Automatically | Ask me) and Check now.
 *
 * The mode lives in main's `harnesses.json` (`updates`), written only through
 * `harness:set-update-mode`; both rows need `admin` (§7) and read the shared
 * harness store, so a connection without it sees them read only.
 */
import type { HarnessUpdateMode } from '../../../../shared/harness-types'
import { useConnectionHoldsAdmin } from './connection-admin'
import { harnessStore, useHarnessStore } from './harness-store'
import { Button, Segmented, SettingRow } from './settings-controls'

const MODE_OPTIONS: Array<{ value: HarnessUpdateMode; label: string }> = [
  { value: 'auto', label: 'Automatically' },
  { value: 'ask', label: 'Ask me' }
]

function checkedText(lastCheckedAt: string | undefined): string {
  const sources = 'GitHub releases and the npm registry'
  const when = lastCheckedAt ? new Date(lastCheckedAt) : null
  if (!when || Number.isNaN(when.getTime())) return `Not checked yet · ${sources}`
  return `Last checked ${when.toLocaleString()} · ${sources}`
}

export function HarnessUpdateSettings(): React.JSX.Element {
  const state = useHarnessStore()
  const holdsAdmin = useConnectionHoldsAdmin()
  const writable = holdsAdmin && !state.denied
  const updates = state.snapshot?.updates

  if (!updates) {
    return (
      <div data-testid="HarnessUpdates">
        <SettingRow testid="HarnessUpdates.status" description="Loading…" />
      </div>
    )
  }
  return (
    <div data-testid="HarnessUpdates" className="divide-y divide-border/55">
      <SettingRow
        testid="HarnessUpdates.mode"
        label="Install updates"
        description={
          updates.mode === 'auto'
            ? 'ClaudeUI installs new versions of the harnesses it manages as it finds them. Running sessions keep their version; new and respawned ones get the update.'
            : '"Ask me" puts a button in the sidebar footer. Either way, running sessions keep their version; new and respawned ones get the update.'
        }
        error={state.updateError ?? undefined}
      >
        <Segmented
          testid="HarnessUpdates.modeControl"
          optionTestid="HarnessUpdates.modeOption"
          ariaLabel="Install updates"
          value={updates.mode}
          disabled={!writable}
          options={MODE_OPTIONS}
          onChange={(mode) => {
            if (writable && mode !== updates.mode) void harnessStore.setUpdateMode(mode)
          }}
        />
      </SettingRow>
      <SettingRow
        testid="HarnessUpdates.check"
        label="Check for new versions"
        description={checkedText(updates.status.lastCheckedAt)}
      >
        <Button
          testid="HarnessUpdates.checkNow"
          disabled={!writable || state.checkPending}
          onClick={() => void harnessStore.checkUpdates()}
        >
          {state.checkPending ? 'Checking…' : 'Check now'}
        </Button>
      </SettingRow>
    </div>
  )
}
