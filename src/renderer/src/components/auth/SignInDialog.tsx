/**
 * SignInDialog — the ONE place a sign-in flow renders (ADR-068 §3, mockup
 * screen 5, owner-approved 2026-09-13).
 *
 * Before this, four surfaces each grew their own flow: the Claude banner
 * expanded into a paste field, the transcript's `AuthErrorBlock` walked the
 * OAuth states inline, opencode's `VendorAuthRequiredCard` did it a third time,
 * and the settings account rows a fourth. Four copies of one state machine is
 * how a credential surface ends up telling the user two different things about
 * whether they are signed in.
 *
 * WHAT THIS OWNS AND WHAT IT DOES NOT. It owns the STAGES — choose an account,
 * watch the flow, report what changed — and nothing else. The flows themselves
 * stay exactly where they were:
 *
 *  · Anthropic (ADR-014 / ADR-015) — `signIn()` to re-authorise, `addAccount()`
 *    to add one (its `pendingSignIn` seeds the remote paste panel),
 *    `submitOAuthCode` / `cancelSignIn`;
 *  · ChatGPT (ADR-036 / ADR-068 §1) — `authorizeVendorOAuth('pi',
 *    'openai-codex')`, `submitVendorOAuthCode` / `cancelVendorOAuth`.
 *
 * So there is no third flow state: `authState` and `vendorOAuth` are still the
 * single source for each provider, and this is a view over them. Dismissing the
 * dialog mid-flight therefore leaves the flow RUNNING — the banner keeps
 * reporting it — which is what makes "close it and keep working" safe.
 *
 * THE HOST VARIANT IS DERIVED, NEVER CHOSEN (ADR-057). A web client has no host
 * browser to wait on; the desktop opens its own browser and gets "Waiting for
 * the browser…" with a manual link. A user cannot pick the wrong one because
 * there is nothing to pick.
 *
 * WHICH REMOTE ChatGPT FLOW (Slice 7, ADR-068 §3) is the one thing the user CAN
 * change, and only in one direction: a web client defaults to DEVICE CODE
 * (`DeviceCodeFlow` — open a link, type a code, the host polls), and "Paste the
 * callback URL instead" falls back to ADR-057's `OAuthPasteBackFlow` for a
 * server that has device code turned off. Anthropic is untouched either way —
 * cli.js owns that flow — and the desktop never sees either panel.
 *
 * VISUAL VOCABULARY. `SettingRow` / `SheetGroup` / `Button` from the settings
 * dialog, so an account row here reads as the same object as an account row in
 * Settings. `SheetFrame` itself does NOT fit: its geometry mirrors the settings
 * dialog's box in order to pin itself to that box's right edge, and this dialog
 * opens over the chat.
 */

import { useCallback, useEffect, useState } from 'react'
import { useShallow } from 'zustand/react/shallow'
import {
  useSessionStore,
  type SignInProviderId,
  type SignInRequest
} from '../../stores/session-store'
import { SIGN_IN_PROVIDER_LABEL } from '../../utils/sign-in-provider'
import { useIsMobile } from '../../hooks/useIsMobile'
import { useEscapeLayer } from '../shared/use-escape-layer'
import { SettingRow, Button } from '../SettingsDialog/settings-controls'
import { SheetGroup } from '../SettingsDialog/SheetFrame'
import { OAuthOutcomeNotice, OAuthPasteBackFlow, classifyOAuthError } from './OAuthPasteBackFlow'
import { DeviceCodeFlow } from './DeviceCodeFlow'

const DIALOG = 'SignInDialog'

/** pi's auth.json key for the ChatGPT credential — `CredentialSync.PI_CODEX_VENDOR_ID`. */
const CODEX_VENDOR_ID = 'openai-codex'
/** The shared vault's id for the ChatGPT subscription. */
const CHATGPT_ID = 'chatgpt'

// One name table for every entry point (Slice 6): the picker item, the composer
// hint and this heading must agree on what the provider is called.
const PROVIDER_NAME = SIGN_IN_PROVIDER_LABEL

const PROVIDER_BLURB: Record<SignInProviderId, string> = {
  anthropic: 'Your Claude subscription, used by Claude Code sessions.',
  chatgpt: 'One ChatGPT sign-in, shared with pi, opencode and Codex.'
}

const message = (e: unknown): string => (e instanceof Error ? e.message : String(e))

/** One stored account, flattened out of the two providers' different shapes. */
interface AccountRow {
  id: string
  label: string
  description?: string
  active: boolean
}

type Stage = 'choose' | 'flow' | 'done'

/** The two ChatGPT flows a WEB client can run — see `chatgptFlow` below. */
type ChatgptFlowKind = 'device' | 'paste'

export function SignInDialog(): React.JSX.Element | null {
  const request = useSessionStore((s) => s.signInDialog)
  if (!request) return null
  // Remounted on every open, so no stage, error or account list survives from
  // the previous one — a dialog that reopened on a stale "done" is the failure
  // this key removes without a reset effect that has to enumerate the state.
  return <SignInDialogBody key={`${request.providerId}:${request.mode}`} request={request} />
}

function SignInDialogBody({ request }: { request: SignInRequest }): React.JSX.Element {
  const isMobile = useIsMobile()
  const {
    closeSignIn,
    authState,
    vendorOAuth,
    signIn,
    submitOAuthCode,
    cancelSignIn,
    authorizeVendorOAuth,
    authorizeVendorDeviceCode,
    submitVendorOAuthCode,
    cancelVendorOAuth,
    setAuthState,
    setAccountsState,
    loadProviderAccounts,
    retrySend
  } = useSessionStore(
    useShallow((s) => ({
      closeSignIn: s.closeSignIn,
      authState: s.authState,
      vendorOAuth: s.vendorOAuth,
      signIn: s.signIn,
      submitOAuthCode: s.submitOAuthCode,
      cancelSignIn: s.cancelSignIn,
      authorizeVendorOAuth: s.authorizeVendorOAuth,
      authorizeVendorDeviceCode: s.authorizeVendorDeviceCode,
      submitVendorOAuthCode: s.submitVendorOAuthCode,
      cancelVendorOAuth: s.cancelVendorOAuth,
      setAuthState: s.setAuthState,
      setAccountsState: s.setAccountsState,
      loadProviderAccounts: s.loadProviderAccounts,
      retrySend: s.retrySend
    }))
  )

  const { providerId } = request
  const isWeb = window.api.platform === 'web'

  const [stage, setStage] = useState<Stage>('choose')
  /**
   * Which ChatGPT flow the web client is on (Slice 7). Device code is the
   * DEFAULT — "open this link, type this code" is the step a phone can finish —
   * and "Paste the callback URL instead" drops to ADR-057's panel for a server
   * with device code turned off. Ignored on desktop and for Anthropic.
   */
  const [chatgptFlow, setChatgptFlow] = useState<ChatgptFlowKind>('device')
  /** Which mode the live flow was started in, so the paste fallback restarts the same one. */
  const [flowMode, setFlowMode] = useState<'reauth' | 'add'>('reauth')
  /** null while the account read is in flight — the chooser must not flash empty. */
  const [accounts, setAccounts] = useState<AccountRow[] | null>(null)
  const [canAdd, setCanAdd] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)
  const [signedInAs, setSignedInAs] = useState<string | null>(null)
  const [plan, setPlan] = useState<string | null>(null)
  const [fanOut, setFanOut] = useState<Array<{ id: string; text: string }>>([])

  useEscapeLayer(closeSignIn)

  /**
   * The stored accounts, plus whether there is anything to CHOOSE between.
   *
   * The two answers are separate on purpose (F3). "No rows" used to mean both
   * "start the flow, there is nothing to pick" and "this host has no account",
   * and Anthropic with multi-account off is the case where they disagree: one
   * credential is signed in, but there is no alternative to switch to. It
   * auto-starts like an empty list AND names its account like a full one, so the
   * chooser the user lands on after Cancel tells the truth either way.
   */
  const readAccounts = useCallback(async (): Promise<{
    rows: AccountRow[]
    autoStart: boolean
    /** Whether "Add another account" is offered. False for Anthropic with
     *  multi-account OFF: `addAccount()` would silently switch the host to
     *  file-based multi-account, a Settings decision, not a side effect of
     *  cancelling a sign-in. */
    canAdd: boolean
  }> => {
    if (providerId === 'anthropic') {
      const state = await window.api.getAccounts()
      setAccountsState(state)
      const rows = state.accounts.map((account) => ({
        id: account.id,
        label: account.email || 'Account',
        description: account.subscriptionType ?? undefined,
        active: account.id === state.activeId
      }))
      if (!state.enabled) {
        // Multi-account off means ONE credential and nothing to choose between;
        // the chooser would be a list of one with no alternative. Report that
        // one — the active row, or the only one on file — rather than an empty
        // list that would read as "nobody is signed in".
        const one = rows.find((row) => row.active) ?? rows[0]
        return { rows: one ? [{ ...one, active: true }] : [], autoStart: true, canAdd: false }
      }
      return { rows, autoStart: rows.length === 0, canAdd: true }
    }
    const list = await window.api.listProviderAccounts(CHATGPT_ID)
    const rows = list.accounts.map((account) => ({
      id: account.id,
      label: account.email || 'Account',
      description:
        [account.planType, account.needsReauth ? 'sign-in expired' : null]
          .filter(Boolean)
          .join(' · ') || undefined,
      active: account.id === list.activeId
    }))
    return { rows, autoStart: rows.length === 0, canAdd: true }
  }, [providerId, setAccountsState])

  /** Everything the done state reports, read AFTER the credential was written. */
  const collectOutcome = useCallback(async (): Promise<void> => {
    if (providerId === 'anthropic') {
      const account = useSessionStore.getState().authState?.account
      setSignedInAs(account?.email ?? null)
      setPlan(account?.subscriptionType ?? null)
      setFanOut([])
      return
    }
    const [list, definitions] = await Promise.all([
      window.api.listProviderAccounts(CHATGPT_ID).catch(() => null),
      window.api.listSharedProviders().catch(() => [])
    ])
    const active = list?.accounts.find((account) => account.id === list.activeId)
    setSignedInAs(active?.email ?? null)
    setPlan(active?.planType ?? null)
    const definition = definitions.find((entry) => entry.id === CHATGPT_ID)
    const lines: Array<{ id: string; text: string }> = []
    if (definition?.routes.pi.enabled)
      lines.push({ id: 'pi', text: 'pi is using the new token now.' })
    if (definition?.routes.opencode.enabled)
      lines.push({ id: 'opencode', text: 'opencode picks it up on its next server start.' })
    // Codex is not a ROUTE on the definition — ADR-068 §1 feeds it by injection
    // from the same vault account, and 2a's refresh path makes a live re-inject
    // lazy — so it is reported unconditionally rather than read off a flag that
    // does not exist, and it says "next request" rather than claiming more.
    lines.push({ id: 'codex', text: 'Codex sessions use the new token on their next request.' })
    setFanOut(lines)
    void loadProviderAccounts()
  }, [providerId, loadProviderAccounts])

  const finish = useCallback(async (): Promise<void> => {
    await collectOutcome()
    setStage('done')
  }, [collectOutcome])

  const start = useCallback(
    async (mode: 'reauth' | 'add', flowKind?: ChatgptFlowKind): Promise<void> => {
      setError(null)
      setBusy(true)
      setStage('flow')
      setFlowMode(mode)
      try {
        if (providerId === 'anthropic') {
          if (mode === 'add') {
            const next = await window.api.addAccount()
            setAccountsState(next)
            // Only a REMOTE `account:add` carries it; it is the flow's manualUrl.
            if (next.pendingSignIn) setAuthState(next.pendingSignIn)
          } else {
            await signIn()
          }
          return
        }
        // Slice 7: a WEB client defaults to device code — the host requests a
        // code and polls, and this promise resolves only once the credential is
        // stored, exactly like the desktop loopback's. The paste fallback and
        // the desktop both stay on the PKCE flow.
        if (isWeb && (flowKind ?? chatgptFlow) === 'device') {
          const device = await authorizeVendorDeviceCode('pi', CODEX_VENDOR_ID)
          if (device.ok) await finish()
          else if (device.error) setError(device.error)
          return
        }
        const result = await authorizeVendorOAuth('pi', CODEX_VENDOR_ID)
        // Desktop resolves ok once the loopback completed; web parks the store's
        // flow at `paste` (or `error`) and the panel below takes over.
        if (result.ok) await finish()
        else if (result.error) setError(result.error)
      } catch (e) {
        setError(message(e))
        setStage('choose')
      } finally {
        setBusy(false)
      }
    },
    [
      providerId,
      isWeb,
      chatgptFlow,
      signIn,
      authorizeVendorOAuth,
      authorizeVendorDeviceCode,
      setAccountsState,
      setAuthState,
      finish
    ]
  )

  /**
   * Start the flow when the chooser has nothing to offer — the open-time skip,
   * and the one button an EMPTY chooser shows. One helper rather than two copies
   * of the condition, because the two modes are different calls for Anthropic:
   * `add` goes through `addAccount()` (a SECOND credential), `reauth` through
   * `signIn()`, and an empty list has nothing to add alongside.
   */
  const startWithoutChoosing = useCallback(
    (): Promise<void> => start(request.mode === 'add' ? 'add' : 'reauth'),
    [start, request.mode]
  )

  // Open: read the accounts, then decide whether there is anything to choose
  // between. `add` never has anything to choose; neither does a provider with no
  // stored account (or Anthropic with multi-account off), so both go straight to
  // the flow.
  useEffect(() => {
    let cancelled = false
    void readAccounts()
      .then(({ rows, autoStart, canAdd }) => {
        if (cancelled) return
        setAccounts(rows)
        setCanAdd(canAdd)
        if (request.mode === 'add' || autoStart) void startWithoutChoosing()
      })
      .catch((e: unknown) => {
        if (cancelled) return
        setAccounts([])
        setError(message(e))
      })
    return () => {
      cancelled = true
    }
    // Once per open — the dialog is remounted (keyed) for every new request.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Anthropic's flow finishes OUT OF BAND: the host drives the browser and the
  // terminal transition arrives on `auth:state`, so success is a state edge here,
  // not a resolved promise.
  useEffect(() => {
    if (stage !== 'flow' || providerId !== 'anthropic') return
    if (authState?.status === 'success') void finish()
  }, [stage, providerId, authState?.status, finish])

  const switchTo = async (id: string): Promise<void> => {
    setBusy(true)
    setError(null)
    try {
      if (providerId === 'anthropic') setAccountsState(await window.api.switchAccount(id))
      else {
        await window.api.switchProviderAccount(CHATGPT_ID, id)
        await loadProviderAccounts()
      }
      closeSignIn()
    } catch (e) {
      setError(message(e))
    } finally {
      setBusy(false)
    }
  }

  const cancelFlow = (): void => {
    if (providerId === 'anthropic') void cancelSignIn()
    else cancelVendorOAuth()
    // ALWAYS back to the chooser (F3, owner ruling 2026-09-14). Staying on the
    // flow panel left a cancelled sign-in still showing its pre-code look —
    // "Requesting a code…" for a request nobody is making — and the chooser is
    // perfectly able to say that no account is signed in.
    setStage('choose')
    // The cancelled start is still parked in its poll/await and will not clear
    // this for another cadence, which would leave the chooser's own buttons
    // disabled; nothing is running as far as the user is concerned.
    setBusy(false)
  }

  const retryPrompt = (): void => {
    const retry = request.retry
    closeSignIn()
    if (retry) void retrySend(retry.routingId, retry.prompt)
  }

  // ── The flow panel ───────────────────────────────────────────────────────
  /** The authorize URL this provider's flow parked, whichever host we are on. */
  const flowUrl = providerId === 'anthropic' ? authState?.manualUrl : vendorOAuth?.url
  const flowError =
    providerId === 'anthropic'
      ? authState?.status === 'error'
        ? authState.error
        : null
      : vendorOAuth?.stage === 'error'
        ? (vendorOAuth.error ?? null)
        : null

  const submitPaste = (pasted: string): void => {
    setSubmitting(true)
    // Anthropic: `submitOAuthCode` folds the outcome into `authState` and the
    // success effect above advances the stage, exactly as on desktop. ChatGPT
    // has no such event, so its result is read here.
    const done =
      providerId === 'anthropic'
        ? submitOAuthCode(pasted)
        : submitVendorOAuthCode(pasted).then((result) => (result.ok ? finish() : undefined))
    void done.finally(() => setSubmitting(false))
  }

  /**
   * Abandon the device code and fall back to ADR-057's paste panel — the escape
   * hatch for a server with device code turned off, or a user who would rather
   * copy a URL. Cancels host-side first (that flow holds the vault's single
   * login slot; a PKCE start would otherwise be refused as "already in
   * progress"), then restarts in the SAME mode the user chose.
   */
  const pasteInstead = (): void => {
    cancelVendorOAuth()
    setChatgptFlow('paste')
    void start(flowMode, 'paste')
  }

  /** The live device-code flow, when that is what is running (web + ChatGPT only). */
  const deviceState =
    isWeb && providerId === 'chatgpt' && vendorOAuth?.stage === 'device-code'
      ? vendorOAuth
      : undefined
  const onDeviceFlow = isWeb && providerId === 'chatgpt' && chatgptFlow === 'device'

  const flowPanel = onDeviceFlow ? (
    <DeviceCodeFlow
      id={providerId}
      verificationUrl={deviceState?.verificationUrl}
      userCode={deviceState?.userCode}
      expiresAt={deviceState?.expiresAt}
      // Busy only until the host answers with a code: the wait AFTER that is the
      // flow's normal state, and locking Copy for fifteen minutes of it would
      // make the panel useless.
      busy={busy && !deviceState}
      onCancel={cancelFlow}
      onPasteInstead={pasteInstead}
    />
  ) : isWeb ? (
    <OAuthPasteBackFlow
      variant={providerId === 'anthropic' ? 'code' : 'url'}
      id={providerId}
      url={flowUrl}
      busy={submitting || busy}
      onSubmit={submitPaste}
      onCancel={cancelFlow}
    />
  ) : (
    <div data-testid={`${DIALOG}.waiting`} className="space-y-2">
      <div className="text-[13px] text-text-primary">Waiting for the browser…</div>
      <div className="text-[12px] text-text-secondary leading-relaxed">
        Finish the sign-in in the browser window we opened. It completes on its own.
      </div>
      <div className="flex items-center gap-2">
        {flowUrl && (
          <Button
            variant="link"
            testid={`${DIALOG}.manualLink`}
            onClick={() => window.open(flowUrl, '_blank', 'noopener,noreferrer')}
          >
            Open the link manually ↗
          </Button>
        )}
        <Button variant="link" testid={`${DIALOG}.cancel`} onClick={cancelFlow}>
          Cancel
        </Button>
      </div>
    </div>
  )

  // ── Body ─────────────────────────────────────────────────────────────────
  /** The account read has SETTLED on nothing — the chooser has to say so. */
  const isEmptyList = accounts !== null && accounts.length === 0

  const body =
    stage === 'done' ? (
      <div data-testid={`${DIALOG}.done`} className="space-y-3">
        <SettingRow
          testid={`${DIALOG}.signedIn`}
          label={signedInAs ? `Signed in as ${signedInAs}` : 'Signed in'}
          description={plan ?? undefined}
        />
        {fanOut.length > 0 && (
          <SheetGroup testid={`${DIALOG}.group`} id="fanout" label="What changed">
            {fanOut.map((line) => (
              <SettingRow
                key={line.id}
                testid={`${DIALOG}.fanOut`}
                dataId={line.id}
                description={line.text}
              />
            ))}
          </SheetGroup>
        )}
      </div>
    ) : stage === 'flow' ? (
      <div className="space-y-3">
        {flowPanel}
        {flowError && (
          <OAuthOutcomeNotice
            kind={classifyOAuthError(flowError)}
            message={flowError}
            id={providerId}
          />
        )}
      </div>
    ) : (
      <SheetGroup testid={`${DIALOG}.group`} id="accounts" label="Accounts">
        {/* `accounts === null` is the read still in flight, NOT an empty list —
            claiming "no account is signed in" before the answer arrives would be
            a guess, and the wrong one on most hosts. */}
        {/* With multi-account off the Anthropic credential lives in the system
            store and is invisible to this list, so "no account" would be a
            claim the dialog cannot make; the Sign in row alone is honest. */}
        {isEmptyList && canAdd && (
          <SettingRow
            testid={`${DIALOG}.empty`}
            description={`No ${PROVIDER_NAME[providerId]} account is signed in on this host.`}
          />
        )}
        {(accounts ?? []).map((account) => (
          <SettingRow
            key={account.id}
            testid={`${DIALOG}.account`}
            dataId={account.id}
            label={account.label}
            description={account.description}
            className={account.active ? 'bg-accent/5' : undefined}
          >
            {account.active || account.id === request.accountId ? (
              <Button
                variant="primary"
                testid={`${DIALOG}.reauth`}
                dataId={account.id}
                disabled={busy}
                onClick={() => void start('reauth')}
              >
                Re-authorize
              </Button>
            ) : (
              <Button
                variant="tinted"
                testid={`${DIALOG}.switch`}
                dataId={account.id}
                disabled={busy}
                onClick={() => void switchTo(account.id)}
              >
                Switch
              </Button>
            )}
          </SettingRow>
        ))}
        {(canAdd || isEmptyList) && (
          <SettingRow
            testid={`${DIALOG}.addRow`}
            description={
              !canAdd
                ? `Signs in to ${PROVIDER_NAME[providerId]} in the browser.`
                : isEmptyList
                  ? `Signs in to a ${PROVIDER_NAME[providerId]} account and adds it to the list.`
                  : `Signs in to another ${PROVIDER_NAME[providerId]} account and adds it to the list.`
            }
          >
            <Button
              variant="tinted"
              testid={`${DIALOG}.addAccount`}
              disabled={busy}
              // With nothing on the list this is the SAME start the dialog would
              // have run on open — `add` would send Anthropic through
              // `addAccount()`, which adds a second credential to a host that has
              // none.
              onClick={() => void (isEmptyList ? startWithoutChoosing() : start('add'))}
            >
              {isEmptyList ? 'Sign in' : 'Add another account'}
            </Button>
          </SettingRow>
        )}
      </SheetGroup>
    )

  return (
    <div data-testid={DIALOG} data-id={providerId} className="fixed inset-0 z-[100] flex">
      <span
        data-testid={`${DIALOG}.scrim`}
        onClick={closeSignIn}
        className="absolute inset-0 bg-black/40 backdrop-blur-sm"
      />
      <div
        className={
          isMobile
            ? 'relative z-10 w-full h-full flex flex-col bg-bg-primary animate-fade-in'
            : 'relative z-10 m-auto w-[460px] max-w-[92vw] max-h-[88vh] flex flex-col bg-bg-primary border border-border rounded-xl shadow-2xl animate-fade-in'
        }
      >
        <div className="h-[52px] shrink-0 flex items-center gap-2 px-4 border-b border-border">
          <span className="min-w-0">
            <span className="block text-[15px] font-semibold text-text-primary truncate">
              Sign in to {PROVIDER_NAME[providerId]}
            </span>
            <span className="block text-[11px] text-text-secondary truncate">
              {PROVIDER_BLURB[providerId]}
            </span>
          </span>
          <button
            type="button"
            data-testid={`${DIALOG}.close`}
            title="Close"
            onClick={closeSignIn}
            className="ml-auto shrink-0 w-6 h-6 flex items-center justify-center rounded-md text-text-secondary hover:bg-bg-hover hover:text-text-primary transition-colors cursor-default"
          >
            <svg
              width="14"
              height="14"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
            >
              <path d="M18 6L6 18M6 6l12 12" />
            </svg>
          </button>
        </div>

        <div className="flex-1 min-h-0 overflow-y-auto px-4 py-4">{body}</div>

        <div className="shrink-0 flex items-center gap-2 px-4 py-3 border-t border-border">
          <span
            data-testid={`${DIALOG}.error`}
            className="flex-1 min-w-0 truncate text-[12px] text-danger"
          >
            {error}
          </span>
          {stage === 'done' && request.retry && (
            <Button variant="tinted" testid={`${DIALOG}.retry`} onClick={retryPrompt}>
              Retry last prompt
            </Button>
          )}
          <Button variant="primary" testid={`${DIALOG}.close2`} onClick={closeSignIn}>
            {stage === 'done' ? 'Done' : 'Close'}
          </Button>
        </div>
      </div>
    </div>
  )
}
