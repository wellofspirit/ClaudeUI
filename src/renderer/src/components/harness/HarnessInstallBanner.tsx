/**
 * The composer's banner for a session on a harness that does not run
 * (ADR-082 §8; mockup `b51cb3df` C): a new session, a reopened one, or one the
 * upgrade sheet skipped. It sits above the input; while it shows, Send is off
 * and the model picker says why (`InputBox`).
 *
 * States (`harnessBannerState`):
 *   offer            Install (the selection's version) and Settings…
 *   installing       progress from the shared install list, and Cancel
 *   failed           the reason, and Retry
 *   system-unusable  the resolver's reason, and "Use ClaudeUI's copy"
 *   ask-admin        a connection without `admin`: who can install it, no button
 *   unavailable-here the reason, no button
 *
 * When the install lands the resolver says `available`, the banner goes, and
 * the composer's models reload (`useReloadModelsOnHarnessReady`).
 */
import type { HarnessId } from '../../../../shared/harness-types'
import { useConnectionHoldsAdmin } from '../SettingsDialog/connection-admin'
import { harnessStore, useHarnessStore } from '../SettingsDialog/harness-store'
import {
  HARNESS_LABEL,
  harnessBannerState,
  progressPercent,
  progressText,
  type HarnessBannerState
} from '../SettingsDialog/harness-view'
import { ProgressBar } from '../SettingsDialog/HarnessesInstalled'
import { isWebClient } from '../SettingsDialog/remote-settings-transport'
import { Button } from '../SettingsDialog/settings-controls'
import { EngineLogo } from '../shared/EngineLogo'

export function openHarnessSettings(): void {
  window.dispatchEvent(new CustomEvent('open-settings', { detail: { page: 'harnesses' } }))
}

const TONE: Record<HarnessBannerState['kind'], string> = {
  offer: 'border-warning/30 bg-warning/10',
  'system-unusable': 'border-warning/30 bg-warning/10',
  installing: 'border-border bg-bg-secondary',
  failed: 'border-danger/30 bg-danger/10',
  'ask-admin': 'border-border bg-bg-secondary',
  'unavailable-here': 'border-border bg-bg-secondary'
}

function offerNote(id: HarnessId, version: string | null, tested: string): string {
  if (version === null) return `ClaudeUI installs the newest ${HARNESS_LABEL[id]} release.`
  return version === tested
    ? `ClaudeUI's tested copy is ${version}.`
    : `The version selected in Settings is ${version}.`
}

export function HarnessInstallBanner({
  engineId
}: {
  engineId: HarnessId
}): React.JSX.Element | null {
  const state = useHarnessStore()
  const holdsAdmin = useConnectionHoldsAdmin()
  const writable = holdsAdmin && !state.denied
  const banner = harnessBannerState(state.snapshot, engineId, state.installs, writable)
  if (!banner) return null
  const label = HARNESS_LABEL[engineId]
  const tested = state.snapshot?.harnesses[engineId].manifest.tested ?? ''

  let body: React.ReactNode
  let actions: React.ReactNode = null
  switch (banner.kind) {
    case 'offer':
      body = (
        <>
          <span className="text-text-primary">{label} isn&apos;t installed.</span>{' '}
          <span className="text-text-muted">{offerNote(engineId, banner.version, tested)}</span>
        </>
      )
      actions = (
        <>
          <Button
            testid="HarnessInstallBanner.install"
            dataId={banner.request}
            variant="primary"
            onClick={() => void harnessStore.install(engineId, banner.request)}
          >
            Install
          </Button>
          <Button
            testid="HarnessInstallBanner.settings"
            variant="link"
            onClick={openHarnessSettings}
          >
            Settings…
          </Button>
        </>
      )
      break
    case 'installing': {
      const p = banner.progress
      body = (
        <>
          <span className="text-text-primary">
            Installing {label} {p.version}
          </span>{' '}
          <span
            data-testid="HarnessInstallBanner.progress"
            className="text-text-muted tabular-nums"
          >
            · {progressText(p)}
          </span>
          <ProgressBar percent={progressPercent(p)} className="mt-1.5" />
        </>
      )
      actions = (
        <Button
          testid="HarnessInstallBanner.cancel"
          dataId={p.version}
          variant="tinted"
          disabled={!writable}
          onClick={() => void harnessStore.cancel(engineId, p.version)}
        >
          Cancel
        </Button>
      )
      break
    }
    case 'failed':
      body = (
        <>
          <span className="text-danger">
            {label} {banner.progress.version} could not be installed:
          </span>{' '}
          <span data-testid="HarnessInstallBanner.reason" className="text-text-muted">
            {banner.progress.reason ?? 'unknown error'}
          </span>
        </>
      )
      actions = (
        <Button
          testid="HarnessInstallBanner.retry"
          dataId={banner.request}
          variant="tinted"
          onClick={() => void harnessStore.install(engineId, banner.request)}
        >
          Retry
        </Button>
      )
      break
    case 'system-unusable':
      body = (
        <span data-testid="HarnessInstallBanner.reason" className="text-text-primary">
          {banner.reason}
        </span>
      )
      actions = (
        <>
          <Button
            testid="HarnessInstallBanner.useManaged"
            variant="primary"
            onClick={() => void harnessStore.useManagedCopy(engineId)}
          >
            Use ClaudeUI&apos;s copy
          </Button>
          <Button
            testid="HarnessInstallBanner.settings"
            variant="link"
            onClick={openHarnessSettings}
          >
            Settings…
          </Button>
        </>
      )
      break
    case 'ask-admin':
      body = (
        <span className="text-text-muted">
          {label} isn&apos;t installed{isWebClient() ? ' on this server' : ''}. Ask an admin to
          install it from Settings › Harnesses › Installed.
        </span>
      )
      break
    case 'unavailable-here':
      body = (
        <span data-testid="HarnessInstallBanner.reason" className="text-text-muted">
          {banner.reason}
        </span>
      )
      break
  }

  return (
    <div
      data-testid="HarnessInstallBanner"
      data-state={banner.kind}
      data-id={engineId}
      className={`mb-2 flex flex-wrap items-center gap-x-3 gap-y-1.5 px-3 py-2 rounded-lg border text-[12.5px] leading-5 ${TONE[banner.kind]}`}
    >
      <EngineLogo engineId={engineId} size={14} className="shrink-0" />
      <div data-testid="HarnessInstallBanner.text" className="flex-1 min-w-0">
        {body}
      </div>
      {actions && <div className="flex items-center gap-2 shrink-0">{actions}</div>}
    </div>
  )
}
