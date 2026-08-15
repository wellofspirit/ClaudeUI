/**
 * Passkey enrollment + management command BODIES (ADR-052 / security.md
 * §Enrollment & recovery).
 *
 * Same split as the terminal commands: the bodies live here once, and each
 * transport spells out its own registration — `webauthn.ipc.ts` for desktop,
 * `remote-handlers.ts` for remote. The registration literals are duplicated on
 * purpose (the registry throws if the two disagree about capability/kind, and
 * `remote-channel-parity.test.ts` scans `remote-handlers.ts` as source text), but
 * the LOGIC is not.
 *
 * Every body takes the calling {@link CommandConnection} FIRST — `withConnection`
 * — because two of the three things a ceremony needs are per-connection facts
 * the caller must not be able to supply: the connection id a challenge is bound
 * to, and the RP ID / origin derived from the request `Host`. Reading either
 * from the argument list would let a remote client mint a challenge for someone
 * else's socket or bind a credential to a domain it chose.
 */

import {
  ENROLL_UNAVAILABLE_ERROR,
  LAST_CREDENTIAL_LOCKOUT_ERROR,
  PASSKEY_UNAVAILABLE_ERROR
} from '../../shared/remote-protocol'
import type {
  PublicKeyCredentialCreationOptionsJSON,
  RegistrationResponseJSON
} from '@simplewebauthn/server'
import { readAuthPolicyContext, withAuthSurfaceReaction } from '../services/auth-policy'
import { getRemoteConfig } from '../services/db'
import { logger } from '../services/logger'
import {
  normalizeNickname,
  webauthnService,
  type WebauthnCredentialSummary,
  type WebauthnService
} from '../services/webauthn-service'
import type { CommandConnection } from './command-registry'

/**
 * What the passkey verbs need from the running server. An interface rather than
 * the concrete `RemoteServer` so this module stays out of that import graph
 * (and so a test can hand it a two-line fake).
 *
 * Both members exist for the same reason: a credential mutation here has
 * consequences on the LISTENER, and this module must not know what a WebSocket
 * is to have them.
 */
export interface RemoteAuthSurfaceHost {
  mintEnrollToken(): { token: string; expiresAt: number; url: string }
  /** Drop every remote client, optionally sparing the one that caused it. */
  disconnectAuthSurfaceClients(opts?: { exceptConnectionId?: string }): void
}

/** @deprecated Historical name for {@link RemoteAuthSurfaceHost}'s minting half. */
export type EnrollTokenMinter = RemoteAuthSurfaceHost

/**
 * Run a credential mutation through the shared auth-surface reaction.
 *
 * Enrolling the FIRST credential (0→1) or revoking the LAST one (1→0) flips
 * what AUTO resolves to — `legacy` ⇄ `passkey-always` — with nobody writing the
 * config column. That is an auth-surface change exactly like a
 * `remote:set-config` write, and it owes the same two things: an audit row and a
 * re-admission disconnect. Enrolling a second credential (1→2) moves nothing
 * effective, so it owes neither. The reaction's own before/after comparison is
 * what tells them apart (`auth-policy.ts`), which is why this wrapper is three
 * lines and not a second copy of the rule.
 */
async function withCredentialSurfaceReaction<T>(
  connection: CommandConnection,
  host: RemoteAuthSurfaceHost | null,
  mutate: () => T | Promise<T>
): Promise<T> {
  return await withAuthSurfaceReaction({ connection, host, via: 'credential change', mutate })
}

/** Result envelope for `webauthn:register-verify`. */
export type RegisterVerifyResult =
  | { ok: true; credId: string; backedUp: boolean }
  | { ok: false; error: string }

/**
 * The origin binding a ceremony must run against. Throws rather than falling
 * back to a guess: a registration verified against the wrong RP ID produces a
 * credential that can never assert, which is worse than a clear refusal.
 */
function requireOrigin(connection: CommandConnection): { rpId: string; origin: string } {
  const origin = connection.webauthnOrigin
  if (!origin) throw new Error(PASSKEY_UNAVAILABLE_ERROR)
  return origin
}

export async function webauthnRegisterOptions(
  connection: CommandConnection,
  service: WebauthnService = webauthnService
): Promise<PublicKeyCredentialCreationOptionsJSON> {
  const origin = requireOrigin(connection)
  return await service.startRegistration({ origin, connectionId: connection.connectionId })
}

export async function webauthnRegisterVerify(
  connection: CommandConnection,
  payload: { response: RegistrationResponseJSON; nickname?: string | null },
  host: RemoteAuthSurfaceHost | null = null,
  service: WebauthnService = webauthnService
): Promise<RegisterVerifyResult> {
  const origin = requireOrigin(connection)
  if (!payload || typeof payload !== 'object' || !payload.response) {
    return { ok: false, error: 'malformed' }
  }
  return await withCredentialSurfaceReaction(connection, host, async () => {
    const result = await service.finishRegistration({
      origin,
      connectionId: connection.connectionId,
      response: payload.response,
      nickname: payload.nickname ?? null
    })
    if (!result.ok) {
      logger.warn(
        'webauthn',
        `Passkey registration rejected for ${connection.identity.label}: ${result.reason}`
      )
      return { ok: false, error: result.reason }
    }
    logger.info(
      'webauthn',
      `Passkey enrolled by ${connection.identity.label} (backedUp=${result.backedUp})`
    )
    return { ok: true, credId: result.credId, backedUp: result.backedUp }
  })
}

export function webauthnCredentials(
  service: WebauthnService = webauthnService
): WebauthnCredentialSummary[] {
  return service.credentials()
}

export function webauthnRename(
  credId: string,
  nickname: string | null,
  service: WebauthnService = webauthnService
): { ok: boolean } {
  if (typeof credId !== 'string' || credId === '') return { ok: false }
  return { ok: service.rename(credId, normalizeNickname(nickname)) }
}

/**
 * Revoke one credential, behind the LOCKOUT GUARD.
 *
 * Revoking the last passkey is normally harmless: with the policy on AUTO it
 * simply falls back to `legacy` (no special casing — that is what AUTO means).
 * It is only dangerous when the operator PINNED `passkey-always` and there is no
 * usable break-glass password, because then nothing else can authenticate. Note
 * the guard demands the password actually EXISTS, not merely that the toggle is
 * on: "break-glass enabled" with no credential provisioned is the same lockout
 * with an extra step.
 */
export async function webauthnRevoke(
  connection: CommandConnection,
  credId: string,
  host: RemoteAuthSurfaceHost | null = null,
  service: WebauthnService = webauthnService
): Promise<{ ok: boolean }> {
  if (typeof credId !== 'string' || credId === '') return { ok: false }
  const ctx = readAuthPolicyContext()
  const passwordSet = safePasswordSet()
  const isLast = ctx.credentialCount <= 1
  if (isLast && ctx.stored === 'passkey-always' && !(ctx.passwordBreakGlass && passwordSet)) {
    throw new Error(LAST_CREDENTIAL_LOCKOUT_ERROR)
  }
  // Revoking the LAST credential under AUTO is the loosening twin of enrolling
  // the first: `passkey-always` → `legacy`, so every client admitted under the
  // stricter rules is re-admitted under the looser ones.
  return await withCredentialSurfaceReaction(connection, host, () => ({ ok: service.revoke(credId) }))
}

export function mintEnrollToken(host: RemoteAuthSurfaceHost | null): {
  token: string
  expiresAt: number
  url: string
} {
  if (!host) throw new Error(ENROLL_UNAVAILABLE_ERROR)
  return host.mintEnrollToken()
}

/** Is a break-glass password provisioned? Fails CLOSED (false) on a DB error,
 *  which makes the lockout guard STRICTER rather than laxer. */
function safePasswordSet(): boolean {
  try {
    return getRemoteConfig()?.passwordHash != null
  } catch {
    return false
  }
}
