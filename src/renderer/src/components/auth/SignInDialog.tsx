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
 * WHERE THE SCREENS LIVE. Each stage is a module of its own under `./sign-in/`,
 * presentational and given explicit props; the shell they share is
 * {@link ./sign-in/shared}. This file is the state machine and the props it
 * hands out, so there is exactly one owner of `stage`, `busy` and the attempt.
 *
 * AND NO SECOND COPY OF THE ACCOUNTS EITHER (Slice I). The rows are derived
 * from `accountsState` / `providerAccounts` on every change — see
 * {@link ./account-rows}, which carries the story — so an account whose email
 * and plan arrive AFTER the dialog opened renders them. The open-time read
 * stays, but only to make sure the store has been populated at all; its answer
 * goes into the store and is read back from there like everyone else's.
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

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { useShallow } from 'zustand/react/shallow'
import {
  useSessionStore,
  type SignInProviderRequest,
  type SignInRequest
} from '../../stores/session-store'
import type { AuthRetry } from '../../stores/auth-issues'
import { useAuthSummary } from '../../stores/use-auth-summary'
import {
  UNREADABLE_ACCOUNTS,
  anthropicAccountsView,
  chatgptAccountsView,
  type AccountRow,
  type AccountsView
} from './account-rows'
import {
  ANTHROPIC_FEEDS,
  DIALOG,
  DialogFrame,
  ProviderHeading,
  type EngineFeed
} from './sign-in/shared'
import { ChooseStage } from './sign-in/ChooseStage'
import { ConfirmStage } from './sign-in/ConfirmStage'
import { DoneStage } from './sign-in/DoneStage'
import { FlowStage, type FlowPanel } from './sign-in/FlowStage'
import { SignInIssueList } from './sign-in/SignInIssueList'

/** pi's auth.json key for the ChatGPT credential — `CredentialSync.PI_CODEX_VENDOR_ID`. */
const CODEX_VENDOR_ID = 'openai-codex'
/** The shared vault's id for the ChatGPT subscription. */
const CHATGPT_ID = 'chatgpt'

const message = (e: unknown): string => (e instanceof Error ? e.message : String(e))

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
    clearAuthRequired,
    accountsState,
    providerAccounts
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
      clearAuthRequired: s.clearAuthRequired,
      // The accounts THEMSELVES, not a snapshot of them (Slice I). Both are
      // read-back caches of a host list; `accountsState` is kept current by
      // `account:changed`, which is what makes a backfilled email arrive here.
      accountsState: s.accountsState,
      providerAccounts: s.providerAccounts
    }))
  )

  const { providerId } = request
  const isWeb = window.api.platform === 'web'

  /**
   * Null until the accounts are KNOWN: which screen this dialog opens on is a
   * question about them (is there anything to choose between?), and it cannot be
   * answered before the answer exists. It renders as `choose` while undecided,
   * which is the same in-flight chooser the dialog has always shown.
   *
   * Latched once — see the layout effect below — so it is the opening decision
   * and nothing more. Every later change is an explicit `setStage` from an
   * action the user took.
   */
  const [decidedStage, setStage] = useState<Stage | null>(null)
  /**
   * Which ChatGPT flow the web client is on (Slice 7). Device code is the
   * DEFAULT — "open this link, type this code" is the step a phone can finish —
   * and "Paste a URL instead" drops to ADR-057's panel for a server with device
   * code turned off. Ignored on desktop and for Anthropic.
   */
  const [chatgptFlow, setChatgptFlow] = useState<ChatgptFlowKind>('device')
  /** Which mode the live flow was started in, so the paste fallback restarts the same one. */
  const [flowMode, setFlowMode] = useState<'reauth' | 'add'>('reauth')
  /**
   * The open-time read REJECTED and no copy of the answer exists in the store,
   * so there is nothing to derive from and never will be for this open. The one
   * thing the store cannot tell us: it keeps the last good answer rather than
   * recording the failure (both slices' documented posture), so a surface that
   * has to distinguish "still reading" from "settled on nothing" has to
   * remember the rejection itself.
   */
  const [unreadable, setUnreadable] = useState(false)
  const [busy, setBusy] = useState(false)
  /** Which attempt owns `busy` and the screen — see {@link start}. */
  const attemptRef = useRef(0)
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
  /**
   * ONE list, counted and re-sent. The row used to say "1 prompt was stopped"
   * from a hardcoded count while the click re-sent whatever the single `retry`
   * happened to be, so two prompts stopped by one dead credential read as one.
   */
  const unblocked = summary.retryable.filter((candidate) => candidate.providerId === providerId)
  const retries: AuthRetry[] =
    unblocked.length > 0
      ? unblocked
      : owed?.retry
        ? [owed.retry]
        : request.retry
          ? [request.retry]
          : []

  /**
   * The rows this dialog renders — DERIVED, never stored (Slice I).
   *
   * Null means the answer is not known yet, which is the only honest thing to
   * render before it arrives; `UNREADABLE_ACCOUNTS` is a read that settled on
   * nothing. The mapping and the ADR-068 rulings inside it live in
   * {@link ./account-rows} and are unit-tested there, so this component has no
   * mapping logic of its own to drift from the store.
   */
  const view: AccountsView | null = useMemo(() => {
    const stored =
      providerId === 'anthropic'
        ? accountsState && anthropicAccountsView(accountsState)
        : providerAccounts && chatgptAccountsView(providerAccounts)
    if (stored) return stored
    return unreadable ? UNREADABLE_ACCOUNTS : null
  }, [providerId, accountsState, providerAccounts, unreadable])

  /** null while the account read is in flight — the chooser must not flash empty. */
  const accounts: AccountRow[] | null = view ? view.rows : null
  /**
   * FALSE while the answer is unknown. `canAdd` is a fact about the accounts
   * (`anthropicAccountsView` says no with multi-account off), so before they are
   * known there is no honest answer and the row cannot render: offering it
   * anyway put `+ Add account` in front of a single-account Anthropic host,
   * where `addAccount()` silently flips the host to file-based multi-account —
   * a Settings decision — and in front of an empty host, where the button takes
   * `start('add')` instead of the plain sign-in `isEmptyList` would have chosen.
   */
  const canAdd = view?.canAdd ?? false

  /**
   * Populate the store, once per open — and NOT to answer anything locally.
   *
   * Both fields are read-back caches with no boot read of their own on every
   * host, so the dialog cannot assume someone else has already asked. It hands
   * what it gets to the store's own writer and then reads it back from there,
   * like Settings does.
   *
   * ChatGPT is read here rather than through `loadProviderAccounts()` alone
   * because that action SWALLOWS the failure by design (a failed re-read must
   * not blank a list someone is looking at), and this dialog owes the user the
   * error — so it takes the rejection and passes the success on to the one
   * writer of the field.
   */
  const populateAccounts = useCallback(async (): Promise<void> => {
    if (providerId === 'anthropic') {
      setAccountsState(await window.api.getAccounts())
      return
    }
    await loadProviderAccounts(await window.api.listProviderAccounts(CHATGPT_ID))
  }, [providerId, setAccountsState, loadProviderAccounts])

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

  /**
   * Who the credential belongs to, read AFTER it was written.
   *
   * This is also the edge that refreshes the ChatGPT rows, and it has to be:
   * Anthropic's `noteLogin` broadcasts `account:changed` when it backfills the
   * new credential's email and plan, and the vault publishes nothing at all, so
   * without a re-read here one half of the dialog would update itself on a
   * successful sign-in and the other would not.
   *
   * ONE read feeding both — the outcome line and the store — rather than the
   * two round trips this used to make, now that the rows come from the store
   * and the two answers cannot be allowed to differ.
   */
  const collectOutcome = useCallback(async (): Promise<void> => {
    // `|| null`, not `?? null` (ADR-070 Slice J): an empty or whitespace-only
    // email is as absent as a missing one, and `??` let it through as a
    // truthy `''` that beat the outcome line's own `?? 'Signed in'` fallback —
    // a successful sign-in rendering as a bare tick with nothing beside it.
    if (providerId === 'anthropic') {
      const account = useSessionStore.getState().authState?.account
      setSignedInAs(account?.email?.trim() || null)
      setPlan(account?.subscriptionType ?? null)
      return
    }
    const list = await window.api.listProviderAccounts(CHATGPT_ID).catch(() => null)
    const active = list?.accounts.find((account) => account.id === list.activeId)
    setSignedInAs(active?.email?.trim() || null)
    setPlan(active?.planType ?? null)
    if (list) void loadProviderAccounts(list)
  }, [providerId, loadProviderAccounts])

  const finish = useCallback(async (): Promise<void> => {
    await collectOutcome()
    setStage('done')
  }, [collectOutcome])

  const start = useCallback(
    async (mode: 'reauth' | 'add', flowKind?: ChatgptFlowKind): Promise<void> => {
      // One attempt owns the screen at a time. `start` holds `busy` across an
      // await that can last a whole device-code poll, and the paste fallback
      // starts a second flow from inside that wait — so an abandoned attempt
      // reaching its `finally` would unlock the panel of the one that replaced
      // it, and its late error would land on a flow nobody is on.
      const attempt = ++attemptRef.current
      const current = (): boolean => attemptRef.current === attempt
      setError(null)
      setBusy(true)
      setStage('flow')
      setFlowMode(mode)
      try {
        if (providerId === 'anthropic') {
          // THIS attempt's state, before the first await. `signIn()` writes
          // `authorizing` synchronously and so was already safe; `addAccount()`
          // awaits with the PREVIOUS login's `success` still standing, and the
          // success effect below fires on it — a fresh dialog jumping straight
          // to "done" for a credential it never touched. Nothing resets
          // `authState` on open, so the reset belongs here, to both arms.
          setAuthState({ status: 'authorizing', account: null, error: null })
          if (mode === 'add') {
            const next = await window.api.addAccount()
            if (!current()) return
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
          if (!current()) return
          if (device.ok) await finish()
          else if (device.error) setError(device.error)
          return
        }
        const result = await authorizeVendorOAuth('pi', CODEX_VENDOR_ID)
        if (!current()) return
        // Desktop resolves ok once the loopback completed; web parks the store's
        // flow at `paste` (or `error`) and the panel below takes over.
        if (result.ok) await finish()
        else if (result.error) setError(result.error)
      } catch (e) {
        if (!current()) return
        // The `authorizing` written above is this attempt's own, so a throw has
        // to take it back: the pill reads it as "Signing in…", and with the
        // dialog on the chooser again nothing else ever would.
        if (providerId === 'anthropic') setAuthState({ status: 'idle', account: null, error: null })
        setError(message(e))
        setStage('choose')
      } finally {
        if (current()) setBusy(false)
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

  // Open: make sure the accounts have been read. WHICH screen that lands on is
  // decided from the store by the layout effect below, not here — the stage and
  // the rows must answer to the same copy of the accounts, and deciding it here
  // would mean deciding it from a value other than the one being rendered,
  // which is the two-copies defect this slice removes, in miniature.
  //
  // The header's engine chips are read here too — one read per open, and the
  // SAME one the done state's fan-out renders.
  useEffect(() => {
    let cancelled = false
    void populateAccounts().catch((e: unknown) => {
      if (cancelled) return
      setUnreadable(true)
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

  /**
   * The opening screen, decided the FIRST moment the accounts are known and
   * never again.
   *
   * Ruling 1: the confirm SCREEN, never the flow. `add` is not exempt — "Add
   * another account" says what the dialog is for, not that a browser is about to
   * take the screen, and one rule with no exception is the only version of this
   * that stays true.
   *
   * A LAYOUT effect, so a store that already holds the accounts (Settings read
   * them, or `account:changed` landed) decides before the first paint instead of
   * showing a chooser for one frame and then replacing it.
   *
   * Latched rather than derived: after this the screen belongs to the user. An
   * account appearing on the list must not pull the confirm screen out from
   * under a click, and `switchAccount` / `addAccount` both write the very field
   * this reads.
   */
  useLayoutEffect(() => {
    if (decidedStage !== null || !view) return
    setStage(request.mode === 'add' || view.autoStart ? 'confirm' : 'choose')
  }, [decidedStage, view, request.mode])

  /** What the body renders. `choose` while the accounts are still unknown. */
  const stage: Stage = decidedStage ?? 'choose'

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
    else void cancelVendorOAuth()
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
    if (retries.length === 0) return
    closeSignIn()
    for (const { routingId, prompt } of retries) {
      void retrySend(routingId, prompt)
      // Performing the retry IS lifetime 3 (ADR-070 §2) — the same pair the pill
      // and the transcript row run, so the session settles from whichever surface
      // the user reached for rather than waiting out the respawn.
      clearAuthRequired(routingId)
    }
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
   * progress"), then restarts in the SAME mode the user chose. "First" is
   * AWAITED: the cancel is an invoke of its own, and a start that overtook it
   * was the refusal this exists to avoid. `busy` spans the gap so the paste
   * panel cannot be acted on before its flow exists.
   */
  const pasteInstead = (): void => {
    setChatgptFlow('paste')
    setBusy(true)
    void cancelVendorOAuth().then(() => start(flowMode, 'paste'))
  }

  /** The live device-code flow, when that is what is running (web + ChatGPT only). */
  const deviceState =
    isWeb && providerId === 'chatgpt' && vendorOAuth?.stage === 'device-code'
      ? vendorOAuth
      : undefined
  const onDeviceFlow = isWeb && providerId === 'chatgpt' && chatgptFlow === 'device'
  /** Which panel a start lands on — ADR-057 derives it, the user never picks it. */
  const panel: FlowPanel = onDeviceFlow ? 'device' : isWeb ? 'paste' : 'browser'

  // ── Body ─────────────────────────────────────────────────────────────────
  const renderStage = (): React.JSX.Element => {
    switch (stage) {
      case 'confirm':
        return (
          <ConfirmStage
            providerId={providerId}
            mode={request.mode}
            accounts={accounts}
            isWeb={isWeb}
            deviceFlow={onDeviceFlow}
            busy={busy}
            onStart={() => void startWithoutChoosing()}
          />
        )
      case 'done':
        return (
          <DoneStage
            signedInAs={signedInAs}
            plan={plan}
            feeds={feeds}
            retries={retries}
            onRetry={retryPrompt}
          />
        )
      case 'flow':
        return (
          <FlowStage
            providerId={providerId}
            panel={panel}
            device={deviceState}
            url={flowUrl}
            error={flowError}
            busy={busy}
            submitting={submitting}
            onSubmit={submitPaste}
            onCancel={cancelFlow}
            onPasteInstead={pasteInstead}
            onRestart={() => void start(flowMode)}
          />
        )
      case 'choose':
        return (
          <ChooseStage
            providerId={providerId}
            accounts={accounts}
            canAdd={canAdd}
            blamedAccountId={request.accountId}
            busy={busy}
            onReauth={() => void start('reauth')}
            onSwitch={(id) => void switchTo(id)}
            onAdd={() => void start('add')}
            onSignIn={() => void startWithoutChoosing()}
          />
        )
    }
  }

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
      heading={<ProviderHeading providerId={providerId} feeds={feeds} />}
    >
      <div className="space-y-3">
        {renderStage()}
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
