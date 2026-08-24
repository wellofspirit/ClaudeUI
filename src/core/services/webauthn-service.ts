/**
 * WebAuthn / passkeys — the single owner of ceremony semantics (ADR-052
 * decision 1, `docs/architecture/security.md` §"Passkeys / WebAuthn").
 *
 * Three responsibilities, deliberately kept together because they are the three
 * halves of one trust decision:
 *
 *  1. **Origin binding** ({@link resolveWebauthnOrigin}). A passkey is bound to
 *     an RP ID, which must be a stable registrable domain served over a secure
 *     context. Exactly two origins qualify here: the tailnet DNS name this
 *     server's `tailscale serve` proxy presents, and `localhost` for
 *     development. A plain-LAN IP is not a secure context AND is not a legal RP
 *     ID; an ephemeral tunnel hostname is neither stable nor ours. Those two
 *     therefore never do WebAuthn, and the server falls back to the as-built
 *     methods for such a connection — which is why capability is decided from
 *     the `Host` header the Host allowlist already validates, and NEVER from
 *     anything the client claims about its own context.
 *
 *  2. **Challenge custody** ({@link ChallengeStore}). Server-side, single-use,
 *     2-minute TTL, and bound to BOTH the requesting connection and the ceremony
 *     KIND. Connection binding stops a challenge minted for socket A from being
 *     completed on socket B (the classic relay); kind binding stops a handshake
 *     challenge from being replayed into a step-up, which would let a socket
 *     that authenticated once re-use that single ceremony to keep arming shell
 *     grants. Consumption happens on the first verify ATTEMPT — success or
 *     failure — so a wrong answer costs a fresh round trip.
 *
 *  3. **Verification** — thin wrappers over `@simplewebauthn/server`. We never
 *     hand-roll COSE/CBOR (supply-chain and correctness posture, security.md
 *     §Implementation notes), and the library's verify functions are never
 *     mocked in tests: the guard value of this file is that a REAL signature
 *     over a REAL challenge is what passes.
 *
 * Single operator ⇒ ONE fixed user handle and **discoverable credentials**
 * (`residentKey: 'required'`), so there is no username step and an assertion
 * carries no `allowCredentials` filter — the authenticator picks. `userVerification`
 * is `'required'` on both ceremonies: the device biometric IS the factor we are
 * verifying. Attestation is `'none'` — we do not care WHICH authenticator model
 * the owner used, only that the key lives in one.
 *
 * Sign counters are recorded and NEVER enforced: synced passkeys (iCloud
 * Keychain, Google Password Manager) legitimately report 0 forever, so a
 * counter-regression rejection would lock out exactly the credentials this
 * design is built around.
 */

import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse
} from '@simplewebauthn/server'
import type {
  AuthenticationResponseJSON,
  AuthenticatorTransportFuture,
  PublicKeyCredentialCreationOptionsJSON,
  PublicKeyCredentialRequestOptionsJSON,
  RegistrationResponseJSON
} from '@simplewebauthn/server'
import {
  countWebauthnCredentials,
  deleteWebauthnCredential,
  getWebauthnCredential,
  insertWebauthnCredential,
  listWebauthnCredentials,
  renameWebauthnCredential,
  touchWebauthnCredential,
  type WebauthnCredentialRow
} from './db'
import { logger } from './logger'
import type { WebauthnCredential } from '../../shared/types'

/** Shown by the authenticator's own UI ("Sign in to …"). */
const RP_NAME = 'ClaudeUI'

/**
 * The ONE user handle. Single-operator scope (security.md §Posture) means there
 * is no user table and no username step; every credential belongs to this
 * handle, and discoverable credentials let the authenticator resolve it.
 * Constant bytes, so a re-enrollment after a DB reset lands on the same user.
 */
const USER_HANDLE = new TextEncoder().encode('claudeui-owner')
const USER_NAME = 'claudeui-owner'
const USER_DISPLAY_NAME = 'ClaudeUI owner'

/** Server-side challenge lifetime. Short enough to be a live ceremony, long
 *  enough for a biometric prompt on a phone that has to wake up first. */
export const CHALLENGE_TTL_MS = 2 * 60_000

/** How long the authenticator UI may stay open, client-side (advisory). */
const CEREMONY_TIMEOUT_MS = 60_000

/**
 * What a challenge was minted FOR. Binding this stops cross-purpose replay: a
 * handshake assertion must not arm a `shell` grant, and vice versa.
 */
export type ChallengeKind = 'auth' | 'step-up' | 'register'

interface ChallengeRecord {
  kind: ChallengeKind
  connectionId: string
  expiresAt: number
}

/**
 * Single-use, TTL'd, connection-and-kind-bound challenges.
 *
 * In memory on purpose: a challenge that survived a restart would be a replay
 * window across a process boundary for no benefit (the client simply asks
 * again). Swept lazily on access — a timer would be a second lifetime to reason
 * about, and the map only grows at the rate a client can ask for challenges,
 * which the auth throttle already bounds.
 */
export class ChallengeStore {
  private records = new Map<string, ChallengeRecord>()

  /** Remember a freshly minted challenge. */
  issue(challenge: string, kind: ChallengeKind, connectionId: string, now = Date.now()): void {
    this.sweep(now)
    this.records.set(challenge, { kind, connectionId, expiresAt: now + CHALLENGE_TTL_MS })
  }

  /**
   * Claim a challenge for verification. Returns true only for a live record
   * matching BOTH the kind and the connection; either way the record is gone
   * afterwards, so one challenge buys exactly one verify attempt.
   */
  consume(challenge: string, kind: ChallengeKind, connectionId: string, now = Date.now()): boolean {
    this.sweep(now)
    const record = this.records.get(challenge)
    if (!record) return false
    // Delete FIRST: a mismatched kind/connection must still burn the challenge,
    // or an attacker could probe kinds against a stolen challenge for free.
    this.records.delete(challenge)
    if (record.expiresAt <= now) return false
    if (record.kind !== kind) return false
    return record.connectionId === connectionId
  }

  /** Drop every challenge a connection is holding (socket closed). */
  dropConnection(connectionId: string): void {
    for (const [challenge, record] of this.records) {
      if (record.connectionId === connectionId) this.records.delete(challenge)
    }
  }

  /** Live record count — test seam / diagnostics. */
  get size(): number {
    this.sweep(Date.now())
    return this.records.size
  }

  private sweep(now: number): void {
    for (const [challenge, record] of this.records) {
      if (record.expiresAt <= now) this.records.delete(challenge)
    }
  }
}

/** Where a connection's ceremony is anchored, derived from its request Host. */
export interface WebauthnOrigin {
  /** The registrable domain a credential binds to. */
  rpId: string
  /** The exact `Origin` the browser will send (scheme + host + optional port). */
  origin: string
}

/**
 * Decide whether a connection's `Host` is a WebAuthn-capable origin, and what
 * RP ID / expected origin it implies.
 *
 * Reuses the SAME facts the Host allowlist runs on (`remote-server.isAllowedHost`
 * / `TlsServeState.dnsName`) rather than inventing a second source of truth: a
 * request that reached us at all already passed that allowlist, so this only has
 * to answer "is this one of the two names a passkey may bind to?".
 *
 * - tailnet DNS name (`<machine>.<tailnet>.ts.net`) ⇒ `https://<host>`, RP ID is
 *   the bare name. The Host carries the serve HTTPS port when it is not 443, and
 *   the browser's Origin carries it too — so echoing the raw Host is correct in
 *   both cases.
 * - `localhost` (any port, http or https) ⇒ the development fallback; browsers
 *   treat it as a secure context and accept it as an RP ID.
 * - anything else (LAN IP literal, `*.trycloudflare.com`, mDNS name) ⇒ `null`,
 *   meaning "no ceremony on this connection, use the as-built methods".
 *
 * `scheme` is what the CLIENT would have used, which we cannot observe directly:
 * a tailnet host is always reached through the TLS proxy (https), and localhost
 * in dev may be either — so localhost yields the http origin, matching how the
 * dev web client is actually served. A dev setup running https on localhost is
 * out of scope (and would fail loudly at verify rather than silently pass).
 */
export function resolveWebauthnOrigin(
  hostHeader: string | undefined,
  serve: { dnsName: string } | null
): WebauthnOrigin | null {
  const raw = (hostHeader ?? '').trim().toLowerCase()
  if (!raw) return null
  // Reject bracketed IPv6 and anything with credentials/paths outright — neither
  // can be an RP ID, and parsing them is a way to get this wrong.
  if (raw.startsWith('[') || raw.includes('/') || raw.includes('@')) return null

  const colon = raw.lastIndexOf(':')
  const hostname = colon >= 0 ? raw.slice(0, colon) : raw
  const portPart = colon >= 0 ? raw.slice(colon + 1) : ''
  if (colon >= 0 && !/^\d+$/.test(portPart)) return null
  if (!hostname) return null

  const dnsName = serve?.dnsName?.trim().toLowerCase() ?? ''
  if (dnsName && hostname === dnsName) {
    return { rpId: dnsName, origin: `https://${raw}` }
  }
  if (hostname === 'localhost') {
    return { rpId: 'localhost', origin: `http://${raw}` }
  }
  return null
}

/**
 * The rows the management UI is allowed to see — never `publicKey`.
 *
 * An ALIAS of the shared declaration, not a second copy: both clients render
 * these rows, and this module is main-only (it imports `@simplewebauthn/server`),
 * so the shape has to live in `shared/types.ts` for the renderer and the web
 * adapter to type it. Keeping the historical name as an alias means every call
 * site here is unchanged and the two can no longer drift.
 */
export type WebauthnCredentialSummary = WebauthnCredential

/**
 * The persistence slice this service uses. Injected (rather than importing
 * `./db` at every call site) so unit tests exercise the REAL ceremony crypto
 * against an in-memory store, with no operational.db anywhere near them —
 * exactly the shape {@link PasswordAuthProvider} established for the password
 * credential.
 */
export interface WebauthnCredentialStore {
  list(): WebauthnCredentialRow[]
  get(credId: string): WebauthnCredentialRow | null
  count(): number
  insert(cred: {
    credId: string
    publicKey: Uint8Array
    transports?: string[] | null
    nickname?: string | null
    backedUp?: boolean
    aaguid?: string | null
    signCount?: number
  }): void
  remove(credId: string): boolean
  touch(credId: string, update: { lastUsedAt: number; signCount: number; backedUp: boolean }): void
  rename(credId: string, nickname: string | null): boolean
}

/** The production store: the v11 `webauthn_credential` table. */
export function dbWebauthnCredentialStore(): WebauthnCredentialStore {
  return {
    list: () => listWebauthnCredentials(),
    get: (credId) => getWebauthnCredential(credId),
    count: () => countWebauthnCredentials(),
    insert: (cred) => insertWebauthnCredential(cred),
    remove: (credId) => deleteWebauthnCredential(credId),
    touch: (credId, update) => touchWebauthnCredential(credId, update),
    rename: (credId, nickname) => renameWebauthnCredential(credId, nickname)
  }
}

/** Why a ceremony failed. Coarse on purpose — see {@link WebauthnService}. */
export type WebauthnFailure =
  /** No live challenge for this (challenge, kind, connection) triple. */
  | 'challenge'
  /** The asserted credential id is not enrolled. */
  | 'unknown-credential'
  /** The library refused the response (signature, origin, RP ID, UV flag, …). */
  | 'verify'
  /** The frame did not carry a usable response object. */
  | 'malformed'

export type WebauthnAuthResult =
  | { ok: true; credential: WebauthnCredentialRow; backedUp: boolean }
  | { ok: false; reason: WebauthnFailure }

export type WebauthnRegisterResult =
  { ok: true; credId: string; backedUp: boolean } | { ok: false; reason: WebauthnFailure }

/**
 * Ceremony orchestration. Stateless apart from {@link ChallengeStore}, so the
 * process-wide singleton at the bottom is a convenience, not a lifecycle.
 */
export class WebauthnService {
  private readonly store: WebauthnCredentialStore
  readonly challenges = new ChallengeStore()

  constructor(store: WebauthnCredentialStore = dbWebauthnCredentialStore()) {
    this.store = store
  }

  /** Enrolled credential count — what AUTO policy resolution reads. */
  count(): number {
    return this.store.count()
  }

  /** Management projection. `publicKey` is deliberately absent. */
  credentials(): WebauthnCredentialSummary[] {
    return this.store.list().map((c) => ({
      credId: c.credId,
      nickname: c.nickname,
      createdAt: c.createdAt,
      lastUsedAt: c.lastUsedAt,
      backedUp: c.backedUp,
      transports: c.transports
    }))
  }

  rename(credId: string, nickname: string | null): boolean {
    return this.store.rename(credId, nickname)
  }

  revoke(credId: string): boolean {
    return this.store.remove(credId)
  }

  // -------------------------------------------------------------------------
  // Authentication (assertion)
  // -------------------------------------------------------------------------

  /**
   * Mint an assertion challenge, or `null` when there is nothing to assert
   * against (no credential enrolled).
   *
   * `allowCredentials` is left EMPTY: discoverable credentials mean the
   * authenticator resolves the passkey itself, and listing credential ids to an
   * unauthenticated socket would hand out a device inventory for free.
   */
  async startAuthentication(args: {
    origin: WebauthnOrigin
    connectionId: string
    kind: Extract<ChallengeKind, 'auth' | 'step-up'>
  }): Promise<PublicKeyCredentialRequestOptionsJSON | null> {
    if (this.store.count() === 0) return null
    const options = await generateAuthenticationOptions({
      rpID: args.origin.rpId,
      allowCredentials: [],
      userVerification: 'required',
      timeout: CEREMONY_TIMEOUT_MS
    })
    this.challenges.issue(options.challenge, args.kind, args.connectionId)
    return options
  }

  /**
   * Verify an assertion and, on success, record the post-use facts.
   *
   * The failure reason is coarse on the wire (the caller collapses everything to
   * one code) but specific in the DEBUG log: RP-ID drift after a machine or
   * tailnet rename is the expected field failure, and security.md accepts
   * re-enrollment as the remedy — so the operator needs to be able to SEE that
   * it was an origin mismatch rather than a broken authenticator.
   */
  async finishAuthentication(args: {
    origin: WebauthnOrigin
    connectionId: string
    kind: Extract<ChallengeKind, 'auth' | 'step-up'>
    assertion: AuthenticationResponseJSON
  }): Promise<WebauthnAuthResult> {
    const { assertion } = args
    if (!assertion || typeof assertion !== 'object' || typeof assertion.id !== 'string') {
      return { ok: false, reason: 'malformed' }
    }
    const challenge = readClientDataChallenge(assertion.response?.clientDataJSON)
    if (!challenge) return { ok: false, reason: 'malformed' }
    if (!this.challenges.consume(challenge, args.kind, args.connectionId)) {
      return { ok: false, reason: 'challenge' }
    }
    const credential = this.store.get(assertion.id)
    if (!credential) return { ok: false, reason: 'unknown-credential' }

    try {
      const verification = await verifyAuthenticationResponse({
        response: assertion,
        expectedChallenge: challenge,
        expectedOrigin: args.origin.origin,
        expectedRPID: args.origin.rpId,
        requireUserVerification: true,
        credential: {
          id: credential.credId,
          publicKey: toUint8Array(credential.publicKey),
          // ALWAYS 0 — NOT the stored counter. `verifyAuthenticationResponse`
          // throws "Response counter value X was lower than expected Y"
          // whenever either side is non-zero and the response does not advance,
          // and security.md is explicit that counters are RECORDED, NEVER
          // ENFORCED: a synced passkey (iCloud Keychain / Google Password
          // Manager) legitimately reports 0 from a second device forever, so
          // enforcing would lock out precisely the credentials this design is
          // built around. Feeding 0 disables the library's check (its guard is
          // `response > 0 || stored > 0`) while `newCounter` below is still
          // recorded for forensics.
          counter: 0,
          transports: credential.transports as AuthenticatorTransportFuture[] | undefined
        }
      })
      if (!verification.verified) return { ok: false, reason: 'verify' }
      const { newCounter, credentialBackedUp } = verification.authenticationInfo
      // Counter is RECORDED, never compared — see the file header.
      this.store.touch(credential.credId, {
        lastUsedAt: Date.now(),
        signCount: newCounter,
        backedUp: credentialBackedUp
      })
      return { ok: true, credential, backedUp: credentialBackedUp }
    } catch (err) {
      logger.debug(
        'webauthn',
        `assertion verify failed for rpId=${args.origin.rpId} origin=${args.origin.origin}: ${
          err instanceof Error ? err.message : String(err)
        }`
      )
      return { ok: false, reason: 'verify' }
    }
  }

  // -------------------------------------------------------------------------
  // Registration (attestation)
  // -------------------------------------------------------------------------

  /**
   * Mint a registration challenge.
   *
   * `excludeCredentials` lists every enrolled credential so an authenticator
   * that already holds one refuses to make a second — one device, one row.
   * Unlike the assertion path this disclosure is fine: the caller already holds
   * the `enroll` capability, which means it either authenticated with a passkey
   * or came in on a one-time enrollment token.
   */
  async startRegistration(args: {
    origin: WebauthnOrigin
    connectionId: string
  }): Promise<PublicKeyCredentialCreationOptionsJSON> {
    const existing = this.store.list()
    const options = await generateRegistrationOptions({
      rpName: RP_NAME,
      rpID: args.origin.rpId,
      userID: USER_HANDLE,
      userName: USER_NAME,
      userDisplayName: USER_DISPLAY_NAME,
      attestationType: 'none',
      timeout: CEREMONY_TIMEOUT_MS,
      excludeCredentials: existing.map((c) => ({
        id: c.credId,
        transports: (c.transports ?? undefined) as AuthenticatorTransportFuture[] | undefined
      })),
      authenticatorSelection: {
        residentKey: 'required',
        requireResidentKey: true,
        userVerification: 'required'
      }
    })
    this.challenges.issue(options.challenge, 'register', args.connectionId)
    return options
  }

  /** Verify an attestation and store the credential. */
  async finishRegistration(args: {
    origin: WebauthnOrigin
    connectionId: string
    response: RegistrationResponseJSON
    nickname?: string | null
  }): Promise<WebauthnRegisterResult> {
    const { response } = args
    if (!response || typeof response !== 'object' || typeof response.id !== 'string') {
      return { ok: false, reason: 'malformed' }
    }
    const challenge = readClientDataChallenge(response.response?.clientDataJSON)
    if (!challenge) return { ok: false, reason: 'malformed' }
    if (!this.challenges.consume(challenge, 'register', args.connectionId)) {
      return { ok: false, reason: 'challenge' }
    }

    try {
      const verification = await verifyRegistrationResponse({
        response,
        expectedChallenge: challenge,
        expectedOrigin: args.origin.origin,
        expectedRPID: args.origin.rpId,
        requireUserVerification: true
      })
      if (!verification.verified) return { ok: false, reason: 'verify' }
      const info = verification.registrationInfo
      this.store.insert({
        credId: info.credential.id,
        publicKey: info.credential.publicKey,
        transports: response.response.transports ?? null,
        nickname: normalizeNickname(args.nickname),
        backedUp: info.credentialBackedUp,
        aaguid: info.aaguid,
        signCount: info.credential.counter
      })
      return { ok: true, credId: info.credential.id, backedUp: info.credentialBackedUp }
    } catch (err) {
      logger.debug(
        'webauthn',
        `registration verify failed for rpId=${args.origin.rpId} origin=${args.origin.origin}: ${
          err instanceof Error ? err.message : String(err)
        }`
      )
      return { ok: false, reason: 'verify' }
    }
  }
}

/**
 * Nicknames are operator-supplied display text that lands in a list UI and in
 * audit labels — bound the length and strip control characters rather than
 * trusting it, and treat blank as "no nickname".
 */
export function normalizeNickname(raw: string | null | undefined): string | null {
  if (typeof raw !== 'string') return null
  const cleaned = raw
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .trim()
    .slice(0, 64)
  return cleaned === '' ? null : cleaned
}

/**
 * The `challenge` field of a base64url-encoded `clientDataJSON`.
 *
 * Read HERE, before verification, purely to look the challenge up in our own
 * store — the library re-reads and re-compares it against `expectedChallenge`,
 * so nothing about the trust decision rests on this parse. It is bounded and
 * total: any malformed input yields `null` rather than a throw.
 */
function readClientDataChallenge(clientDataJSONB64: string | undefined): string | null {
  if (typeof clientDataJSONB64 !== 'string' || clientDataJSONB64.length === 0) return null
  // Cap before decoding: a client picks this string's length.
  if (clientDataJSONB64.length > 8192) return null
  try {
    const json = Buffer.from(clientDataJSONB64, 'base64url').toString('utf-8')
    const parsed: unknown = JSON.parse(json)
    if (!parsed || typeof parsed !== 'object') return null
    const challenge = (parsed as { challenge?: unknown }).challenge
    return typeof challenge === 'string' && challenge.length > 0 ? challenge : null
  } catch {
    return null
  }
}

/**
 * `Buffer` IS a `Uint8Array`, but the library's `Uint8Array_` alias resolves to
 * `Uint8Array<ArrayBuffer>` while `Buffer.buffer` is only `ArrayBufferLike`.
 * `from` copies (these keys are ~80 bytes) and gives the exact backing type,
 * rather than casting a nominal mismatch away.
 */
function toUint8Array(buf: Buffer): Uint8Array<ArrayBuffer> {
  // `new Uint8Array(n)` is the only constructor form that is statically an
  // ArrayBuffer (not ArrayBufferLike) view, which is what the alias demands.
  const copy = new Uint8Array(buf.byteLength)
  copy.set(buf)
  return copy
}

/** The process-wide service. Reads the operational DB. */
export const webauthnService = new WebauthnService()
