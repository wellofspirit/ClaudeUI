import { useCallback, useEffect, useReducer, useState } from 'react'
import { isEnrollNotPermittedError } from '../../../../shared/remote-protocol'
import type { RemoteAuthMethod } from '../../../../shared/types'
import { isWebClient } from './remote-settings-transport'

/**
 * THE enrollment flow — one implementation, two surfaces (ADR-052 §Enrollment).
 *
 * Self-enrolment ("save a passkey on THIS device") is offered in two places and
 * they must never drift apart:
 *
 *  - the one-shot STRIP (`src/web/components/EnrollPrompt.tsx`), shown once per
 *    device after a password sign-in and latched off in `localStorage` the
 *    moment the operator says "not now";
 *  - the durable CARD (`EnrollCard.tsx`), at the top of Settings › Remote on the
 *    web client, which is how the operator gets back to the offer after they
 *    dismissed the strip — or after they never saw it, because the phone first
 *    connected from an origin that could not bind a credential.
 *
 * Both run {@link useEnrollFlow}, so the refusal branch that matters (a password
 * connection under effective-`legacy` holds no `enroll`, so the FIRST passkey has
 * to come from the desktop) is written once and cannot be half-implemented on one
 * of them.
 *
 * ## Why this module lives in the renderer
 *
 * The card is a shared settings component: the same React tree renders in the
 * desktop renderer and in the web bundle. It therefore cannot import
 * `src/web/connection` — that would pull the web transport (and
 * `@simplewebauthn/browser`) into the desktop build for a surface the desktop can
 * never show, since the desktop renderer is loaded from `file://` and has no RP
 * ID to bind a credential to. So the web entry INSTALLS a bridge on `window`
 * before React mounts, exactly as it already does for the step-up gate and the
 * mockup/file tokens, and the shared component consumes it. The strip, being
 * web-only, imports the hook from here directly.
 */

/**
 * The web entry's enrolment capabilities, as seen by a shared component.
 *
 * Every member is a LIVE read of the connection rather than a snapshot: the
 * facts it reports are per-socket (`auth-response` sets them, a close clears
 * them), so a captured value would describe a connection that is already gone.
 * {@link EnrollBridge.subscribe} is how a consumer learns to re-read.
 */
export interface EnrollBridge {
  /** How the server says THIS connection authenticated, or undefined pre-auth. */
  authMethod(): RemoteAuthMethod | undefined
  /**
   * The SERVER's classification of this connection's origin
   * (`auth-response.webauthnCapableOrigin`) — could a credential be bound here at
   * all? Never the browser's own answer: an HTTPS tunnel page passes every
   * browser test and can still bind nothing, because the RP ID would be an
   * ephemeral hostname that dies with the tunnel.
   */
  capableOrigin(): boolean
  /**
   * Could this BROWSER even attempt a ceremony (secure context + the API)? A
   * necessary second condition, never a sufficient one — the plain-HTTP tailnet
   * address is a capable Host on a page that cannot run WebAuthn at all.
   */
  browserCapable(): boolean
  /** Register a passkey for this device on the current connection. */
  enroll(nickname?: string | null): Promise<void>
  /** Called back whenever any of the three facts above may have moved. */
  subscribe(cb: () => void): () => void
}

/**
 * The `window` key the web entry installs the bridge under. Same shape as
 * `__STEP_UP_REQUEST__` / `__MOCKUP_TOKEN__`: a web-only capability handed to a
 * shared renderer through the one surface both builds have.
 */
const BRIDGE_KEY = '__REMOTE_ENROLL__'

type BridgeHolder = { [BRIDGE_KEY]?: EnrollBridge | null }

export function installEnrollBridge(bridge: EnrollBridge | null): void {
  ;(window as unknown as BridgeHolder)[BRIDGE_KEY] = bridge
}

export function getEnrollBridge(): EnrollBridge | null {
  return (window as unknown as BridgeHolder)[BRIDGE_KEY] ?? null
}

/**
 * THE offer rule, stated once (main.tsx's strip gate and the card's visibility
 * both call it).
 *
 * Deliberately NOT gated on the passkey advertisement: that flag needs ≥1
 * credential to exist, which would withhold the offer in precisely the case where
 * the operator most needs to be told something — first web login, nothing
 * enrolled, wondering where passkeys live. On a capable origin the offer is
 * honest work either way: it enrols, or the server refuses and the refusal itself
 * teaches where the first passkey comes from.
 */
export function enrollOfferable(facts: {
  authMethod: RemoteAuthMethod | undefined
  capableOrigin: boolean
  browserCapable: boolean
}): boolean {
  // Only a PASSWORD connection has something to gain: a passkey connection
  // already holds one, and an enrollment-link one is on its way to holding one.
  return facts.authMethod === 'password' && facts.capableOrigin && facts.browserCapable
}

/**
 * The bridge, but only while it is worth offering enrolment through — otherwise
 * null, which is the card's "render nothing".
 *
 * Re-reads on every bridge notification, because the answer is a fact about the
 * CURRENT socket and a reconnect can change it in either direction (a phone that
 * moves from the LAN link to the tailnet name becomes offerable without the
 * settings pane being touched).
 */
export function useEnrollOffer(): EnrollBridge | null {
  const [, bump] = useReducer((n: number) => n + 1, 0)
  useEffect(() => {
    return getEnrollBridge()?.subscribe(bump)
  }, [])

  const bridge = getEnrollBridge()
  // The desktop renderer never enrols (no RP ID at `file://`), and a build with
  // no bridge installed is the desktop by definition — but check the platform
  // too, so a stale bridge left on `window` by a test cannot light this up.
  if (!bridge || !isWebClient()) return null
  return enrollOfferable({
    authMethod: bridge.authMethod(),
    capableOrigin: bridge.capableOrigin(),
    browserCapable: bridge.browserCapable()
  })
    ? bridge
    : null
}

export interface EnrollFlowState {
  busy: boolean
  /** A failure the operator can retry (a cancelled prompt, a verify refusal). */
  error?: string
  /** The server refused for want of the `enroll` capability — see the module doc. */
  needsDesktop: boolean
  /** A credential was registered on this device. */
  done: boolean
  submit: () => void
}

/**
 * Run one enrolment attempt and classify its outcome.
 *
 * The REFUSAL is the interesting state and the reason this is shared: under
 * effective-`legacy` a password connection does not hold `enroll` (a stolen
 * password must not be able to mint a permanent credential), so the honest answer
 * is guidance rather than an error — the first passkey comes from the desktop.
 */
export function useEnrollFlow(enroll: () => Promise<void>): EnrollFlowState {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string>()
  const [needsDesktop, setNeedsDesktop] = useState(false)
  const [done, setDone] = useState(false)

  const submit = useCallback((): void => {
    if (busy) return
    setBusy(true)
    setError(undefined)
    void (async () => {
      try {
        await enroll()
        setDone(true)
      } catch (err) {
        if (isEnrollNotPermittedError(err)) setNeedsDesktop(true)
        else setError(err instanceof Error ? err.message : String(err))
      } finally {
        setBusy(false)
      }
    })()
  }, [busy, enroll])

  return { busy, error, needsDesktop, done, submit }
}
