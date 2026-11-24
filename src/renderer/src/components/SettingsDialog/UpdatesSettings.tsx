/**
 * Settings › Updates (auto-update design §8): ClaudeUI's own updates. The
 * running build, the channel and the mode, Check now with when it last ran and
 * why it failed, a skipped version with Undo, and, on a host that can rebuild,
 * the source checkout rebuilds list their trees from. Channel, mode and source
 * are host-owned (`HOST_OWNED_SETTINGS`): they save through the admin commands
 * `app-update:set-settings` and `app-update:set-source`, never the generic
 * settings save, which keeps the host's values whatever a client sends. A
 * connection without `admin` sees them read only. Harness update mode stays on
 * the harness page.
 *
 * Reads the Updates panel's store (`Updates/app-update-store.ts`), so the page
 * and the panel show one view.
 */
import { useEffect, useState } from 'react'
import type { AppSettings } from '../../../../shared/app-settings'
import { DEFAULT_SETTINGS } from '../../../../shared/app-settings'
import type {
  AppUpdateChannelSetting,
  AppUpdateMode,
  AppUpdateView
} from '../../../../shared/types/app-update'
import { updatesStore, useUpdatesStore } from '../Updates/app-update-store'
import { buildLine } from '../Updates/utils'
import { useConnectionHoldsAdmin } from './connection-admin'
import { Button, Segmented, SettingRow, TextField } from './settings-controls'

const CHANNEL_OPTIONS: Array<{ value: AppUpdateChannelSetting; label: string }> = [
  { value: 'auto', label: 'Follow this build' },
  { value: 'stable', label: 'Stable' },
  { value: 'pre-release', label: 'Pre-release' }
]

const MODE_OPTIONS: Array<{ value: AppUpdateMode; label: string }> = [
  { value: 'auto', label: 'Download automatically' },
  { value: 'ask', label: 'Ask me' },
  { value: 'off', label: 'Off' }
]

const CHANNEL_WORD: Record<'stable' | 'pre-release', string> = {
  stable: 'stable releases',
  'pre-release': 'pre-releases'
}

function checkedText(view: AppUpdateView): string {
  if (view.settings.mode === 'off') return 'Checks are off.'
  if (view.check.running) return 'Checking…'
  const at = view.check.lastCheckedAt ? new Date(view.check.lastCheckedAt) : null
  if (!at || Number.isNaN(at.getTime())) return 'Not checked yet. ClaudeUI checks every six hours.'
  return `Last checked ${at.toLocaleString()}. ClaudeUI checks every six hours.`
}

function versionDescription(view: AppUpdateView): string | undefined {
  if (view.current.kind === 'dev') return 'A development run checks for no updates.'
  if (!view.supported) return 'This build does not update itself: download releases manually.'
  if (view.current.kind === 'local') return view.current.version ?? undefined
  return undefined
}

/** The admin-only rebuild source row: a path, saved through `app-update:set-source`. */
function SourceRow({
  saved,
  configured,
  busy
}: {
  /** The value the host has (the replicated settings); undefined when unset. */
  saved: string | undefined
  configured: boolean
  busy: boolean
}): React.JSX.Element {
  const [draft, setDraft] = useState(saved ?? '')
  const [error, setError] = useState<string | null>(null)
  // A save from elsewhere (another device, a hand edit) moves the field.
  useEffect(() => setDraft(saved ?? ''), [saved])
  const trimmed = draft.trim()
  const dirty = trimmed !== (saved ?? '')

  const save = async (value: string | null): Promise<void> => {
    setError(null)
    const refusal = await updatesStore.setSource(value)
    if (refusal) setError(refusal)
    else if (value === null) setDraft('')
  }

  return (
    <SettingRow
      testid="UpdatesSettings.source"
      layout="stacked"
      label="Source for rebuilds"
      description={
        configured
          ? 'Rebuild & relaunch lists the worktrees of this ClaudeUI checkout.'
          : 'Empty: a local build rebuilds from the checkout it was built from; a release build cannot rebuild.'
      }
      error={error ?? undefined}
    >
      <div className="flex items-center gap-2 min-w-0">
        <TextField
          testid="UpdatesSettings.sourceInput"
          className="w-full min-w-0 flex-1"
          value={draft}
          placeholder="/path/to/ClaudeUI"
          disabled={busy}
          onChange={(v) => {
            setDraft(v)
            setError(null)
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && dirty) void save(trimmed === '' ? null : trimmed)
          }}
        />
        <Button
          testid="UpdatesSettings.sourceSave"
          disabled={busy || !dirty}
          onClick={() => void save(trimmed === '' ? null : trimmed)}
        >
          Save
        </Button>
        {saved !== undefined && (
          <Button
            testid="UpdatesSettings.sourceClear"
            variant="link"
            disabled={busy}
            onClick={() => void save(null)}
          >
            Clear
          </Button>
        )}
      </div>
    </SettingRow>
  )
}

export function UpdatesSettings({ settings }: { settings: AppSettings }): React.JSX.Element {
  const state = useUpdatesStore()
  const holdsAdmin = useConnectionHoldsAdmin()
  const writable = holdsAdmin && !state.denied
  const view = state.view

  if (!view) {
    return (
      <div data-testid="UpdatesSettings">
        <SettingRow testid="UpdatesSettings.status" description={state.loadError ?? 'Loading…'} />
      </div>
    )
  }

  // The host's values (the view), not this client's copy of settings.json.
  const channel = view.settings.channel
  const mode = view.settings.mode
  const busy = state.busy
  return (
    <div data-testid="UpdatesSettings" className="divide-y divide-border/55">
      <SettingRow
        testid="UpdatesSettings.version"
        label="This build"
        description={versionDescription(view)}
      >
        <span
          data-testid="UpdatesSettings.versionText"
          className="text-[12px] text-text-secondary font-mono tabular-nums whitespace-nowrap"
        >
          {buildLine(view.current)}
        </span>
      </SettingRow>
      <SettingRow
        testid="UpdatesSettings.channel"
        layout="stacked"
        label="Channel"
        description={`Offers ${CHANNEL_WORD[view.settings.effectiveChannel]}.${
          channel === 'auto' ? ' Follows this build.' : ''
        } Switching to stable never downgrades.`}
        modified={channel !== DEFAULT_SETTINGS.appUpdateChannel}
        onReset={
          writable
            ? () => void updatesStore.setSettings({ channel: DEFAULT_SETTINGS.appUpdateChannel })
            : undefined
        }
      >
        <Segmented
          testid="UpdatesSettings.channelControl"
          optionTestid="UpdatesSettings.channelOption"
          ariaLabel="Channel"
          value={channel}
          options={CHANNEL_OPTIONS}
          disabled={!writable || busy === 'settings'}
          onChange={(v) => {
            if (v !== channel) void updatesStore.setSettings({ channel: v })
          }}
        />
      </SettingRow>
      <SettingRow
        testid="UpdatesSettings.mode"
        layout="stacked"
        label="Updates"
        description="Nothing installs or restarts without a click: a downloaded update waits in the Updates panel."
        modified={mode !== DEFAULT_SETTINGS.appUpdateMode}
        onReset={
          writable
            ? () => void updatesStore.setSettings({ mode: DEFAULT_SETTINGS.appUpdateMode })
            : undefined
        }
      >
        <Segmented
          testid="UpdatesSettings.modeControl"
          optionTestid="UpdatesSettings.modeOption"
          ariaLabel="Updates"
          value={mode}
          options={MODE_OPTIONS}
          disabled={!writable || busy === 'settings'}
          onChange={(v) => {
            if (v !== mode) void updatesStore.setSettings({ mode: v })
          }}
        />
      </SettingRow>
      <SettingRow
        testid="UpdatesSettings.check"
        label="Check for updates"
        description={checkedText(view)}
        error={view.check.error ?? state.error ?? undefined}
      >
        <Button
          testid="UpdatesSettings.checkNow"
          disabled={
            !writable || view.settings.mode === 'off' || busy === 'check' || view.check.running
          }
          onClick={() => void updatesStore.check()}
        >
          {busy === 'check' || view.check.running ? 'Checking…' : 'Check now'}
        </Button>
      </SettingRow>
      {view.skippedVersion && (
        <SettingRow
          testid="UpdatesSettings.skipped"
          label="Skipped version"
          description={`${view.skippedVersion} is not offered. A newer release is.`}
        >
          <Button
            testid="UpdatesSettings.unskip"
            disabled={!writable || busy === 'unskip'}
            onClick={() => void updatesStore.unskip()}
          >
            Undo
          </Button>
        </SettingRow>
      )}
      {writable && view.rebuild !== undefined && (
        <SourceRow
          saved={settings.appUpdateSourcePath}
          configured={view.sourceConfigured}
          busy={busy === 'source'}
        />
      )}
      {!writable && (
        <SettingRow
          testid="UpdatesSettings.readOnly"
          description="Read only: updating needs an admin connection."
        />
      )}
    </div>
  )
}
