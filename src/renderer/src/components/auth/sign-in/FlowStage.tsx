/**
 * `flow` — the live sign-in, as whichever panel this host can actually run.
 *
 * The panel is DERIVED by the state machine and handed here (ADR-057: a web
 * client has no host browser to wait on), so this file picks nothing; it renders
 * the one it was given and reports the clicks back.
 */

import type { SignInProviderId, VendorOAuthState } from '../../../stores/session-store'
import { Button } from '../../SettingsDialog/settings-controls'
import { OAuthOutcomeNotice, OAuthPasteBackFlow, classifyOAuthError } from '../OAuthPasteBackFlow'
import { DeviceCodeFlow } from '../DeviceCodeFlow'
import { DIALOG } from './shared'

/** Which of the three sign-in panels is on screen. */
export type FlowPanel = 'device' | 'paste' | 'browser'

export interface FlowStageProps {
  providerId: SignInProviderId
  panel: FlowPanel
  /** The live device-code flow, when that is what is running. */
  device?: VendorOAuthState
  /** The authorize URL this provider's flow parked, whichever host we are on. */
  url?: string
  error: string | null
  busy: boolean
  /** A paste is in flight — the paste panel's own lock. */
  submitting: boolean
  onSubmit: (pasted: string) => void
  onCancel: () => void
  onPasteInstead: () => void
  onRestart: () => void
}

export function FlowStage({
  providerId,
  panel,
  device,
  url,
  error,
  busy,
  submitting,
  onSubmit,
  onCancel,
  onPasteInstead,
  onRestart
}: FlowStageProps): React.JSX.Element {
  const flowPanel =
    panel === 'device' ? (
      <DeviceCodeFlow
        id={providerId}
        verificationUrl={device?.verificationUrl}
        userCode={device?.userCode}
        expiresAt={device?.expiresAt}
        // Busy only until the host answers with a code: the wait AFTER that is the
        // flow's normal state, and locking Copy for fifteen minutes of it would
        // make the panel useless.
        busy={busy && !device}
        onCancel={onCancel}
        onPasteInstead={onPasteInstead}
      />
    ) : panel === 'paste' ? (
      <OAuthPasteBackFlow
        variant={providerId === 'anthropic' ? 'code' : 'url'}
        id={providerId}
        url={url}
        error={error}
        busy={submitting || busy}
        onSubmit={onSubmit}
        onCancel={onCancel}
        // A flow that died carries no url any more, so step 1 has nothing to open
        // and the panel can only say so. Restarting the SAME mode is what the
        // sentence was asking for; Cancel → chooser → Re-authorize was the only
        // way to do it.
        onRestart={onRestart}
      />
    ) : (
      // Rule 3: a spinner labelled "Waiting for the browser…" does not also need
      // "Finish the sign-in in the browser window we opened. It completes on its
      // own." The spinner says it is waiting; the label says what for.
      <div data-testid={`${DIALOG}.waiting`} className="space-y-3">
        <div className="flex items-center gap-3">
          <span className="w-3 h-3 shrink-0 rounded-full border-2 border-accent border-t-transparent animate-spin-slow" />
          <span className="flex-1 text-[13px] text-text-primary">Waiting for the browser…</span>
        </div>
        <div className="flex items-center gap-3">
          {url && (
            <Button
              variant="link"
              testid={`${DIALOG}.manualLink`}
              onClick={() => window.open(url, '_blank', 'noopener,noreferrer')}
            >
              Open the link ↗
            </Button>
          )}
          <Button variant="link" testid={`${DIALOG}.cancel`} onClick={onCancel}>
            Cancel
          </Button>
        </div>
      </div>
    )

  /**
   * The paste panel is on screen, and therefore OWNS the flow error.
   *
   * It has always had the `error` prop and rendered it itself; this surface
   * rendered `flowError` its own way beside it instead, so one component said
   * the same thing in two places depending on who mounted it. One owner: the
   * panel when it is up, this dialog for the two panels that have no such prop.
   */
  const pasteOwnsError = panel === 'paste'

  return (
    <div className="space-y-3">
      {flowPanel}
      {error && !pasteOwnsError && (
        <OAuthOutcomeNotice kind={classifyOAuthError(error)} message={error} id={providerId} />
      )}
    </div>
  )
}
