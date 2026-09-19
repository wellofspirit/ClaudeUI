/**
 * SignInDialog — the ONE place a sign-in flow renders (ADR-068 §3, mockup
 * screen 5, owner-approved 2026-09-13; trimmed per ADR-070 §5 / mockup
 * `4ed195a3`).
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
 * dialog mid-flight therefore leaves the flow RUNNING — the pill keeps
 * reporting it — which is what makes "close it and keep working" safe.
 *
 * THE HOST VARIANT IS DERIVED, NEVER CHOSEN (ADR-057). A web client has no host
 * browser to wait on; the desktop opens its own browser and gets "Waiting for
 * the browser…" with a manual link. A user cannot pick the wrong one because
 * there is nothing to pick.
 *
 * WHICH REMOTE ChatGPT FLOW (Slice 7, ADR-068 §3) is the one thing the user CAN
 * change, and only in one direction: a web client defaults to DEVICE CODE
 * (`DeviceCodeFlow` — open a link, type a code, the host polls), and "Paste a
 * URL instead" falls back to ADR-057's `OAuthPasteBackFlow` for a server that
 * has device code turned off. Anthropic is untouched either way — cli.js owns
 * that flow — and the desktop never sees either panel.
 *
 * NO FOOTER (ADR-070 §5 rule 6). `×`, the scrim and Escape close the dialog, so
 * a footer `Close`/`Done` was a row of chrome holding the ONE primary slot — and
 * holding it beside the Retry it destroyed, which is how the owner missed the
 * retry entirely. The primary slot now belongs to Retry, in the body, naming
 * the prompt. Two consequences the code has to honour and does:
 *
 *  · the error that lived in the footer's span renders in the BODY, under
 *    whatever stage produced it ({@link SignInDialogBody}'s `bodyError`);
 *  · the retry is read from the SESSION first (`authRequired.retryPrompt`,
 *    ADR-070 §3) and only then from the request, so a dialog opened from the
 *    pill offers it too and closing the dialog cannot destroy it.
 *
 * VISUAL VOCABULARY. `SettingRow` / `SheetGroup` / `Button` from the settings
 * dialog, so an account row here reads as the same object as an account row in
 * Settings, and `EngineChip` from the provider sheet for the header's "which
 * engines this credential feeds". `SheetFrame` itself does NOT fit: its geometry
 * mirrors the settings dialog's box in order to pin itself to that box's right
 * edge, and this dialog opens over the chat.
 */

import { useCallback, useEffect, useState } from 'react'
import { useShallow } from 'zustand/react/shallow'
import {
  useSessionStore,
  type SignInProviderId,
  type SignInProviderRequest,
  type SignInRequest
} from '../../stores/session-store'
import { AUTH_ISSUE_NAME } from '../../stores/auth-issues'
import type { AuthIssue, AuthRetry } from '../../stores/auth-issues'
import { useAuthSummary } from '../../stores/use-auth-summary'
import {
  SIGN_IN_PROVIDER_LABEL,
  isDrivableProvider,
  providerDisplayName
} from '../../utils/sign-in-provider'
import type { EngineId } from '../../../../shared/types'
import { engineMeta } from '../../../../shared/engine-meta'
import { useIsMobile } from '../../hooks/useIsMobile'
import { useEscapeLayer } from '../shared/use-escape-layer'
import { SettingRow, Button } from '../SettingsDialog/settings-controls'
import { SheetGroup } from '../SettingsDialog/SheetFrame'
import { EngineChip } from '../SettingsDialog/ProviderSheet'
import { openProviderSettings } from '../chat/AuthPill'
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

/**
 * The header's provider mark. One glyph each rather than a vendor logo: the
 * app ships no brand assets, and a coloured initial is enough to tell two
 * dialogs apart at a glance.
 */
const PROVIDER_MARK: Record<SignInProviderId, string> = { anthropic: 'C', chatgpt: 'G' }

const message = (e: unknown): string => (e instanceof Error ? e.message : String(e))

/**
 * One engine a credential feeds, and WHEN a new token reaches it.
 *
 * The header renders the set (rule 1: which engines a credential feeds is a
 * set, so render a set) and the done state renders the same set with its
 * effects (rule 5: three parallel sentences become one row of chips). ONE
 * derivation for both — the header and the done state cannot answer the
 * question differently.
 */
interface EngineFeed {
  engineId: EngineId
  /** Overrides `engineMeta().label`; see {@link ANTHROPIC_FEEDS}. */
  label?: string
  /** Absent = the new token is in use already. */
  effect?: string
}

/**
 * Anthropic feeds Claude Code and nothing else, and it feeds it on the NEXT
 * session: a running cli.js caches its OAuth token for the life of the process,
 * which is exactly why `retrySend` respawns rather than re-prompting.
 *
 * "Claude Code" rather than `engineMeta('claude').label` ("Claude") because the
 * title beside it already says Claude; the chip names the product the
 * credential feeds.
 */
const ANTHROPIC_FEEDS: readonly EngineFeed[] = [
  { engineId: 'claude', label: 'Claude Code', effect: 'next session' }
]

const feedLabel = (feed: EngineFeed): string => feed.label ?? engineMeta(feed.engineId).label

/** One stored account, flattened out of the two providers' different shapes. */
interface AccountRow {
  id: string
  label: string
  /** The subscription tier, as a neutral chip. */
  plan?: string
  /** The vault gave up on this credential — a danger chip, not prose. */
  expired?: boolean
  active: boolean
}

/**
 * `confirm` is the screen a one-click sign-in used to skip (ADR-070 Ruling 1,
 * owner 2026-09-19).
 *
 * Every path that has nothing to CHOOSE — Anthropic with multi-account off, a
 * provider with no stored account, `mode: 'add'` — used to run the flow from
 * the open-time effect, so opening the dialog was itself `shell.openExternal`.
 * ADR-068 §3 was right that a chooser of one is ceremony, but the screen it
 * deleted was also the confirmation, and the pill that replaced the dismissible
 * banner is permanently on screen. So the flow now starts on a click on THIS
 * screen and nowhere earlier.
 */
type Stage = 'choose' | 'confirm' | 'flow' | 'done'

/** The two ChatGPT flows a WEB client can run — see `chatgptFlow` below. */
type ChatgptFlowKind = 'device' | 'paste'

/**
 * A fact chip: the plan (neutral) or a dead credential (danger).
 *
 * `SettingRow`'s own badge vocabulary is fixed (engine / locked / appliesOn) and
 * `CredentialChip`'s value set is the provider registry's, so neither can say
 * "Plus" or "expired". Same geometry as `CredentialChip` on purpose — a chip
 * here has to read as the same object as a chip in Settings.
 */
function StateChip({
  text,
  tone,
  testid
}: {
  text: string
  tone: 'neutral' | 'danger'
  testid: string
}): React.JSX.Element {
  return (
    <span
      data-testid={testid}
      className={`shrink-0 rounded-full px-[7px] text-[10.5px] leading-4 font-medium ${
        tone === 'danger'
          ? 'border border-danger/40 text-danger'
          : 'border border-border text-text-secondary'
      }`}
    >
      {text}
    </span>
  )
}

/**
 * The bordered accent row that owns the screen's ONE primary action (rule 6).
 *
 * Shared by the done state (an immediate `Retry`) and the provider list (a
 * `Retry after sign-in`, inert until a resolution makes it takeable), because
 * they are the same offer at two moments and a second row style would let the
 * two drift.
 */
function RetryRow({
  count,
  prompt,
  action,
  disabled,
  onRetry
}: {
  count: number
  prompt: string
  action: string
  disabled?: boolean
  onRetry: () => void
}): React.JSX.Element {
  return (
    <div
      data-testid={`${DIALOG}.retryRow`}
      className="rounded-lg border border-accent/40 bg-accent/5 px-3 py-2.5 flex items-center gap-3"
    >
      <span className="flex-1 min-w-0">
        <span className="block text-[12px] text-text-primary">
          {count === 1 ? '1 prompt was stopped' : `${count} prompts were stopped`}
        </span>
        <span className="block text-[11px] text-text-muted truncate">“{prompt}”</span>
      </span>
      <Button variant="primary" testid={`${DIALOG}.retry`} disabled={disabled} onClick={onRetry}>
        {action}
      </Button>
    </div>
  )
}

/**
 * The shell every mode shares: scrim, panel, header row, scrolling body.
 *
 * `×` / the scrim / Escape are the three closes, and there is no fourth — see
 * the module header on the deleted footer. The header is `min-h`, not a fixed
 * 52px, so the engine chips WRAP on a phone instead of overflowing the row.
 */
function DialogFrame({
  dataId,
  heading,
  onClose,
  children
}: {
  dataId?: string
  heading: React.ReactNode
  onClose: () => void
  children: React.ReactNode
}): React.JSX.Element {
  const isMobile = useIsMobile()
  useEscapeLayer(onClose)

  return (
    <div
      data-testid={DIALOG}
      {...(dataId ? { 'data-id': dataId } : {})}
      className="fixed inset-0 z-[100] flex"
    >
      <span
        data-testid={`${DIALOG}.scrim`}
        onClick={onClose}
        className="absolute inset-0 bg-black/40 backdrop-blur-sm"
      />
      <div
        className={
          isMobile
            ? 'relative z-10 w-full h-full flex flex-col bg-bg-primary animate-fade-in'
            : 'relative z-10 m-auto w-[460px] max-w-[92vw] max-h-[88vh] flex flex-col bg-bg-primary border border-border rounded-xl shadow-2xl animate-fade-in'
        }
      >
        <div className="min-h-[52px] shrink-0 flex items-center flex-wrap gap-2 px-4 py-2 border-b border-border">
          {heading}
          <button
            type="button"
            data-testid={`${DIALOG}.close`}
            title="Close"
            onClick={onClose}
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

        <div className="flex-1 min-h-0 overflow-y-auto px-4 py-4">{children}</div>
      </div>
    </div>
  )
}

/**
 * Remounted on every open, so no stage, error or account list survives from the
 * previous one — a dialog that reopened on a stale "done" is the failure this
 * key removes without a reset effect that has to enumerate the state. The list
 * mode has one request and therefore one key.
 */
const requestKey = (request: SignInRequest): string =>
  request.kind === 'list' ? 'list' : `${request.providerId}:${request.mode}`

export function SignInDialog(): React.JSX.Element | null {
  const request = useSessionStore((s) => s.signInDialog)
  if (!request) return null
  if (request.kind === 'list') return <SignInIssueList key={requestKey(request)} />
  return <SignInDialogBody key={requestKey(request)} request={request} />
}

function SignInDialogBody({ request }: { request: SignInProviderRequest }): React.JSX.Element {
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
    retrySend,
    clearAuthRequired
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
      retrySend: s.retrySend,
      clearAuthRequired: s.clearAuthRequired
    }))
  )

  const { providerId } = request
  const isWeb = window.api.platform === 'web'

  const [stage, setStage] = useState<Stage>('choose')
  /**
   * Which ChatGPT flow the web client is on (Slice 7). Device code is the
   * DEFAULT — "open this link, type this code" is the step a phone can finish —
   * and "Paste a URL instead" drops to ADR-057's panel for a server with device
   * code turned off. Ignored on desktop and for Anthropic.
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
  /** Anthropic's is a constant; ChatGPT's is read off the shared-provider routes. */
  const [feeds, setFeeds] = useState<readonly EngineFeed[]>(() =>
    providerId === 'anthropic' ? ANTHROPIC_FEEDS : []
  )

  /**
   * The stopped prompt this dialog can offer to re-send, session FIRST
   * (ADR-070 §3) and the request's own copy only as a fallback.
   *
   * The order is the three lifetimes, newest first. `summary.retryable` is
   * lifetime 2 — resolved, retry owed — and it is STABLE by construction: the
   * reducer keeps `resolved: true` plus `retryPrompt` on the session until a
   * turn runs again or the retry is taken, and `provider:auth-resolved` is
   * exactly what drops the provider out of `issues` while leaving that entry
   * standing. So the done state, which renders after the resolution, reads the
   * answer off live state with no latch and no render-time mutation.
   */
  const summary = useAuthSummary()
  const owed = summary.issues.find((issue) => issue.providerId === providerId)
  const retry: AuthRetry | undefined =
    summary.retryable.find((candidate) => candidate.providerId === providerId) ??
    owed?.retry ??
    request.retry

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
    /** Whether "+ Add account" is offered. False for Anthropic with
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
        plan: account.subscriptionType ?? undefined,
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
      // Two facts, two chips (rule: no sentence that restates its own state).
      // `Plus · sign-in expired` was one string and the danger half of it read
      // as a footnote.
      plan: account.planType ?? undefined,
      expired: account.needsReauth === true,
      active: account.id === list.activeId
    }))
    return { rows, autoStart: rows.length === 0, canAdd: true }
  }, [providerId, setAccountsState])

  /**
   * Which engines the ChatGPT credential feeds, and when.
   *
   * Codex is not a ROUTE on the definition — ADR-068 §1 feeds it by injection
   * from the same vault account, and 2a's refresh path makes a live re-inject
   * lazy — so it is listed unconditionally rather than read off a flag that
   * does not exist, and it says "next request" rather than claiming more.
   */
  const readChatgptFeeds = useCallback(async (): Promise<EngineFeed[]> => {
    const definitions = await window.api.listSharedProviders()
    const definition = definitions.find((entry) => entry.id === CHATGPT_ID)
    const list: EngineFeed[] = []
    if (definition?.routes.pi.enabled) list.push({ engineId: 'pi' })
    if (definition?.routes.opencode.enabled)
      list.push({ engineId: 'opencode', effect: 'next start' })
    list.push({ engineId: 'codex', effect: 'next request' })
    return list
  }, [])

  /** Who the credential belongs to, read AFTER it was written. */
  const collectOutcome = useCallback(async (): Promise<void> => {
    if (providerId === 'anthropic') {
      const account = useSessionStore.getState().authState?.account
      setSignedInAs(account?.email ?? null)
      setPlan(account?.subscriptionType ?? null)
      return
    }
    const list = await window.api.listProviderAccounts(CHATGPT_ID).catch(() => null)
    const active = list?.accounts.find((account) => account.id === list.activeId)
    setSignedInAs(active?.email ?? null)
    setPlan(active?.planType ?? null)
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
   * Start the flow when the chooser has nothing to offer — the confirm screen's
   * primary, and the one button an EMPTY chooser shows. One helper rather than
   * two copies of the condition, because the two modes are different calls for
   * Anthropic: `add` goes through `addAccount()` (a SECOND credential),
   * `reauth` through `signIn()`, and an empty list has nothing to add
   * alongside.
   */
  const startWithoutChoosing = useCallback(
    (): Promise<void> => start(request.mode === 'add' ? 'add' : 'reauth'),
    [start, request.mode]
  )

  // Open: read the accounts, then decide whether there is anything to choose
  // between. `add` never has anything to choose; neither does a provider with no
  // stored account (or Anthropic with multi-account off), so both go straight to
  // the flow. The header's engine chips are read here too — one read per open,
  // and the SAME one the done state's fan-out renders.
  useEffect(() => {
    let cancelled = false
    void readAccounts()
      .then(({ rows, autoStart, canAdd }) => {
        if (cancelled) return
        setAccounts(rows)
        setCanAdd(canAdd)
        // Ruling 1: the confirm SCREEN, never the flow. `add` is not exempt —
        // "Add another account" says what the dialog is for, not that a
        // browser is about to take the screen, and one rule with no exception
        // is the only version of this that stays true.
        if (request.mode === 'add' || autoStart) setStage('confirm')
      })
      .catch((e: unknown) => {
        if (cancelled) return
        setAccounts([])
        setError(message(e))
      })
    if (providerId === 'chatgpt')
      // A failed route read costs the header its chips and nothing else, so it
      // is deliberately NOT an error row: the sign-in still works.
      void readChatgptFeeds()
        .then((list) => {
          if (!cancelled) setFeeds(list)
        })
        .catch(() => {})
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
    if (!retry) return
    const { routingId, prompt } = retry
    closeSignIn()
    void retrySend(routingId, prompt)
    // Performing the retry IS lifetime 3 (ADR-070 §2) — the same pair the pill
    // and the transcript row run, so the session settles from whichever surface
    // the user reached for rather than waiting out the respawn.
    clearAuthRequired(routingId)
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
    // Rule 3: a spinner labelled "Waiting for the browser…" does not also need
    // "Finish the sign-in in the browser window we opened. It completes on its
    // own." The spinner says it is waiting; the label says what for.
    <div data-testid={`${DIALOG}.waiting`} className="space-y-3">
      <div className="flex items-center gap-3">
        <span className="w-3 h-3 shrink-0 rounded-full border-2 border-accent border-t-transparent animate-spin-slow" />
        <span className="flex-1 text-[13px] text-text-primary">Waiting for the browser…</span>
      </div>
      <div className="flex items-center gap-3">
        {flowUrl && (
          <Button
            variant="link"
            testid={`${DIALOG}.manualLink`}
            onClick={() => window.open(flowUrl, '_blank', 'noopener,noreferrer')}
          >
            Open the link ↗
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

  /**
   * What the confirm screen's one primary button PROMISES, per host.
   *
   * ADR-057: the host never `openExternal`s for a remote caller, so a web
   * client must not be told a browser is about to open — nothing opens; the
   * host hands back a link to copy, or a device code to type. Naming the wrong
   * one is the same defect as the missing screen, one step further along.
   */
  const confirmAction = !isWeb
    ? 'Open browser'
    : providerId === 'chatgpt' && chatgptFlow === 'device'
      ? 'Get a code'
      : 'Get a sign-in link'

  /**
   * The credential the confirm screen NAMES, when it knows one.
   *
   * Only the single-row case: `readAccounts` collapses Anthropic-with-
   * multi-account-off to exactly the credential the flow will re-authorise, so
   * naming it is the difference between "sign in" and "sign in as this". An
   * `add` names nobody by construction — that is the point of adding — and a
   * host with no stored account has nobody to name.
   */
  const confirmAccount = request.mode === 'add' ? null : accounts?.length === 1 ? accounts[0] : null

  const body =
    stage === 'confirm' ? (
      <SheetGroup
        testid={`${DIALOG}.group`}
        id="confirm"
        label={request.mode === 'add' ? 'Add account' : 'Sign in'}
      >
        {/* One row, one primary (rule 6), and no sentence: the header names the
            provider, the row names the account, and the button names what
            happens next. There is deliberately no Cancel — `×`, the scrim and
            Escape are the three closes this dialog has, and a screen that has
            started nothing has nothing to cancel. */}
        <SettingRow
          testid={`${DIALOG}.confirm`}
          {...(confirmAccount ? { label: confirmAccount.label, dataId: confirmAccount.id } : {})}
          leading={
            <span
              data-testid={`${DIALOG}.activeDot`}
              data-active={confirmAccount ? 'true' : 'false'}
              className={`shrink-0 w-1.5 h-1.5 rounded-full ${confirmAccount ? 'bg-accent' : ''}`}
            />
          }
          labelBadge={
            confirmAccount?.plan ? (
              <StateChip text={confirmAccount.plan} tone="neutral" testid={`${DIALOG}.plan`} />
            ) : undefined
          }
        >
          <Button
            variant="primary"
            testid={`${DIALOG}.confirmStart`}
            disabled={busy}
            onClick={() => void startWithoutChoosing()}
          >
            {confirmAction}
          </Button>
        </SettingRow>
      </SheetGroup>
    ) : stage === 'done' ? (
      <div data-testid={`${DIALOG}.done`} className="space-y-3">
        <div className="flex items-center gap-2.5">
          <span className="text-success text-[14px]" aria-hidden="true">
            ✓
          </span>
          <span
            data-testid={`${DIALOG}.signedIn`}
            className="flex-1 min-w-0 text-[13px] text-text-primary truncate"
          >
            {signedInAs ?? 'Signed in'}
          </span>
          {plan && <StateChip text={plan} tone="neutral" testid={`${DIALOG}.plan`} />}
        </div>
        {feeds.length > 0 && (
          <div className="rounded-lg border border-border px-3 py-2.5 flex items-center flex-wrap gap-x-4 gap-y-1.5 text-[11px]">
            {feeds.map((feed) => (
              <span
                key={feed.engineId}
                data-testid={`${DIALOG}.fanOut`}
                data-id={feed.engineId}
                className="flex items-center gap-1.5"
              >
                <span
                  className={feed.effect ? 'text-text-secondary' : 'text-success'}
                  aria-hidden="true"
                >
                  {feed.effect ? '↻' : '✓'}
                </span>
                <span className="text-text-secondary">{feedLabel(feed)}</span>
                {feed.effect && <span className="text-text-muted">{feed.effect}</span>}
              </span>
            ))}
          </div>
        )}
        {retry && <RetryRow count={1} prompt={retry.prompt} action="Retry" onRetry={retryPrompt} />}
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
            // The active account is a DOT, not a tinted band with a word for it.
            // The inactive rows keep the same gutter so the labels line up.
            leading={
              <span
                data-testid={`${DIALOG}.activeDot`}
                data-active={account.active ? 'true' : 'false'}
                className={`shrink-0 w-1.5 h-1.5 rounded-full ${account.active ? 'bg-accent' : ''}`}
              />
            }
            labelBadge={
              <>
                {account.plan && (
                  <StateChip text={account.plan} tone="neutral" testid={`${DIALOG}.plan`} />
                )}
                {account.expired && (
                  <StateChip text="expired" tone="danger" testid={`${DIALOG}.expired`} />
                )}
              </>
            }
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
          // Rule 2: no sentence that restates its own button. All three
          // descriptions this row used to carry ("Signs in to another ChatGPT
          // account and adds it to the list") said what the button says.
          <SettingRow testid={`${DIALOG}.addRow`}>
            <Button
              variant="link"
              testid={`${DIALOG}.addAccount`}
              disabled={busy}
              // With nothing on the list this is the SAME start the dialog would
              // have run on open — `add` would send Anthropic through
              // `addAccount()`, which adds a second credential to a host that has
              // none.
              onClick={() => void (isEmptyList ? startWithoutChoosing() : start('add'))}
            >
              {isEmptyList ? 'Sign in' : '+ Add account'}
            </Button>
          </SettingRow>
        )}
      </SheetGroup>
    )

  /**
   * The error the deleted footer used to hold, now in the body.
   *
   * Rendered under every stage rather than duplicated per stage, and suppressed
   * ONLY when the flow's outcome notice is on screen saying the same words: the
   * device-code start parks its message on `vendorOAuth` AND returns it, so the
   * two would otherwise print the same failure twice.
   *
   * The stage is part of the condition, not just the string, because that notice
   * renders in the `flow` stage alone while `vendorOAuth` / `authState` keep
   * their error across a stage change. Matching on the text by itself would let
   * a `choose`-stage error be suppressed by a notice nobody can see — and an
   * error that silently disappears is worse than the footer this replaces.
   */
  const bodyError = error && !(stage === 'flow' && error === flowError) ? error : null

  return (
    <DialogFrame
      dataId={providerId}
      onClose={closeSignIn}
      heading={
        <>
          <span
            data-testid={`${DIALOG}.mark`}
            aria-hidden="true"
            className="shrink-0 w-5 h-5 rounded-full bg-bg-tertiary flex items-center justify-center text-[10px] font-semibold text-text-secondary"
          >
            {PROVIDER_MARK[providerId]}
          </span>
          <span className="text-[15px] font-semibold text-text-primary truncate">
            {PROVIDER_NAME[providerId]}
          </span>
          {feeds.map((feed) => (
            <EngineChip
              key={feed.engineId}
              engine={feed.engineId}
              enabled
              label={feed.label}
              testid={`${DIALOG}.engineChip`}
            />
          ))}
        </>
      }
    >
      <div className="space-y-3">
        {body}
        {bodyError && (
          <div
            data-testid={`${DIALOG}.error`}
            className="rounded-lg border border-danger/25 bg-danger/5 px-3 py-2 text-[11px] leading-relaxed text-danger"
          >
            {bodyError}
          </div>
        )}
      </div>
    </DialogFrame>
  )
}

/**
 * Provider-LIST mode (ADR-070 §5): the pill aggregates, so when several
 * credentials are down it has no single flow to open and hands the dialog the
 * whole set instead.
 *
 * Every row is live off `useAuthSummary` — the same answer the pill reads, so
 * the list cannot disagree with the indicator that opened it, and a provider
 * that resolves leaves the list on its own.
 */
function SignInIssueList(): React.JSX.Element {
  const closeSignIn = useSessionStore((s) => s.closeSignIn)
  const openSignIn = useSessionStore((s) => s.openSignIn)
  const retrySend = useSessionStore((s) => s.retrySend)
  const clearAuthRequired = useSessionStore((s) => s.clearAuthRequired)
  const summary = useAuthSummary()

  /** Switch this dialog into that provider's ordinary flow — one request replaces another. */
  const signIn = (issue: AuthIssue): void => {
    if (!isDrivableProvider(issue.providerId)) return openProviderSettings()
    openSignIn({
      providerId: issue.providerId,
      mode: 'reauth',
      ...(issue.accountId ? { accountId: issue.accountId } : {}),
      ...(issue.retry ? { retry: issue.retry } : {})
    })
  }

  /**
   * Every prompt an auth failure stopped: the ones still blocked (no credential
   * yet) and the ones a resolution has already unblocked. Only the second kind
   * can actually be sent, which is what disables the button.
   */
  const stopped: AuthRetry[] = [
    ...summary.retryable,
    ...summary.issues.flatMap((issue) => (issue.retry ? [issue.retry] : []))
  ]
  const takeable = summary.retryable[0]

  const retry = (): void => {
    if (!takeable) return
    void retrySend(takeable.routingId, takeable.prompt)
    clearAuthRequired(takeable.routingId)
  }

  return (
    <DialogFrame
      onClose={closeSignIn}
      heading={<span className="text-[15px] font-semibold text-text-primary">Sign-ins</span>}
    >
      <div className="space-y-3">
        {/* Everything resolved while the list was open — another client signed
            in, most likely. An empty bordered box would read as a failed read,
            and ADR-070's settled state has no action, so it says so and offers
            nothing. */}
        {summary.issues.length === 0 && stopped.length === 0 && (
          <SettingRow testid={`${DIALOG}.settled`} description="Nothing needs a sign-in." />
        )}
        {summary.issues.length > 0 && (
          <SheetGroup testid={`${DIALOG}.group`} id="issues" label="Providers">
            {summary.issues.map((issue) => (
              <SettingRow
                key={issue.providerId}
                testid={`${DIALOG}.issue`}
                dataId={issue.providerId}
                label={providerDisplayName(issue.providerId)}
                labelBadge={
                  <>
                    <StateChip
                      // The state's one name (ADR-070 §4) — this row said "not
                      // signed in" for the state the pill above it was calling
                      // "Sign-in needed".
                      text={AUTH_ISSUE_NAME[issue.kind]}
                      tone={issue.kind === 'expired' ? 'danger' : 'neutral'}
                      testid={`${DIALOG}.issueState`}
                    />
                    {issue.blocks.map((label) => (
                      <StateChip
                        key={label}
                        text={label}
                        tone="neutral"
                        testid={`${DIALOG}.issueBlocks`}
                      />
                    ))}
                  </>
                }
              >
                <Button
                  variant={issue.drivable ? 'primary' : 'tinted'}
                  testid={`${DIALOG}.issueSignIn`}
                  dataId={issue.providerId}
                  onClick={() => signIn(issue)}
                >
                  {/* ADR-030: an engine-native credential has no flow here, so
                      the row offers the page that can fix it — the same answer
                      the pill and the transcript row give. */}
                  {issue.drivable ? 'Sign in' : 'Settings'}
                </Button>
              </SettingRow>
            ))}
          </SheetGroup>
        )}
        {stopped.length > 0 && stopped[0] && (
          <RetryRow
            count={stopped.length}
            prompt={(takeable ?? stopped[0]).prompt}
            action="Retry after sign-in"
            disabled={!takeable}
            onRetry={retry}
          />
        )}
      </div>
    </DialogFrame>
  )
}
