/**
 * VendorOAuthFlow — signing a vendor in from inside a provider sheet
 * (ADR-057 remote paste-back + the desktop flow, settings-v2 phase 6c).
 *
 * ONE component for both hosts. The Add sheet uses it to connect a provider it
 * is adding; the Manage sheet uses it to RE-authorise one that is already
 * connected. It used to be `VendorOpencodeSection`'s `renderOAuthFlow` +
 * `oauthSlotFor` pair, which is why the state machine below is that one
 * verbatim — a second copy that drifted from it is exactly how a credential
 * surface starts lying about whether the user is signed in.
 *
 * THREE PATHS, decided by the platform and by the vendor's own auth method:
 *
 *  · web (ADR-057) — the store parks the flow on `vendorOAuth` (`paste` /
 *    `error`) and the two-step `OAuthPasteBackFlow` finishes it. The host never
 *    opens a browser for a remote caller, so step 1's `window.open` is the
 *    component's own user gesture.
 *  · desktop, `auto` — the store opens the host browser and awaits the
 *    loopback; `waiting` renders a Cancel and nothing else.
 *  · desktop, `code` — the store returns `needsPaste`, and the vendor's own
 *    instructions plus a code box post to `vendor-auth:oauth-callback`
 *    directly. That path is deliberately NOT routed through
 *    `submitVendorOAuthCode`, which consumes the web-only `paste` stage.
 *
 * It owns no credential state: `onDone` is the caller's cue to re-read whatever
 * it renders from (the provider registry), because nothing here can know what a
 * successful sign-in changed.
 */

import { useState } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { useSessionStore } from '../../stores/session-store'
import type { EngineId } from '../../../../shared/types'
import {
  OAuthOutcomeNotice,
  OAuthPasteBackFlow,
  classifyOAuthError
} from '../auth/OAuthPasteBackFlow'
import { Button } from './settings-controls'

const FLOW = 'VendorOAuthFlow'

/** The desktop `code` method's local stage (the web flow lives on the store). */
type LocalStage =
  | { stage: 'idle' }
  | { stage: 'instructions'; instructions: string; method: number }
  | { stage: 'submitting' }

export function VendorOAuthFlow({
  engineId,
  vendorId,
  label,
  disabled = false,
  onDone
}: {
  engineId: EngineId
  /** The id the ENGINE's own auth store knows this vendor by. */
  vendorId: string
  /** The start button's text — the vendor's own option label where there is one. */
  label: string
  disabled?: boolean
  /** A credential was written; the caller re-reads and closes what it must. */
  onDone: () => void
}): React.JSX.Element {
  const { vendorOAuth, authorizeVendorOAuth, cancelVendorOAuth, submitVendorOAuthCode } =
    useSessionStore(
      useShallow((s) => ({
        vendorOAuth: s.vendorOAuth,
        authorizeVendorOAuth: s.authorizeVendorOAuth,
        cancelVendorOAuth: s.cancelVendorOAuth,
        submitVendorOAuthCode: s.submitVendorOAuthCode
      }))
    )
  const [local, setLocal] = useState<LocalStage>({ stage: 'idle' })
  const [code, setCode] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [pasteBusy, setPasteBusy] = useState(false)

  const isWeb = window.api.platform === 'web'
  /** This vendor's flow on the store — another vendor's must not render here. */
  const flow =
    vendorOAuth?.engineId === engineId && vendorOAuth.vendorId === vendorId ? vendorOAuth : null

  const start = async (): Promise<void> => {
    setError(null)
    try {
      const result = await authorizeVendorOAuth(engineId, vendorId)
      if (result.ok) {
        onDone()
        return
      }
      // Web: the store already parked `paste` (or `error` — opencode's
      // remote-`auto` refusal), and both render below. Nothing local to set.
      if (isWeb) return
      if (result.needsPaste) {
        setLocal({
          stage: 'instructions',
          instructions: result.needsPaste.instructions,
          method: result.needsPaste.method
        })
      } else if (result.error) {
        setError(result.error)
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  const submitLocalCode = async (): Promise<void> => {
    if (local.stage !== 'instructions') return
    const trimmed = code.trim()
    if (!trimmed) return
    const { method } = local
    setLocal({ stage: 'submitting' })
    try {
      await window.api.vendorAuthOauthCallback(engineId, vendorId, method, trimmed)
      setLocal({ stage: 'idle' })
      setCode('')
      onDone()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'OAuth callback failed')
      setLocal({ stage: 'idle' })
    }
  }

  return (
    <div data-testid={FLOW} data-id={vendorId} className="space-y-2">
      <div>
        <Button
          variant="tinted"
          testid={`${FLOW}.start`}
          dataId={vendorId}
          disabled={disabled || flow?.stage === 'waiting' || local.stage !== 'idle'}
          onClick={() => void start()}
        >
          {flow?.stage === 'waiting' ? 'Connecting…' : label}
        </Button>
      </div>

      {flow?.stage === 'waiting' && (
        <div className="flex items-center gap-2 text-[11px] text-text-muted">
          Waiting for browser authorization…
          <Button variant="link" testid={`${FLOW}.cancel`} onClick={() => cancelVendorOAuth()}>
            Cancel
          </Button>
        </div>
      )}

      {/* Remote two-step flow. Never reached on desktop — the store only parks
          `paste` for a web caller. */}
      {flow?.stage === 'paste' && (
        <OAuthPasteBackFlow
          variant="url"
          id={vendorId}
          url={flow.url}
          busy={pasteBusy}
          onSubmit={(pasted) => {
            setPasteBusy(true)
            void submitVendorOAuthCode(pasted)
              .then((result) => {
                if (result.ok) onDone()
              })
              .finally(() => setPasteBusy(false))
          }}
          onCancel={cancelVendorOAuth}
        />
      )}

      {flow?.stage === 'error' &&
        (flow.error ? (
          <OAuthOutcomeNotice
            kind={classifyOAuthError(flow.error)}
            message={flow.error}
            id={vendorId}
          />
        ) : (
          <div className="text-[11px] text-danger">Authentication failed. Try again.</div>
        ))}

      {local.stage === 'instructions' && (
        <div className="space-y-1.5">
          <div className="text-[11px] text-text-muted leading-relaxed whitespace-pre-wrap">
            {local.instructions}
          </div>
          <div className="flex items-center gap-1.5">
            <input
              type="text"
              data-testid={`${FLOW}.code`}
              data-id={vendorId}
              placeholder="Paste code here"
              spellCheck={false}
              autoComplete="off"
              value={code}
              onChange={(e) => setCode(e.target.value)}
              className="flex-1 min-w-0 h-7 bg-bg-input border border-border rounded-md px-2.5 text-[12px] font-mono text-text-primary placeholder:text-text-muted outline-none focus:border-accent/50 transition-colors"
            />
            <Button
              variant="tinted"
              testid={`${FLOW}.submit`}
              dataId={vendorId}
              disabled={!code.trim()}
              onClick={() => void submitLocalCode()}
            >
              Submit
            </Button>
            <Button
              variant="link"
              testid={`${FLOW}.cancel`}
              onClick={() => {
                void window.api.vendorAuthOauthCancel(engineId).catch(() => {})
                setLocal({ stage: 'idle' })
                setCode('')
              }}
            >
              Cancel
            </Button>
          </div>
        </div>
      )}

      {local.stage === 'submitting' && (
        <div className="text-[11px] text-text-muted">Submitting code…</div>
      )}

      {error && (
        <div data-testid={`${FLOW}.error`} className="text-[11px] text-danger">
          {error}
        </div>
      )}
    </div>
  )
}
