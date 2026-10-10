/**
 * The token keeper: keeps the ACTIVE multi-account Claude account's OAuth token
 * fresh for the cli.js processes running on it (ADR-015).
 *
 * In multi-account mode the app owns each account's credentials file and hands
 * cli.js the access token through `CLAUDE_CODE_OAUTH_TOKEN` (`sdk/args.ts`).
 * cli.js never refreshes an env-supplied token and never writes it to disk, so
 * everything a refresh used to do inside cli.js happens here, on Claude
 * Desktop 2.9939.2's contract:
 *
 *  - before a spawn, {@link ClaudeHostTokenKeeper.ensureFresh} refreshes a token
 *    that expires within {@link RENEW_AHEAD_MS} (5 minutes), and refuses the
 *    spawn when no usable token can be had;
 *  - while a process runs, a renewal timer refreshes the token in use at
 *    `expiresAt − min(5 min, remaining / 2)`, never more than 6 h out, never
 *    sooner than 60 s after the last token write, retrying a failure after 60 s;
 *  - on ANY rotation of the active file's token (that timer, a usage read, or
 *    an answer below) every live process still on an older token is handed the
 *    new one with `update_environment_variables`;
 *  - cli.js's `oauth_token_refresh` (a 401) is answered with a fresh token, or
 *    with none and why: `identity_changed`, `signed_out`, `refresh_failed`,
 *    `transient` (docs/protocol-cc/08 §8.7).
 *
 * Every refresh goes through `refreshClaudeToken` (single-flighted per file; it
 * persists the rotated refresh token) under ADR-071 §6's guard
 * (`claude-refresh-guard.ts`): at most one attempt per version of the file, and
 * a refusal marks the account as needing a sign-in until the file changes.
 *
 * Electron-free. Published to the SDK layer as its `HostTokenSource`
 * (`sdk/host-token.ts`) by `startCoreServices`.
 */

import { join } from 'node:path'
import {
  hostTokenDir,
  setHostTokenSource,
  HostTokenUnavailableError,
  type HostTokenCredential,
  type HostTokenSession,
  type HostTokenSource
} from '../sdk/host-token'
import { getSecurestorageEnv, onSecurestorageEnvChange } from '../sdk/securestorage-env'
import type { OAuthTokenAnswer } from '../sdk/types'
import { CREDENTIALS_FILE } from '../auth/claude-oauth'
import {
  isRefreshRefusal,
  onClaudeTokenRotated,
  readCredentialsFile,
  readCredentialsFileSync,
  refreshClaudeToken,
  type OAuthCredentials
} from './claude-usage-api'
import {
  claudeRefreshGuard,
  credentialVersion,
  credentialVersionSync
} from './claude-refresh-guard'
import { logger } from './logger'

/** Desktop's `renewAheadMs`: refresh before a spawn when the token expires within this. */
export const RENEW_AHEAD_MS = 300_000
/** The renewal timer's longest delay. */
export const RENEW_MAX_DELAY_MS = 21_600_000
/** Desktop's `ccdRenewFloorLeftMs`: no renewal sooner than this after a token write. */
export const RENEW_FLOOR_MS = 60_000
/** A failed renewal retries after this. */
export const RENEW_RETRY_MS = 60_000

/**
 * When the renewal of a token expiring at `expiresAt` is due, as a delay from
 * `now`: `expiresAt − min(RENEW_AHEAD_MS, remaining / 2)`, at least
 * {@link RENEW_FLOOR_MS} after the last write (when one is known).
 * Uncapped: {@link RENEW_MAX_DELAY_MS} bounds the TIMER, not the due time.
 */
export function renewalDueIn(expiresAt: number, now: number, lastWriteAt: number | null): number {
  const remaining = expiresAt - now
  const dueAt = expiresAt - Math.min(RENEW_AHEAD_MS, remaining / 2)
  const floorAt = lastWriteAt === null ? -Infinity : lastWriteAt + RENEW_FLOOR_MS
  return Math.max(0, Math.max(dueAt, floorAt) - now)
}

function credentialsPath(dir: string): string {
  return join(dir, CREDENTIALS_FILE)
}

function spawnCredential(creds: OAuthCredentials): HostTokenCredential {
  return {
    accessToken: creds.accessToken,
    scopes: Array.isArray(creds.scopes) ? creds.scopes : [],
    subscriptionType: creds.subscriptionType ?? null,
    rateLimitTier: creds.rateLimitTier ?? null
  }
}

/** The renewal timer, and the token and instant it is timed for. */
interface RenewalTimer {
  handle: ReturnType<typeof setTimeout>
  dir: string
  /** The access token this renewal replaces; a different one in the file re-times it. */
  token: string
  /** When the renewal is actually due (the timer itself is capped at 6 h). */
  dueAt: number
}

export class ClaudeHostTokenKeeper implements HostTokenSource {
  private readonly sessions = new Set<HostTokenSession>()
  /** Each session's `oauth_token_refresh` answer in flight: one per session. */
  private readonly answering = new Map<HostTokenSession, Promise<OAuthTokenAnswer>>()
  /** When this process last wrote a rotated token to each file (the 60 s floor). */
  private readonly lastWriteAt = new Map<string, number>()
  private timer: RenewalTimer | null = null
  private unsubscribes: Array<() => void> = []

  /** Publish the keeper to the SDK layer and follow rotations and switches. Idempotent. */
  start(): void {
    if (this.unsubscribes.length > 0) return
    setHostTokenSource(this)
    this.unsubscribes = [
      onClaudeTokenRotated((path, creds) => this.onRotated(path, creds)),
      onSecurestorageEnvChange(() => this.onSwitch())
    ]
  }

  /** Undo {@link start}. Spawns in multi-account mode then refuse (no source). */
  stop(): void {
    for (const unsubscribe of this.unsubscribes) unsubscribe()
    this.unsubscribes = []
    this.clearTimer()
    setHostTokenSource(null)
  }

  // -------------------------------------------------------------------------
  // HostTokenSource
  // -------------------------------------------------------------------------

  read(dir: string): HostTokenCredential | null {
    const creds = readCredentialsFileSync(credentialsPath(dir))
    return creds ? spawnCredential(creds) : null
  }

  async ensureFresh(): Promise<void> {
    const dir = hostTokenDir()
    if (!dir) return
    const path = credentialsPath(dir)
    const creds = await readCredentialsFile(path)
    if (!creds) throw new HostTokenUnavailableError('signed-out')
    if (creds.expiresAt - Date.now() > RENEW_AHEAD_MS) return

    const version = await credentialVersion(path)
    let refused = !claudeRefreshGuard.allowed(path, version)
    let transient = false
    if (!refused) {
      try {
        await refreshClaudeToken(creds, path)
        return
      } catch (err) {
        refused = isRefreshRefusal(err)
        transient = !refused
        claudeRefreshGuard.note({ refreshFailed: refused }, path, version)
        logger.info('ClaudeHostToken', `pre-spawn refresh failed: ${describe(err)}`)
      }
    }
    // A token that has not expired yet still carries this spawn; cli.js asks
    // for a new one when it is rejected, and that answer applies the same rules.
    if (creds.expiresAt > Date.now()) return
    throw new HostTokenUnavailableError(transient ? 'unavailable' : 'needs-sign-in')
  }

  attach(session: HostTokenSession): () => void {
    this.sessions.add(session)
    if (!this.timer && session.dir === getSecurestorageEnv()?.dir) void this.armFromFile()
    return () => {
      this.sessions.delete(session)
      this.answering.delete(session)
      if (this.timer && !this.hasSessionsOn(this.timer.dir)) this.clearTimer()
    }
  }

  answerRefresh(session: HostTokenSession): Promise<OAuthTokenAnswer> {
    const inFlight = this.answering.get(session)
    if (inFlight) return inFlight
    const answer = this.computeAnswer(session).finally(() => {
      if (this.answering.get(session) === answer) this.answering.delete(session)
    })
    this.answering.set(session, answer)
    return answer
  }

  // -------------------------------------------------------------------------
  // oauth_token_refresh
  // -------------------------------------------------------------------------

  private async computeAnswer(session: HostTokenSession): Promise<OAuthTokenAnswer> {
    // The identity fence: a process spawned for an account the user has since
    // switched away from must not be handed the NEW account's token. The switch
    // cancels such processes; this covers the window before it lands.
    if (session.dir !== getSecurestorageEnv()?.dir) {
      return { accessToken: null, reason: 'identity_changed' }
    }
    const path = credentialsPath(session.dir)
    const creds = await readCredentialsFile(path)
    if (!creds) return { accessToken: null, reason: 'signed_out' }

    const now = Date.now()
    if (creds.expiresAt > now) {
      // Someone else rotated the token since this process was handed one.
      if (creds.accessToken !== session.token) return this.hand(session, creds.accessToken)
      // This process already holds the file's token, and that token was written
      // moments ago: the request is a straggler from the PREVIOUS token (cli.js
      // sends several at startup; the orchestrator's probe saw four). cli.js
      // compares the answer with the token that failed, so the current token is
      // the right answer, and a second refresh would only spend a grant.
      const wroteAt = this.lastWriteAt.get(path)
      if (wroteAt !== undefined && now - wroteAt < RENEW_FLOOR_MS) {
        return this.hand(session, creds.accessToken)
      }
    }

    const version = await credentialVersion(path)
    if (!claudeRefreshGuard.allowed(path, version)) {
      return { accessToken: null, reason: 'refresh_failed' }
    }
    try {
      const fresh = await refreshClaudeToken(creds, path)
      return this.hand(session, fresh.accessToken)
    } catch (err) {
      const refused = isRefreshRefusal(err)
      claudeRefreshGuard.note({ refreshFailed: refused }, path, version)
      logger.info('ClaudeHostToken', `oauth_token_refresh not answered: ${describe(err)}`)
      return { accessToken: null, reason: refused ? 'refresh_failed' : 'transient' }
    }
  }

  private hand(session: HostTokenSession, token: string): OAuthTokenAnswer {
    session.token = token
    return { accessToken: token }
  }

  // -------------------------------------------------------------------------
  // Rotation → push
  // -------------------------------------------------------------------------

  private onRotated(path: string, creds: OAuthCredentials): void {
    const dir = getSecurestorageEnv()?.dir
    if (!dir || path !== credentialsPath(dir)) return
    this.lastWriteAt.set(path, Date.now())
    for (const session of this.sessions) {
      if (session.dir !== dir || session.token === creds.accessToken) continue
      // A session whose own refresh answer is in flight gets the token in that
      // answer; pushing it too would only hand it the same token twice.
      if (this.answering.has(session)) continue
      void this.push(session, creds.accessToken)
    }
    if (this.hasSessionsOn(dir)) this.schedule(dir, creds)
  }

  private async push(session: HostTokenSession, token: string): Promise<void> {
    try {
      if (await session.push(token)) {
        session.token = token
        return
      }
      logger.warn('ClaudeHostToken', 'a live session did not take the rotated token')
    } catch (err) {
      logger.warn('ClaudeHostToken', `pushing the rotated token failed: ${describe(err)}`)
    }
  }

  // -------------------------------------------------------------------------
  // Switch
  // -------------------------------------------------------------------------

  private onSwitch(): void {
    // The previous account's timer and pushes stop here: rotations are matched
    // against the ACTIVE dir only, so its sessions (which the switch cancels)
    // are never handed a token again.
    this.clearTimer()
    const dir = getSecurestorageEnv()?.dir
    if (dir && this.hasSessionsOn(dir)) void this.armFromFile()
  }

  // -------------------------------------------------------------------------
  // Renewal timer
  // -------------------------------------------------------------------------

  private hasSessionsOn(dir: string): boolean {
    for (const session of this.sessions) if (session.dir === dir) return true
    return false
  }

  private async armFromFile(): Promise<void> {
    const dir = getSecurestorageEnv()?.dir
    if (!dir) return
    const creds = await readCredentialsFile(credentialsPath(dir))
    // Re-checked after the read: a switch, a detach or a rotation may have run.
    if (!creds || this.timer || dir !== getSecurestorageEnv()?.dir || !this.hasSessionsOn(dir)) {
      return
    }
    this.schedule(dir, creds)
  }

  /** Time the renewal of `creds` (the token in use in `dir`). */
  private schedule(dir: string, creds: OAuthCredentials): void {
    const now = Date.now()
    const due = renewalDueIn(
      creds.expiresAt,
      now,
      this.lastWriteAt.get(credentialsPath(dir)) ?? null
    )
    this.setTimer(dir, creds.accessToken, now + due)
  }

  private setTimer(dir: string, token: string, dueAt: number): void {
    this.clearTimer()
    const delay = Math.min(Math.max(0, dueAt - Date.now()), RENEW_MAX_DELAY_MS)
    const handle = setTimeout(() => void this.renew(), delay)
    // A renewal must never be what keeps the process alive at quit.
    ;(handle as { unref?: () => void }).unref?.()
    this.timer = { handle, dir, token, dueAt }
  }

  private clearTimer(): void {
    if (this.timer) clearTimeout(this.timer.handle)
    this.timer = null
  }

  private async renew(): Promise<void> {
    const timer = this.timer
    if (!timer) return
    this.timer = null
    const { dir, token, dueAt } = timer
    if (dir !== getSecurestorageEnv()?.dir || !this.hasSessionsOn(dir)) return
    const path = credentialsPath(dir)
    const creds = await readCredentialsFile(path)
    if (!creds) return
    // Another writer rotated the token after this timer was set: time the new one.
    if (creds.accessToken !== token) return this.schedule(dir, creds)
    // The 6-hour cap fired before the renewal was due.
    if (Date.now() < dueAt) return this.setTimer(dir, token, dueAt)

    const version = await credentialVersion(path)
    // Refused on this version already: the account needs a sign-in, which
    // rewrites the file and restarts the sessions (and so this timer).
    if (!claudeRefreshGuard.allowed(path, version)) return
    try {
      // Success re-times through onRotated, which also pushes the new token.
      await refreshClaudeToken(creds, path)
    } catch (err) {
      const refused = isRefreshRefusal(err)
      claudeRefreshGuard.note({ refreshFailed: refused }, path, version)
      logger.info('ClaudeHostToken', `renewal failed: ${describe(err)}`)
      if (!refused && !this.timer) this.setTimer(dir, token, Date.now() + RENEW_RETRY_MS)
    }
  }
}

/** The error's text, never a token: refresh errors carry a status, not a body. */
function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/** The keeper `startCoreServices` wires. */
export const claudeHostTokenKeeper = new ClaudeHostTokenKeeper()

/** The active account's login, as its own credential tells it. */
export interface HostTokenLogin {
  signedIn: boolean
  /** The credential's `subscriptionType`, when it has one. */
  subscriptionType: string | null
}

/**
 * Is the active account signed in, when spawns run on its host token?
 *
 * `null` when they do not (single-account mode, or an endpoint profile): the
 * caller keeps reading cli.js's initialize `account`. Under a host token that
 * `account` carries no email at all (`tokenSource: "CLAUDE_CODE_OAUTH_TOKEN"`),
 * so the answer comes from the account's own credential instead: present, and
 * not refused a refresh on its current version (ADR-071 §6's needs-sign-in).
 * Synchronous, like the reads it replaces; the file is tiny.
 */
export function hostTokenLogin(): HostTokenLogin | null {
  const dir = hostTokenDir()
  if (!dir) return null
  const path = credentialsPath(dir)
  const creds = readCredentialsFileSync(path)
  if (!creds) return { signedIn: false, subscriptionType: null }
  return {
    signedIn: claudeRefreshGuard.allowed(path, credentialVersionSync(path)),
    subscriptionType: creds.subscriptionType ?? null
  }
}
