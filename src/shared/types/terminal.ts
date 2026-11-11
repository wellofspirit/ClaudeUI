import type { RemoteKdfParams } from '../remote-protocol'

/**
 * What `terminal:attach` answers with (ADR-060).
 *
 * `{ ok: false }` is "that terminal is gone" — a stale tab — and is the only
 * refusal; a gate refusal throws instead. The geometry is the pty's CURRENT
 * grid, which a mirroring surface adopts as its own cols.
 */
export type TerminalAttachResult = { ok: true; cols: number; rows: number } | { ok: false }

/**
 * What the terminal affordance may do on THIS client right now
 * (`terminal:availability`).
 *
 * - `allowed`     — the host permits a terminal for this connection at all
 *                   (always true on desktop; the opt-in toggle over remote);
 * - `granted`     — a live `shell` grant is held, so commands will run;
 * - `needsStepUp` — allowed but not granted: run the step-up ceremony;
 * - `readsAllowed`— this connection may WATCH terminals (ADR-054's read/act
 *                   split): attach, stream, resize, list the pool;
 * - `stepUp`      — the public params to derive the ceremony's proof from, or
 *                   null when no credential exists (so no factor exists either).
 */
export interface TerminalAvailability {
  allowed: boolean
  granted: boolean
  needsStepUp: boolean
  /**
   * May this client WATCH terminals right now (ADR-054 decision 4)?
   *
   * `granted` answers "may I ACT" and kept that ADR-052 meaning, because that is
   * what the affordance asks. The split made a THIRD state real: a connection
   * that armed once (so scrollback is unlocked for the socket's lifetime) but
   * whose act window has since decayed may keep an attached view streaming while
   * every keystroke is refused. Without this field a client can only see
   * `granted: false` and would wall off a terminal it is perfectly entitled to
   * watch.
   *
   * Optional so an older host — which had no such state — simply reads as
   * "reads follow acts", the pre-ADR-054 behavior.
   */
  readsAllowed?: boolean
  stepUp: TerminalStepUpParams | null
  /**
   * Can THIS client run a passkey step-up ceremony (ADR-052 decision 5)?
   *
   * Filled in by the WEB transport, not by the host: whether a ceremony is
   * possible is a fact about the browser's origin and this socket's auth
   * method, and `terminal:availability` is answered by a service that knows
   * neither. Absent on desktop, where step-up does not exist at all.
   *
   * It only decides which affordance the prompt leads with — the server still
   * refuses a factor it does not accept, and both refusals
   * (`passkey-unavailable` / `passkey-required`) flip the prompt to the other
   * one. Optional so an older host/adapter simply reads as "password only".
   */
  passkey?: boolean
}

/**
 * Public inputs for the step-up proof — the same salt + KDF params
 * `/remote/auth-info` advertises, delivered on this channel instead.
 *
 * Auth-info cannot carry them over the tunnel: that transport refuses password
 * AUTHENTICATION (an E2E session needs the fragment key a password client does
 * not have), so it correctly omits `password` from the advertised methods. A
 * step-up is a different act — an already-authenticated, E2E-active socket
 * proving a human is present — so its params ride the authenticated channel.
 * Both are public by construction (a salt discloses nothing).
 */
export interface TerminalStepUpParams {
  saltHex: string
  kdf: RemoteKdfParams
}

/** Outcome of a step-up ceremony (see `WsStepUpResponse`). */
export interface TerminalStepUpResult {
  ok: boolean
  error?: string
  code?: string
  retryable?: boolean
  expiresAt?: number
  /**
   * Success only, and only when the ceremony carried the `settings` intent: the
   * server-side deadline of the settings-editing session it just opened
   * (ADR-054 §6 amendment). The editor's countdown ticks from this, so the pane
   * and the server cannot disagree about when the mode ends.
   */
  settingsSessionExpiresAt?: number
}

/**
 * What a step-up ceremony is FOR.
 *
 * `'settings'` additionally opens the five-minute settings-editing session on
 * this connection. Absent means an ordinary step-up (presence, and the shell
 * where the toggle allows) — which is what every caller but the settings pane
 * wants.
 */
export type StepUpIntent = 'settings'

// ---------------------------------------------------------------------------
// Terminal types
// ---------------------------------------------------------------------------

export interface TerminalTab {
  id: string
  title: string
  cwd: string
  /**
   * Slot this tab occupies in the cwd's terminal pool. Optional so a tab can be
   * constructed without one (tests, older state); when absent the panel falls
   * back to the tab's position when it needs to pick the next free slot.
   */
  poolIndex?: number
}
