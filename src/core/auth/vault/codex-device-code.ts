/**
 * codex-device-code.ts — the ChatGPT DEVICE-CODE sign-in (ADR-068 §3, Slice 7).
 *
 * Ported from Codex's own `codex-rs/login/src/device_code_auth.rs` (vendored at
 * `vendor/codex-src/`), against the SAME issuer and the SAME `CLIENT_ID` as the
 * loopback flow in `codex-oauth.ts`. The wire, verbatim from that file:
 *
 *   1. `POST {issuer}/api/accounts/deviceauth/usercode` `{client_id}` →
 *      `{device_auth_id, user_code|usercode, interval}`. A 404 means the server
 *      does not offer device code at all; any other non-2xx is a hard failure.
 *   2. The user opens `{issuer}/codex/device` and types the user code.
 *   3. `POST {issuer}/api/accounts/deviceauth/token` `{device_auth_id, user_code}`,
 *      polled every `interval` seconds. **403 and 404 mean "not yet"**; any other
 *      non-2xx fails at once; a 2xx returns
 *      `{authorization_code, code_verifier, code_challenge}` — note the verifier
 *      is SERVER-supplied here, unlike the loopback flow where we mint the PKCE
 *      pair ourselves. Capped at 15 minutes.
 *   4. The ordinary `authorization_code` exchange at `{issuer}/oauth/token` with
 *      `redirect_uri = {issuer}/deviceauth/callback` and that verifier — the same
 *      `exchangeCodeForTokens` the loopback path calls, so the two can never
 *      drift on grant shape or error handling.
 *
 * WHY IT EXISTS. ADR-057's paste-back already completes a ChatGPT sign-in from
 * any browser, but the step it asks for on a phone — copy a dead page's address
 * bar — is the one that hurts. Device code replaces it with "open this link,
 * type this code" while the host does the rest.
 *
 * TWO DELIBERATE DEPARTURES FROM THE RUST, both noted where they happen:
 *  - the poll interval is FLOORED at 1 s. Rust's `#[serde(default)]` on a
 *    missing `interval` yields `0`, which would busy-poll the token endpoint for
 *    fifteen minutes; and its `deserialize_interval` accepts only a JSON string,
 *    where we accept a number too.
 *  - the 15-minute deadline is anchored at `start()` (the usercode request), not
 *    at the first poll, so the `expiresAt` the UI counts down to is exactly the
 *    deadline the host enforces. The difference is one round-trip.
 *
 * SECURITY: `${issuer}/oauth/token` performs a REAL token exchange. No test in
 * this codebase may call it for real — `OAuthDeps.fetch` / `issuer`, `now` and
 * `sleep` are all injected so the unit suite drives every branch offline. See
 * `AuthVault.ts`'s header. Token material never leaves this module except as the
 * returned `VaultCredential`; `device_auth_id` never leaves it at all.
 */
import {
  CLIENT_ID,
  buildVaultCredential,
  exchangeCodeForTokens,
  ISSUER,
  type OAuthDeps,
  type PkceCodes,
  type VaultCredential
} from './codex-oauth'

// ---------------------------------------------------------------------------
// Constants (device_code_auth.rs)
// ---------------------------------------------------------------------------

/** `max_wait` in `poll_for_token` — the whole flow, request to credential. */
export const DEVICE_CODE_MAX_WAIT_MS = 15 * 60 * 1000

/**
 * Floor for the server-supplied poll interval. Rust defaults a MISSING interval
 * to `0`; honouring that literally would hammer `deviceauth/token` continuously
 * for the full fifteen minutes.
 */
export const DEVICE_CODE_MIN_INTERVAL_MS = 1_000

/** Set by `request_user_code` when the endpoint 404s — the server has device code turned off. */
export const DEVICE_CODE_UNSUPPORTED_MESSAGE =
  'device code login is not enabled for this Codex server. Use the browser login or verify the server URL.'

/** `poll_for_token`'s timeout message. */
export const DEVICE_CODE_TIMEOUT_MESSAGE = 'device auth timed out after 15 minutes'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Everything a CLIENT is told about a device-code flow. Deliberately does NOT
 * carry `device_auth_id`: the host holds it and polls with it, and a client that
 * cannot see it cannot be tricked into completing someone else's flow.
 *
 * Structurally mirrored by `VendorDeviceCodeStart` in `shared/types.ts` (the IPC
 * shape); `PiAuthProvider.deviceCodeStart` returns the latter, so the compiler
 * pins the two together without this module importing the renderer's types.
 */
export interface DeviceCodeStart {
  /** The page the user opens — `{issuer}/codex/device`. */
  verificationUrl: string
  /** The short code the user types there. Display material, not a secret. */
  userCode: string
  /** Wall-clock ms after which the host stops polling (`start()` + 15 min). */
  expiresAt: number
}

/** What `AuthVault` needs from a device-code flow. `CodexDeviceCodeFlow` implements it; tests fake it. */
export interface DeviceCodeFlowLike {
  start(): Promise<DeviceCodeStart>
  waitForCompletion(): Promise<VaultCredential>
  cancel(): void
  /** True once started AND terminal — lets the vault supersede a zombie flow (see `AuthVault.beginLogin`). */
  isSettled?(): boolean
}

/**
 * Thrown by `waitForCompletion()` when `cancel()` won the race. A distinct type
 * (rather than a message match) so the store can tell "the user pressed Cancel"
 * apart from "the flow failed" and skip the error card.
 */
export class DeviceCodeCancelledError extends Error {
  readonly cancelled = true
  constructor(message = 'Login cancelled') {
    super(message)
    this.name = 'DeviceCodeCancelledError'
  }
}

/** True for the cancellation this module throws — structural, so it survives an IPC round-trip of the message. */
export function isDeviceCodeCancellation(err: unknown): boolean {
  if (err instanceof DeviceCodeCancelledError) return true
  return err instanceof Error && /login cancelled/i.test(err.message)
}

export interface CodexDeviceCodeFlowOptions {
  /** Injectable fetch/issuer. Defaults to the real auth.openai.com — never in a test. */
  deps?: OAuthDeps
  /** Clock for the deadline and the credential's `expires`. Defaults to Date.now. */
  now?: () => number
  /** Abortable sleep between polls. Defaults to a real timer; tests pass a fake. */
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>
  /** Overall cap. Defaults to {@link DEVICE_CODE_MAX_WAIT_MS}; tests shorten it. */
  maxWaitMs?: number
}

/** `UserCodeResp` — the fields we read; `interval` may be a number, a string, or absent. */
interface UserCodeResponse {
  device_auth_id?: unknown
  user_code?: unknown
  usercode?: unknown
  interval?: unknown
}

/** `CodeSuccessResp` — a 2xx from `deviceauth/token`. */
interface CodeSuccessResponse {
  authorization_code?: unknown
  code_verifier?: unknown
  code_challenge?: unknown
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** `opts.issuer.trim_end_matches('/')` — every device-auth path hangs off this. */
function trimBase(issuer: string): string {
  return issuer.replace(/\/+$/, '')
}

/**
 * `deserialize_interval` + the floor. Rust parses a trimmed JSON STRING and
 * defaults a missing field to `0`; we also accept a number (servers do send
 * one), and clamp the result up to {@link DEVICE_CODE_MIN_INTERVAL_MS} so a
 * `0`/absent/garbage interval cannot turn the poll into a hot loop.
 */
export function parsePollIntervalMs(raw: unknown): number {
  let seconds = 0
  if (typeof raw === 'number' && Number.isFinite(raw)) seconds = raw
  else if (typeof raw === 'string') {
    const parsed = Number.parseInt(raw.trim(), 10)
    if (Number.isFinite(parsed)) seconds = parsed
  }
  return Math.max(DEVICE_CODE_MIN_INTERVAL_MS, seconds * 1000)
}

/** Real abortable sleep; rejects with the cancellation if the signal fires first. */
function defaultSleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.reject(new DeviceCodeCancelledError())
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    function onAbort(): void {
      clearTimeout(timer)
      reject(new DeviceCodeCancelledError())
    }
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

// ---------------------------------------------------------------------------
// CodexDeviceCodeFlow — one flow object per sign-in attempt.
// ---------------------------------------------------------------------------

/**
 * Drives usercode → poll → exchange for exactly one attempt. Like
 * `CodexLoginFlow` this holds NO module-level state, so every attempt (and every
 * test) is isolated.
 *
 * `waitForCompletion()` is idempotent — it memoizes the one run — so the vault
 * can await it once while `cancel()` races it from the IPC side.
 */
export class CodexDeviceCodeFlow implements DeviceCodeFlowLike {
  private readonly deps: OAuthDeps
  private readonly now: () => number
  private readonly sleepFn: (ms: number, signal?: AbortSignal) => Promise<void>
  private readonly maxWaitMs: number

  private readonly controller = new AbortController()
  private started = false
  private settled = false
  private cancelled = false
  private deviceAuthId: string | undefined
  private userCode: string | undefined
  private intervalMs = DEVICE_CODE_MIN_INTERVAL_MS
  private deadline = 0
  private pending: Promise<VaultCredential> | undefined

  constructor(options: CodexDeviceCodeFlowOptions = {}) {
    this.deps = options.deps ?? { fetch, issuer: ISSUER }
    this.now = options.now ?? ((): number => Date.now())
    this.sleepFn = options.sleep ?? defaultSleep
    this.maxWaitMs = options.maxWaitMs ?? DEVICE_CODE_MAX_WAIT_MS
  }

  private get base(): string {
    return trimBase(this.deps.issuer)
  }

  /**
   * `request_device_code` — ask for a user code and arm the deadline. Throws
   * {@link DEVICE_CODE_UNSUPPORTED_MESSAGE} on a 404 (the endpoint is not there)
   * and a status-bearing error otherwise, exactly as the Rust does.
   */
  async start(): Promise<DeviceCodeStart> {
    if (this.started) throw new Error('CodexDeviceCodeFlow: start() was already called')
    this.started = true
    let response: Response
    try {
      response = await this.deps.fetch(`${this.base}/api/accounts/deviceauth/usercode`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ client_id: CLIENT_ID }),
        signal: this.controller.signal
      })
    } catch (err) {
      this.settled = true
      throw this.cancelled ? new DeviceCodeCancelledError() : toError(err)
    }
    if (!response.ok) {
      this.settled = true
      if (response.status === 404) throw new Error(DEVICE_CODE_UNSUPPORTED_MESSAGE)
      throw new Error(`device code request failed with status ${response.status}`)
    }
    const body = (await response.json()) as UserCodeResponse
    const deviceAuthId = asString(body.device_auth_id)
    // `#[serde(alias = "usercode")]` — the server has shipped both spellings.
    const userCode = asString(body.user_code) ?? asString(body.usercode)
    if (!deviceAuthId || !userCode) {
      this.settled = true
      throw new Error('device code request returned no user code')
    }
    this.deviceAuthId = deviceAuthId
    this.userCode = userCode
    this.intervalMs = parsePollIntervalMs(body.interval)
    const expiresAt = this.now() + this.maxWaitMs
    this.deadline = expiresAt
    return { verificationUrl: `${this.base}/codex/device`, userCode, expiresAt }
  }

  /** `complete_device_code_login` — poll, then exchange. Memoized; safe to await once. */
  waitForCompletion(): Promise<VaultCredential> {
    if (!this.started) {
      throw new Error('CodexDeviceCodeFlow: call start() before waitForCompletion()')
    }
    if (!this.pending) {
      // RACED against cancellation rather than relying on the poll loop noticing.
      // `AuthVault.claimLoginSlot` cancels a live device flow and moves on, so a
      // cancel that does not settle this promise would leave a zombie poller
      // hitting the token endpoint every few seconds for the rest of the
      // fifteen minutes. The loop's own `throwIfCancelled()` still stops it at
      // the next step; this guarantees the CALLER is settled at once, whatever
      // an injected fetch or sleep does with the abort signal.
      //
      // The flag flips INSIDE the returned promise's own chain, not in a
      // detached `.finally`: `isSettled()` has to already be true by the time
      // the awaiting caller resumes, or the vault would see a live flow.
      this.pending = Promise.race([this.run(), this.cancellation()]).then(
        (cred) => {
          this.settled = true
          return cred
        },
        (err: unknown) => {
          this.settled = true
          throw err
        }
      )
      // A device flow can be cancelled with nobody awaiting it (the renderer
      // reloaded); keep that from surfacing as an unhandled rejection.
      void this.pending.catch(() => {})
    }
    return this.pending
  }

  /**
   * True once started AND terminal. `cancel()` marks it immediately (even with
   * nobody awaiting the run) so `AuthVault.beginLogin` can supersede an
   * abandoned device flow rather than reporting "a login is already in progress"
   * forever.
   */
  isSettled(): boolean {
    return this.started && this.settled
  }

  /** Abort the in-flight fetch AND the sleep; a pending `waitForCompletion()` rejects with the cancellation. */
  cancel(): void {
    this.cancelled = true
    this.settled = true
    this.controller.abort()
  }

  /** Rejects the moment `cancel()` aborts; never resolves. */
  private cancellation(): Promise<never> {
    return new Promise<never>((_resolve, reject) => {
      const signal = this.controller.signal
      if (signal.aborted) {
        reject(new DeviceCodeCancelledError())
        return
      }
      signal.addEventListener('abort', () => reject(new DeviceCodeCancelledError()), { once: true })
    })
  }

  private async run(): Promise<VaultCredential> {
    const code = await this.poll()
    this.throwIfCancelled()
    const pkce: PkceCodes = { verifier: code.verifier, challenge: code.challenge }
    // The SERVER minted this PKCE pair, and the redirect_uri it bound the code
    // to is its own `deviceauth/callback` — neither is ours to choose.
    const tokens = await exchangeCodeForTokens(
      code.authorizationCode,
      `${this.base}/deviceauth/callback`,
      pkce,
      this.deps
    )
    return buildVaultCredential(tokens, this.now)
  }

  /** `poll_for_token`. 403/404 → not yet; anything else non-2xx → fail now. */
  private async poll(): Promise<{
    authorizationCode: string
    verifier: string
    challenge: string
  }> {
    const url = `${this.base}/api/accounts/deviceauth/token`
    for (;;) {
      this.throwIfCancelled()
      let response: Response
      try {
        response = await this.deps.fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            device_auth_id: this.deviceAuthId,
            user_code: this.userCode
          }),
          signal: this.controller.signal
        })
      } catch (err) {
        throw this.cancelled ? new DeviceCodeCancelledError() : toError(err)
      }

      if (response.ok) {
        const body = (await response.json()) as CodeSuccessResponse
        const authorizationCode = asString(body.authorization_code)
        const verifier = asString(body.code_verifier)
        const challenge = asString(body.code_challenge)
        if (!authorizationCode || !verifier) {
          throw new Error('device auth returned no authorization code')
        }
        return { authorizationCode, verifier, challenge: challenge ?? '' }
      }

      if (response.status !== 403 && response.status !== 404) {
        throw new Error(`device auth failed with status ${response.status}`)
      }

      // 403/404 = the user has not entered the code yet.
      const remaining = this.deadline - this.now()
      if (remaining <= 0) throw new Error(DEVICE_CODE_TIMEOUT_MESSAGE)
      await this.sleepFn(Math.min(this.intervalMs, remaining), this.controller.signal)
    }
  }

  private throwIfCancelled(): void {
    if (this.cancelled) throw new DeviceCodeCancelledError()
  }
}

function toError(err: unknown): Error {
  return err instanceof Error ? err : new Error(String(err))
}
