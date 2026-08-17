/**
 * Terminal service — the ONE owner of the PTY manager, shared by both
 * transports (SyncCore phase 2, ADR-052 decision 6).
 *
 * Before phase 2 the pty manager was instantiated inside `terminal.ipc.ts` and
 * reachable only from the desktop renderer. Multi-attach requires a single
 * instance both surfaces address — a desktop-spawned shell must be attachable
 * from the web client and vice versa — so ownership moves here and the two
 * `ipc` modules become thin registrations over this service.
 *
 * What lives here (and not in `pty-manager.ts`): the POLICY — the desktop
 * opt-in toggle, the decaying `shell` grant check, and the audit rows for the
 * terminal lifecycle. The pty manager stays a dumb process/stream owner, and it
 * is also where the per-cwd terminal POOL lives (`cwd#0`, `cwd#1`, …): clients
 * ask for "terminal N of this cwd" and the resolution attach-or-spawn is made
 * here in main, never client-side.
 *
 * Audit records METADATA ONLY (security.md §Audit): spawn/attach/detach/kill
 * are `command`-kind registry dispatches and are audited by the registry
 * itself; `exit` has no dispatch to ride on, so it is appended here from the
 * closure created at spawn time — which is exactly what carries the SPAWNER's
 * identity. PTY bytes and keystrokes never reach any of these rows.
 */

import type { HostWindowHandle } from '../host'
import { PtyManager, type PtyRemoteSink } from './pty-manager'
import { appendAuditLog, getRemoteConfig, DEFAULT_SHELL_GRANT_IDLE_MINUTES } from './db'
import { logger } from './logger'
import { type CommandConnection } from '../ipc/command-registry'
import { shellActAllowed, shellReadAllowed } from './step-up-tier'
import { dbPasswordAuthProvider, type PasswordAuthProvider } from './remote-auth'
import {
  NEEDS_STEP_UP_ERROR,
  TERMINAL_DISABLED_ERROR,
  type TermDetachReason
} from '../../shared/remote-protocol'
import type { TerminalAvailability } from '../../shared/types'

/** The desktop-side posture, read fresh so a Settings flip applies immediately. */
export interface TerminalPolicy {
  allowTerminal: boolean
  shellGrantIdleMinutes: number
}

/**
 * Read the persisted posture. Never throws: a DB hiccup must fail CLOSED
 * (terminal off) rather than take the app down or silently open the shell.
 */
export function readTerminalPolicy(): TerminalPolicy {
  try {
    const config = getRemoteConfig()
    return {
      allowTerminal: config?.allowTerminal ?? false,
      shellGrantIdleMinutes: config?.shellGrantIdleMinutes ?? DEFAULT_SHELL_GRANT_IDLE_MINUTES
    }
  } catch (err) {
    logger.warn(
      'terminal-service',
      `Could not read the remote-terminal policy (failing closed): ${
        err instanceof Error ? err.message : String(err)
      }`
    )
    return { allowTerminal: false, shellGrantIdleMinutes: DEFAULT_SHELL_GRANT_IDLE_MINUTES }
  }
}

/** The decay window in ms, clamped to something a human could actually use. */
export function shellGrantIdleMs(policy: TerminalPolicy = readTerminalPolicy()): number {
  const minutes = Number.isFinite(policy.shellGrantIdleMinutes)
    ? Math.min(Math.max(Math.trunc(policy.shellGrantIdleMinutes), 1), 24 * 60)
    : DEFAULT_SHELL_GRANT_IDLE_MINUTES
  return minutes * 60_000
}

export class TerminalService {
  private manager = new PtyManager()
  private win: HostWindowHandle | null = null
  /**
   * Credential the step-up ceremony verifies against — used here only for its
   * PUBLIC params (salt + KDF), never to verify anything. Constructed once; it
   * reads `remote_config` on every call.
   */
  private stepUpCredential: PasswordAuthProvider = dbPasswordAuthProvider()

  /**
   * Desktop renderer target for `terminal:data` / `terminal:exit`, and the
   * window-lifetime shell teardown.
   *
   * The `closed` → {@link killAll} hookup lives here as of SyncCore phase 4d: it
   * used to sit in `registerTerminalIpc(win)`, which made a window-free
   * registration impossible even though the pty manager is process-lifetime and
   * shared with the remote transport. The shells belong to this service, so their
   * lifetime rule does too — and a windowless boot simply never calls this.
   */
  setWindow(win: HostWindowHandle | null): void {
    this.win = win
    win?.on('closed', () => {
      this.killAll()
    })
  }

  /** Install the remote transport's delivery sink (null tears it down). */
  setRemoteSink(sink: PtyRemoteSink | null): void {
    this.manager.setRemoteSink(sink)
  }

  /** Test/inspection seam. */
  ptyManager(): PtyManager {
    return this.manager
  }

  /**
   * The three booleans the UI gates on (capability honesty: the web client
   * shows the terminal affordance only from this), plus the params the step-up
   * proof is derived from.
   *
   * The desktop renderer is never gated by the REMOTE toggle — that switch
   * exists to arm the `shell` capability for remote connections, not to take
   * the local shell away from the person sitting at the machine. It never runs
   * a ceremony either, hence `stepUp: null` there.
   *
   * `stepUp` is carried HERE rather than left to `/remote/auth-info` because
   * auth-info advertises AUTHENTICATION methods, and the tunnel transport
   * correctly refuses password auth (see `TerminalStepUpParams`). Read
   * fresh per call (like the policy) so provisioning or clearing the credential
   * applies to the very next query. Same DB-backed provider `RemoteServer`
   * verifies the proof against, so the two can never disagree in production.
   */
  availability(connection: CommandConnection): TerminalAvailability {
    if (connection.identity.method === 'desktop') {
      return {
        allowed: true,
        needsStepUp: false,
        granted: true,
        readsAllowed: true,
        stepUp: null
      }
    }
    const allowed = readTerminalPolicy().allowTerminal
    // `granted` keeps its ADR-052 meaning — "may I ACT?" — because that is the
    // question the affordance asks (can this client type into a shell). Under
    // ADR-054 a connection may legitimately be able to WATCH without it, which
    // is a strictly wider answer and therefore breaks no existing client: the
    // web bundle still prompts for step-up exactly when it used to.
    const granted = allowed && shellActAllowed(connection)
    return {
      allowed,
      needsStepUp: allowed && !granted,
      granted,
      // The read/act split, made VISIBLE to the client (ADR-054 series 2). Both
      // values are answered from `step-up-tier.ts`'s one table, so the affordance
      // cannot disagree with the gate that will judge the next frame. `granted`
      // implies this — the act window can only be live on an armed connection —
      // but they are computed independently rather than derived, because the
      // whole point is that the WIDER answer is the one a client must be able to
      // ask for on its own.
      //
      // The CAPABILITY is part of the answer, not just the presence proof. The
      // tier table reasons about freshness and knows nothing about grants, and
      // the two come apart in exactly one place: `revokeShellGrant` (the desktop
      // toggle going off) strips `shell` and deliberately leaves `armedEver`
      // standing, so nothing but a fresh arming restores it. Without this clause
      // a connection that lived through an off→on cycle — or that stepped up
      // while the toggle was off, which now succeeds and confers no shell — would
      // be told it may WATCH while the registry refuses every read verb it has,
      // and the panel would render a "Watching" terminal in which nothing works.
      // The wall is the honest answer there; one ceremony recovers it.
      readsAllowed: allowed && connection.grants.has('shell') && shellReadAllowed(connection),
      stepUp: this.stepUpCredential.params()
    }
  }

  /**
   * Gate every shell operation at the SERVICE layer as well as the transport.
   *
   * The transport (remote-server) checks first so it can refresh the decay
   * deadline and answer with the distinguishable error; this is the backstop
   * that keeps the guarantee true for any future caller that forgets.
   *
   * `cls` is the ADR-054 read/act split, and it is passed rather than derived
   * here on purpose: the classification lives in ONE table (`step-up-tier.ts`),
   * which both this backstop and the transport gate read, so the two layers
   * cannot disagree about whether a verb is a read. Each call site names its
   * own class, so the split is visible at the method it governs.
   */
  private assertAllowed(connection: CommandConnection, cls: 'read' | 'act'): void {
    if (connection.identity.method === 'desktop') return
    if (!readTerminalPolicy().allowTerminal) throw new Error(TERMINAL_DISABLED_ERROR)
    const ok = cls === 'read' ? shellReadAllowed(connection) : shellActAllowed(connection)
    if (!ok) throw new Error(NEEDS_STEP_UP_ERROR)
  }

  /**
   * Open terminal `index` of `cwd`'s pool — attach to the live one if that slot
   * is taken, else spawn it there (SyncCore phase 2 follow-through: terminals
   * are a per-cwd ORDERED POOL, shared by every surface, tmux-style).
   *
   * `index` is optional on the wire so an older remote bundle that only knows
   * `terminal:create(cwd)` keeps working: no index means "next free slot", i.e.
   * always a fresh pty, which is exactly what it used to get.
   *
   * Returns the terminal ID (a bare string, not an envelope) — also for
   * backward compatibility: that is what every existing client awaits.
   */
  create(connection: CommandConnection, cwd: string, index?: number | null): string {
    this.assertAllowed(connection, 'act')
    if (typeof cwd !== 'string' || cwd.trim() === '') {
      throw new Error('A working directory is required to open a terminal')
    }
    if (index !== undefined && index !== null && !Number.isInteger(index)) {
      throw new Error('A terminal index must be an integer')
    }
    // Captured at spawn time: the exit row is attributed to whoever SPAWNED the
    // pty, not to whoever happened to be attached when it died.
    const spawner = connection
    return this.manager.open(
      cwd,
      index ?? null,
      (terminalId, data) => {
        this.sendData(terminalId, data)
      },
      (terminalId, exitCode) => {
        if (this.hasLocalSink()) {
          this.win!.webContents.send('terminal:exit', { terminalId, code: exitCode })
        }
        this.auditLifecycle(spawner, 'terminal:exit')
      }
    ).id
  }

  /** Is there a desktop renderer to deliver to? (A headless boot has none.) */
  private hasLocalSink(): boolean {
    return this.win !== null && !this.win.isDestroyed()
  }

  /**
   * Host-local PTY delivery. The channel is a LITERAL on purpose — the funnel
   * guard refuses a computed `webContents.send` channel unless the whole file is
   * allowlisted as host-local by construction.
   */
  private sendData(terminalId: string, data: string, replay?: true): void {
    if (!this.hasLocalSink()) return
    this.win!.webContents.send('terminal:data', { terminalId, data, replay })
  }

  write(connection: CommandConnection, id: string, data: string): void {
    this.assertAllowed(connection, 'act')
    this.manager.write(id, data)
  }

  // Read-class (ADR-054): display geometry. It writes SIGWINCH but cannot
  // execute, and an attached view being watched must survive a window resize
  // after the act window decays.
  resize(connection: CommandConnection, id: string, cols: number, rows: number): void {
    this.assertAllowed(connection, 'read')
    this.manager.resize(id, cols, rows)
  }

  kill(connection: CommandConnection, id: string): void {
    this.assertAllowed(connection, 'act')
    this.manager.kill(id)
  }

  /**
   * Which slots of `cwd`'s pool hold a live pty right now.
   *
   * Read-only affordance data: closing a tab detaches, so a client that reopens
   * slot 0 may land on a shell that has been running all along — and nothing
   * else on the wire says so before the click. Gated exactly like the rest of
   * the terminal surface (`assertAllowed` + the `shell` capability at both
   * registrations), so a client without a live grant learns nothing.
   *
   * Slots only, never pty ids: the caller re-opens by SLOT, and an id it is not
   * showing is not its business.
   */
  poolSlots(connection: CommandConnection, cwd: string): number[] {
    this.assertAllowed(connection, 'read')
    if (typeof cwd !== 'string' || cwd.trim() === '') return []
    return this.manager.poolOf(cwd).map((slot) => slot.index)
  }

  killByCwd(connection: CommandConnection, cwd: string): string[] {
    this.assertAllowed(connection, 'act')
    return this.manager.killByCwd(cwd)
  }

  /**
   * Attach `connection` to a live terminal and replay its scrollback.
   *
   * Deliberately a `command`, not a query, at the registration site — see the
   * comment there. Returns false when the terminal is gone (a stale tab in the
   * client), which the caller surfaces rather than throwing.
   *
   * TWO LANES, one ring. A remote connection is registered in the pty manager's
   * attachment set and has the replay PUSHED to its socket. The desktop has no
   * attachment set to join — its bytes ride a broadcast `terminal:data` channel
   * that predates multi-attach — so its attach only pulls the ring and delivers
   * it on that same channel, flagged `replay`.
   *
   * The flag matters because the desktop lane is NOT attachment-gated: between a
   * renderer installing its `terminal:data` listener and this call landing, live
   * bytes may already have been written to the xterm — and they are in the ring
   * too (the ring is fed in the same statement that sends them). `replay: true`
   * therefore means "reset, then take this as the whole history", which is
   * idempotent no matter how much of it the client already saw. Live bytes that
   * arrive afterwards are sent on a later turn of the loop, so ordering is
   * replay-then-live with no interleave.
   */
  attach(connection: CommandConnection, id: string): boolean {
    this.assertAllowed(connection, 'read')
    if (connection.identity.method !== 'desktop') {
      return this.manager.attach(id, connection.connectionId)
    }
    if (!this.manager.has(id)) return false
    this.sendData(id, this.manager.scrollbackOf(id), true)
    return true
  }

  detach(connection: CommandConnection, id: string): void {
    // No gate: detaching is always safe, and refusing it for an expired grant
    // would strand the attachment we are trying to release.
    this.manager.detach(id, connection.connectionId)
  }

  /** Drop every attachment held by one connection (socket close, decay, policy). */
  detachConnection(connectionId: string, reason?: TermDetachReason): void {
    this.manager.detachAll(connectionId, reason)
  }

  killAll(): void {
    this.manager.killAll()
  }

  /** Append one metadata-only lifecycle row. Never carries PTY content. */
  private auditLifecycle(connection: CommandConnection, channel: string): void {
    try {
      appendAuditLog({
        ts: Date.now(),
        connectionId: connection.connectionId,
        method: connection.identity.method,
        label: connection.identity.label,
        capability: 'shell',
        kind: 'command',
        channel,
        sessionId: null,
        outcome: 'ok'
      })
    } catch (err) {
      // Same non-fatal posture as the registry's audit: observability must not
      // be able to take down the terminal.
      logger.error('terminal-service', `audit append failed for ${channel}: ${err}`)
    }
  }
}

/** The one instance both transports share. */
export const terminalService = new TerminalService()
