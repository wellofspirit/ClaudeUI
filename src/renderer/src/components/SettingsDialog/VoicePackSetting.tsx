/**
 * Settings › Voice input › the on-device speech model and the live preview
 * (ADR-101 §6, §7).
 *
 * `VoicePackSetting` is the HOST's: the model is installed once per host and
 * serves every client of it (a phone sees the desktop's install, and the other
 * way round), so its state comes from the shared pack store — `voice:pack-status`
 * and the replicated `voice:pack-changed` — not from anything local. Install and
 * Remove need `admin` on a remote client; a refusal reads as one sentence under
 * the row. Remove asks twice, the way the other destructive buttons in Settings
 * do (the label turns into "Confirm remove?").
 *
 * `VoicePreviewSetting` is the CLIENT's: per device in `localStorage`
 * (`lib/voice/preview-preference.ts`), never in the synced settings, hence the
 * "this device" badge.
 */

import { useEffect, useState } from 'react'
import { SettingRow, Button, ToggleSwitch } from './settings-controls'
import { useCancelGuard } from '../../lib/voice/use-cancel-guard'
import {
  VOICE_PACK_ADMIN_MESSAGE,
  cancelVoicePackInstall,
  installVoicePack,
  refreshVoicePackStatus,
  removeVoicePack,
  useVoicePackStore
} from '../../lib/voice/voice-pack-store'
import { packProgressPercent } from '../../lib/voice/voice-pack-notice'
import {
  onLivePreviewChange,
  readLivePreview,
  writeLivePreview
} from '../../lib/voice/preview-preference'

export const VOICE_PREVIEW_HELP_TEXT =
  'Shows words as you speak for opencode and pi sessions; the final text arrives when you let go'

/** "~700 MB" from the download's size. */
function approxSize(bytes: number): string {
  return `~${Math.round(bytes / 1_000_000)} MB`
}

export function VoicePackSetting(): React.JSX.Element {
  const status = useVoicePackStore((s) => s.status)
  const pending = useVoicePackStore((s) => s.pending)
  const commandError = useVoicePackStore((s) => s.error)
  const denied = useVoicePackStore((s) => s.denied)
  const readFailed = useVoicePackStore((s) => s.readFailed)
  const [confirmRemove, setConfirmRemove] = useState(false)

  // The event ring replays on reconnect: what is true now is the read.
  useEffect(() => {
    void refreshVoicePackStatus()
  }, [])

  const state = status?.state
  // A press this client sent counts as running before the host's first word, and
  // a `ready` outranks it (the host has the pack).
  const installing = state === 'installing' || (pending === 'install' && state !== 'ready')
  const cancelArmed = useCancelGuard(installing)
  // Asking twice is only meaningful while there is something to remove.
  useEffect(() => {
    if (state !== 'ready') setConfirmRemove(false)
  }, [state])

  const percent = packProgressPercent(status)
  let stateText: string
  if (!status) stateText = readFailed ? 'Status unavailable' : 'Checking…'
  else if (installing) stateText = percent === null ? 'Downloading…' : `Downloading ${percent}%`
  else if (state === 'unsupported') stateText = 'Not available on this host'
  else if (state === 'ready') stateText = 'Installed'
  else if (state === 'failed')
    stateText = `Failed: ${status.error || 'the download did not finish'}`
  else stateText = `Not installed (${approxSize(status.approxBytes)})`

  const handleRemove = (): void => {
    if (!confirmRemove) {
      setConfirmRemove(true)
      return
    }
    setConfirmRemove(false)
    void removeVoicePack()
  }

  let action: React.ReactNode = null
  if (!status) {
    // The first read failed (an older host, a dropped link): say so, and let it be asked again.
    if (readFailed) {
      action = (
        <Button
          key="retry-read"
          testid="VoicePackSetting.retry"
          onClick={() => void refreshVoicePackStatus()}
        >
          Retry
        </Button>
      )
    }
  } else if (denied) {
    // Every write needs `admin` and one was refused: the buttons would only fail
    // the same way, so the row is read-only (see `description`).
    action = null
  } else if (installing) {
    action = (
      <Button
        // Keyed apart from Install, so focus and a held Enter do not carry over.
        key="cancel"
        testid="VoicePackSetting.cancel"
        disabled={pending === 'cancel'}
        onClick={() => {
          if (cancelArmed()) void cancelVoicePackInstall()
        }}
      >
        Cancel
      </Button>
    )
  } else if (state === 'missing' || state === 'failed') {
    action = (
      <Button
        key="install"
        variant="primary"
        testid="VoicePackSetting.install"
        disabled={pending !== null}
        onClick={() => void installVoicePack()}
      >
        {state === 'failed' ? 'Retry' : 'Install'}
      </Button>
    )
  } else if (state === 'ready') {
    action = (
      <Button
        key="remove"
        variant="danger"
        testid="VoicePackSetting.remove"
        disabled={pending === 'remove'}
        onClick={handleRemove}
      >
        {confirmRemove ? 'Confirm remove?' : 'Remove'}
      </Button>
    )
  }

  return (
    <SettingRow
      testid="VoicePackSetting"
      label="On-device speech model"
      description={
        <>
          {`${status?.label ?? 'Parakeet'}. Lets opencode and pi sessions transcribe on this host — the audio never leaves it. Claude Code sessions use Claude's own transcription.`}
          {denied && (
            <span data-testid="VoicePackSetting.denied" className="block mt-1 text-text-secondary">
              {VOICE_PACK_ADMIN_MESSAGE}
            </span>
          )}
        </>
      }
      error={commandError ?? undefined}
    >
      <div className="flex items-center justify-end gap-2.5 min-w-0">
        <span
          data-testid="VoicePackSetting.state"
          data-state={installing ? 'installing' : (state ?? 'unknown')}
          className={`min-w-0 text-[12px] leading-4 text-right break-words ${
            state === 'failed' && !installing ? 'text-warning' : 'text-text-secondary'
          }`}
        >
          {stateText}
        </span>
        {action}
      </div>
    </SettingRow>
  )
}

export function VoicePreviewSetting({ enabled }: { enabled: boolean }): React.JSX.Element {
  const [on, setOn] = useState(() => readLivePreview())
  useEffect(() => onLivePreviewChange(setOn), [])
  return (
    <div data-testid="VoicePreviewSetting">
      <SettingRow
        as="button"
        testid="VoicePreviewSetting.toggle"
        ariaPressed={on}
        disabled={!enabled}
        onClick={() => writeLivePreview(!on)}
        label="Live preview while speaking"
        labelBadge={
          <span className="shrink-0 text-[10px] leading-4 px-1.5 rounded bg-bg-tertiary text-text-secondary">
            this device
          </span>
        }
        description={VOICE_PREVIEW_HELP_TEXT}
        dimmed={!enabled}
        className="hover:bg-bg-hover/40 transition-colors"
      >
        <ToggleSwitch checked={on} />
      </SettingRow>
    </div>
  )
}
