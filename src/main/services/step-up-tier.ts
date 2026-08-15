/**
 * Step-up TIERS — post-login presence freshness (ADR-054 / `docs/adr/adr-054`).
 *
 * ADR-052 conflated two questions in one knob: how a connection gets IN (the
 * login ceremony, `auth-policy.ts`) and how fresh its presence proof must stay
 * AFTERWARDS. This module owns the second axis, and only that one.
 *
 * ## Why everything here is one table
 *
 * The passkeys work shipped a real defect that this file is shaped to prevent:
 * `grantsFor` and `ceremonyRequiredForAuth` were two functions restating one
 * rule, they drifted within a week, and the result was a connection the server
 * accepted and then refused on every invoke. So the read/act verb sets, the
 * dispatch classification, and the per-tier decision live HERE, once, and both
 * the enforcement path (`remote-server.ts` invoke + terminal frames), the
 * service-layer backstop (`terminal-service.ts`) and the tests import the same
 * values. A verb cannot be "read" at the transport and "act" at the service,
 * because there is only one place that says which it is.
 *
 * Everything is a PURE function over an explicit {@link PresenceState}, so the
 * tier × class × state matrix is testable as a table rather than only through a
 * live socket.
 */

import type { StepUpTier, RemoteAuthPolicy } from '../../shared/types'
import type { Capability, CommandConnection, CommandKind } from '../ipc/command-registry'

export type { StepUpTier }

/**
 * Auth-mode `off` FORCES tier `off` (ADR-054 decision 3) — flat, no origin
 * carve-outs.
 *
 * You cannot demand a ceremony from an identity that was never established, and
 * gating a pty while unauthenticated model-mediated execution (auto mode, remote
 * approvals, `git push`) stands wide open is theatre. The `off` banners, typed
 * opt-in, startup warning and audit rows carry that posture instead.
 */
export function resolveStepUpTier(policy: RemoteAuthPolicy, storedTier: StepUpTier): StepUpTier {
  return policy === 'off' ? 'off' : storedTier
}

// ---------------------------------------------------------------------------
// The shell read/act split (ADR-054 decision 4)
// ---------------------------------------------------------------------------

/**
 * Shell verbs that only WATCH — they require one arming proof ever on the
 * connection, and are never gated on the decay window.
 *
 * Deliberately an EXPLICIT VERB SET rather than a derivation from the registry's
 * `kind`: `terminal:attach` / `:detach` are declared `command` so the audit trail
 * carries terminal lifecycle (security.md §Audit requires spawn/attach/detach/
 * exit), yet they are reads in the freshness sense. Deriving the split from
 * `kind` would therefore be wrong in exactly the two cases it matters, and
 * "fix it by relabelling attach as a query" would silently drop it from the
 * audit log.
 *
 * `terminal:resize` is read-class on purpose: it writes SIGWINCH and changes
 * display geometry, but it cannot execute anything. An attached view that is
 * merely being watched (a `logcat` left running) must keep working — including
 * across a window resize — after the act window has decayed.
 */
export const SHELL_READ_VERBS: ReadonlySet<string> = new Set([
  'terminal:attach',
  'terminal:detach',
  'terminal:pool',
  'terminal:resize'
])

/**
 * Shell verbs that ACT: spawning, typing, killing. These demand a presence proof
 * inside the decay window — the keystroke after an idle gap is what prompts.
 *
 * `term-input` frames belong to this class too; they do not appear here because
 * they are transport frames rather than registry channels (see
 * {@link TERM_INPUT_CLASS}).
 */
export const SHELL_ACT_VERBS: ReadonlySet<string> = new Set([
  'terminal:create',
  'terminal:write',
  'terminal:kill',
  'terminal:kill-by-cwd'
])

/**
 * The settings-area namespace (ADR-054 decision 6 — the host anchor).
 *
 * Routine remote-access settings (tier selection, password rotation, auth-mode
 * changes among the NON-off modes) are web-reachable behind a fresh step-up, so
 * a headless deployment is administrable without SSH. They get their own
 * namespace because the structural guard has to survive: no `remote:*` channel
 * is ever registered on the remote transport, and the `off` writer stays in
 * `remote:set-config` where only the host anchor can reach it.
 *
 * These verbs behave STRONG-TIER on every tier — see {@link evaluateStepUp}.
 */
export const AUTHCFG_CHANNELS: ReadonlySet<string> = new Set([
  'authcfg:set-tier',
  'authcfg:set-auth-mode',
  'authcfg:set-password',
  'authcfg:set-retention'
])

/**
 * What a dispatch costs, freshness-wise. The ONE vocabulary the enforcement
 * path and the tests share.
 *
 * - `read`      — any `query`. Free on every tier (ADR-054: reads and the sync
 *                 stream are free even in `strong`).
 * - `shell-read`— a shell verb that only watches: one arming proof ever.
 * - `shell-act` — a shell verb that acts: the 10-minute act window.
 * - `authcfg`   — the settings area: the mutation window, on EVERY tier.
 * - `mutation`  — any other `command`: free below `strong`, the mutation window
 *                 at `strong`.
 */
export type DispatchClass = 'read' | 'shell-read' | 'shell-act' | 'authcfg' | 'mutation'

/** `term-input` is acting — a human at a keyboard is the presence proof itself. */
export const TERM_INPUT_CLASS: DispatchClass = 'shell-act'
/** `term-resize` is the frame twin of `terminal:resize`: display geometry, read-class. */
export const TERM_RESIZE_CLASS: DispatchClass = 'shell-read'

/**
 * Classify one dispatch. The single source both the transport gate and the
 * tests read.
 *
 * FAIL-CLOSED on an unrecognised `shell` channel: a shell verb that is in
 * neither set is treated as ACTING, so the failure mode of forgetting to
 * classify a new terminal channel is "it demands freshness" rather than "it is
 * free forever". `shell-verb-sets-cover-the-registry` pins that nobody has to
 * rely on that fallback in practice.
 */
export function classifyDispatch(args: {
  channel: string
  capability: Capability | undefined
  kind: CommandKind | undefined
}): DispatchClass {
  if (AUTHCFG_CHANNELS.has(args.channel)) return 'authcfg'
  if (args.capability === 'shell') {
    // The explicit set wins over `kind` in BOTH directions: `terminal:attach` is
    // a `command` that reads, `terminal:pool` is a `query` that is still a shell
    // read (an inventory of the operator's live shells stays behind the arming
    // proof — scrollback and slot lists are sensitive).
    if (SHELL_READ_VERBS.has(args.channel)) return 'shell-read'
    return 'shell-act'
  }
  if (args.kind === 'query') return 'read'
  return 'mutation'
}

// ---------------------------------------------------------------------------
// Per-connection presence state
// ---------------------------------------------------------------------------

/** Which window a successful dispatch slides forward. */
export type RefreshTarget = 'shellAct' | 'mutation'

/**
 * Everything the tier decision reads about one connection. Extracted from the
 * `CommandConnection` (see {@link presenceOf}) so the decision itself is a pure
 * function over four scalars.
 */
export interface PresenceState {
  /**
   * This connection never decays and is never gated — the desktop renderer's
   * MessagePort. It IS the host surface, so sudo semantics against it are
   * meaningless. Keyed on the same `shellGrantExpiresAt === undefined` sentinel
   * ADR-052 already used, so there is one exemption test rather than two.
   */
  exempt: boolean
  /**
   * A presence proof has happened on this connection at least once: a passkey
   * login, the enroll→webauthn upgrade, or any successful step-up. NEVER decays
   * — it unlocks terminal READS for the connection's lifetime.
   */
  armedEver: boolean
  /** Deadline of the shell ACT window, or null when nothing is armed. */
  shellActExpiresAt: number | null
  /** Deadline of the non-shell MUTATION window, or null when nothing is armed. */
  mutationExpiresAt: number | null
}

/** Read {@link PresenceState} off a connection. */
export function presenceOf(conn: CommandConnection): PresenceState {
  return {
    exempt: conn.shellGrantExpiresAt === undefined,
    armedEver: conn.armedEver === true,
    shellActExpiresAt: conn.shellGrantExpiresAt ?? null,
    mutationExpiresAt: conn.mutationExpiresAt ?? null
  }
}

/** The tier this connection was admitted under; `medium` when unset. */
export function tierOf(conn: CommandConnection): StepUpTier {
  return conn.stepUpTier ?? 'medium'
}

function fresh(deadline: number | null, now: number): boolean {
  return deadline !== null && deadline > now
}

// ---------------------------------------------------------------------------
// The decision
// ---------------------------------------------------------------------------

export interface StepUpDecision {
  /** False ⇒ the caller answers `needs-step-up`. */
  allow: boolean
  /** Windows to slide forward — only ever non-empty when `allow` is true. */
  refresh: readonly RefreshTarget[]
}

const ALLOW: StepUpDecision = { allow: true, refresh: [] }
const DENY: StepUpDecision = { allow: false, refresh: [] }
const ALLOW_REFRESH_BOTH: StepUpDecision = { allow: true, refresh: ['shellAct', 'mutation'] }
const ALLOW_REFRESH_MUTATION: StepUpDecision = { allow: true, refresh: ['mutation'] }

/**
 * The whole enforcement matrix, in one place.
 *
 * ## Refresh discipline
 *
 * A window is a PRESENCE proof, so only ACTING slides it, and only for a
 * connection that already has a proof:
 *
 *  - ACTING refreshes. A shell act refreshes both windows (acting is acting);
 *    any other mutation refreshes the mutation window.
 *  - READING never refreshes — neither a `query` nor a shell READ. This is the
 *    landed d1c6e4e rule generalised: the terminal panel re-asks
 *    `terminal:pool` on every window focus, so a refreshing read would let a tab
 *    the operator merely left open renew its own grant forever with no shell use
 *    at all. The same argument applies to `terminal:attach` on a reconnect.
 *  - An UNARMED connection refreshes nothing. Refreshes EXTEND a proof; they
 *    never create one. Without this rule a `medium`-tier connection could walk
 *    its mutation window forward with ordinary chat traffic and then walk
 *    straight through the `authcfg` gate, which demands the mutation window on
 *    every tier — an unarmed password connection would have bypassed the
 *    settings step-up by sending messages.
 *  - Tier `off` refreshes nothing either: it gates nothing, so the windows are
 *    meaningless and writing to them would be noise in the state a reviewer
 *    reads.
 */
export function evaluateStepUp(args: {
  tier: StepUpTier
  cls: DispatchClass
  presence: PresenceState
  now?: number
}): StepUpDecision {
  const { tier, cls, presence } = args
  const now = args.now ?? Date.now()
  // The desktop MessagePort: exempt from everything, as before ADR-054.
  if (presence.exempt) return ALLOW

  if (cls === 'read') return ALLOW

  const armed = presence.armedEver

  // THE SETTINGS AREA OUTRANKS THE TIER — including tier `off`.
  //
  // ADR-054 decision 6 says these verbs carry strong-tier freshness "regardless
  // of tier", and decision 3 says tier `off` gates nothing. Read literally the
  // two collide on an explicitly-`off` tier, so the order is decided here, in
  // favour of decision 6: an operator choosing "don't nag me post-login" is
  // choosing it for their chat and their shell, not for the surface that decides
  // who may connect at all. A session that can silently rewrite the auth mode is
  // the one thing tier `off` must not buy.
  //
  // Decision 3's flat waiver is not weakened in SUBSTANCE, because under
  // auth-MODE `off` a connection holds the as-built grant set and never
  // `admin` — so it can never actually administer the settings surface.
  //
  // Note the ORDER precisely, because the obvious statement of this is wrong:
  // the transport runs `assertStepUp` (freshness) BEFORE
  // `dispatcher.handle` (capability), so such a connection meets
  // `needs-step-up` FIRST and only hits `Permission denied` if it goes on to
  // complete a step-up. Both walls hold; the freshness one is simply in front.
  // Pinned end to end in remote-step-up-tiers.test.ts ("auth-mode `off`").
  if (cls === 'authcfg') {
    return armed && fresh(presence.mutationExpiresAt, now) ? ALLOW_REFRESH_MUTATION : DENY
  }

  // Tier `off`: nothing else is gated post-login. The terminal's OTHER two gates
  // are untouched — the desktop `allow_terminal` toggle still applies, because
  // that is capability ARMING (may this server offer a shell at all) and not a
  // freshness claim about the human on the far end.
  if (tier === 'off') return ALLOW

  switch (cls) {
    case 'shell-read':
      // First access ever still costs one arming proof, on every tier that gates
      // anything: scrollback and the operator's live-shell inventory are
      // sensitive, so a connection that has never proved presence cannot even
      // watch. One proof then unlocks reads for the socket's lifetime.
      return armed ? ALLOW : DENY

    case 'shell-act':
      return armed && fresh(presence.shellActExpiresAt, now) ? ALLOW_REFRESH_BOTH : DENY

    case 'mutation':
      // `medium` is today's shipped behavior, named: chat / config / git ride
      // connection auth for the connection's lifetime — no freshness check is
      // reachable, and an UNARMED connection writes no window state at all, so
      // the default tier's dispatch path is byte-identical to ADR-052's.
      // `strong` is the owner's "nothing stays alive forever" posture.
      if (tier !== 'strong') return armed ? ALLOW_REFRESH_MUTATION : ALLOW
      return armed && fresh(presence.mutationExpiresAt, now) ? ALLOW_REFRESH_MUTATION : DENY
  }
}

// ---------------------------------------------------------------------------
// Connection-level convenience predicates (the service-layer backstop)
// ---------------------------------------------------------------------------

/**
 * May this connection WATCH terminals right now? (Arming proof only.)
 *
 * Used by `terminal-service.ts` as the backstop behind the transport gate — the
 * same values, through the same table, so the two layers cannot disagree about
 * a verb.
 */
export function shellReadAllowed(conn: CommandConnection, now = Date.now()): boolean {
  return evaluateStepUp({
    tier: tierOf(conn),
    cls: 'shell-read',
    presence: presenceOf(conn),
    now
  }).allow
}

/** May this connection ACT on terminals right now? (Arming proof + act window.) */
export function shellActAllowed(conn: CommandConnection, now = Date.now()): boolean {
  return evaluateStepUp({
    tier: tierOf(conn),
    cls: 'shell-act',
    presence: presenceOf(conn),
    now
  }).allow
}

/**
 * May this connection reach the settings-area verbs right now? The bodies in
 * `authcfg-commands.ts` assert this themselves so a future transport that
 * forgets the gate still cannot write the auth surface with a stale proof.
 */
export function authcfgAllowed(conn: CommandConnection, now = Date.now()): boolean {
  return evaluateStepUp({
    tier: tierOf(conn),
    cls: 'authcfg',
    presence: presenceOf(conn),
    now
  }).allow
}

// ---------------------------------------------------------------------------
// Window sizing
// ---------------------------------------------------------------------------

/** Clamp a minutes-valued window to something a human could actually use. */
function clampMinutes(raw: number | undefined, fallback: number, max: number): number {
  if (raw === undefined || !Number.isFinite(raw)) return fallback
  return Math.min(Math.max(Math.trunc(raw), 1), max)
}

/**
 * The strong tier's NON-shell mutation window in ms (default 60 min, ≤ 24 h).
 * The shell ACT window keeps its own setting and its own reader
 * (`terminal-service.shellGrantIdleMs`) — they are different windows with
 * different rationales and must stay separately configurable.
 */
export function mutationIdleMs(minutes: number | undefined): number {
  return clampMinutes(minutes, 60, 24 * 60) * 60_000
}

/**
 * Ceiling for the strong tier's session max-age, in hours.
 *
 * One week, and the bound is not cosmetic. A budget is handed to `setTimeout`,
 * whose delay is a SIGNED 32-BIT int: anything above ~24.8 days (2^31-1 ms)
 * silently wraps and Node fires the timer on the NEXT TICK instead. The old
 * 30-day ceiling therefore contained a range — 597 to 720 hours — where a
 * perfectly legal setting cut every strong-tier socket ~1 ms after accept, and
 * the client's own reconnect machinery would have hammered the server forever:
 * a total remote outage produced by a value the validator accepted.
 *
 * A week is far under the wrap point and is a sane upper bound for a setting
 * whose entire purpose is "nothing stays alive forever". {@link MAX_TIMER_MS}
 * belt-guards the arithmetic anyway.
 */
export const MAX_SESSION_MAX_AGE_HOURS = 168

/** Node's `setTimeout` delay ceiling; above it a delay wraps and fires at once. */
export const MAX_TIMER_MS = 2 ** 31 - 1

/**
 * Strong-tier absolute session lifetime in ms (default 4 h, 1 h – 1 week).
 * Unlike the idle windows this one is measured from CONNECT and nothing slides
 * it — that is the point: "nothing stays alive forever".
 */
export function sessionMaxAgeMs(hours: number | undefined): number {
  if (hours === undefined || !Number.isFinite(hours)) return 4 * 3_600_000
  return Math.min(Math.max(Math.trunc(hours), 1), MAX_SESSION_MAX_AGE_HOURS) * 3_600_000
}
