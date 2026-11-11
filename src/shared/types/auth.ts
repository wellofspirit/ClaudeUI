import type { SharedProviderAccountStatus } from '../shared-provider'
import type { BillingType, EngineId, VendorId } from './engine'

/**
 * Resolved tri-state auth status for a single (engine, vendor) pair.
 * 'authenticated'   — engine has confirmed valid credentials
 * 'unauthenticated' — engine has confirmed no / expired credentials
 * 'unknown'         — not yet probed (e.g. first render before init completes)
 */
export type AuthState = 'authenticated' | 'unauthenticated' | 'unknown'

/** Per-(engine, vendor) auth probe result.  Used by EngineAuthProvider.probe(). */
export interface AuthStatus {
  authState: AuthState
  billingType: BillingType
  label?: string // email / org / 'ChatGPT Plus'
  requiresLogin?: boolean // delegated engines: "run <engine> login"
  notInstalled?: boolean
  error?: string
}

/** Map from VendorId string to its auth status; returned by EngineAuthProvider.probe().
 *  Engines only include vendors they know about (Claude: { anthropic: ... };
 *  opencode: one entry per configured provider). */
export type VendorAuthMap = Record<string, AuthStatus>

/**
 * A single auth method option for a vendor, as returned by GET /provider/auth.
 * The array index of the option is the `method` arg for OAuth authorize/callback.
 */
export interface VendorAuthOption {
  type: 'api' | 'oauth'
  label: string
  prompts?: Array<{ type: string; key: string; message: string; secret?: boolean }>
}

/**
 * Read-only snapshot of the M6a/M6b auth vault's ChatGPT credential —
 * CredentialSync.getStatus(). Drives PiVendors.tsx's (M6c) "Connect ChatGPT"
 * UI. NEVER carries token material (access/refresh).
 */
export interface PiAuthStatus {
  connected: boolean
  email?: string
  accountId?: string
  expiresAt?: number
  needsReauth: boolean
  /** Every stored ChatGPT account (ADR-068 §2) — ids, emails, plans, expiries. */
  accounts: SharedProviderAccountStatus[]
  /** Which of them the engines are vended, or null when there is none. */
  activeId: string | null
}

/** Resolved account descriptor held on the session. Populated by ClaudeAuthProvider.probe(). */
export interface AccountRef {
  engineId: EngineId
  vendorId: VendorId
  billingType: BillingType
  authState: AuthState
  label?: string
  accountId?: string
}

/**
 * What a device-code sign-in tells the CLIENT (ADR-068 §3, Slice 7). Everything
 * here is display material: the page to open, the code to type, and when the
 * host stops polling. The `device_auth_id` the host polls with never crosses the
 * wire. Structurally mirrored by `DeviceCodeStart` in
 * `core/auth/vault/chatgpt-device-code.ts`, which owns the flow.
 */
export interface VendorDeviceCodeStart {
  verificationUrl: string
  userCode: string
  /** Wall-clock ms (host clock) at which the flow expires — 15 minutes after it started. */
  expiresAt: number
}

/**
 * Where a started device-code sign-in has got to (ADR-068 §3, Slice 7).
 *
 * The WAIT is host-owned: `vendor-auth:device-code-start` kicks the poll off in
 * the background and the client asks this question every few seconds, rather
 * than holding one long invoke open. It has to work that way on the web —
 * `web/connection.ts` caps every invoke at 30 s (`INVOKE_TIMEOUT_MS`) and a
 * device code lives for fifteen minutes — and it also survives a reconnect,
 * because the host, not the socket, is holding the outcome.
 *
 * `error` carries the host's own message; the other three carry nothing.
 * `cancelled` is also the answer when NO flow is live, so a client that missed
 * the cancellation stops polling instead of waiting forever.
 */
export interface VendorDeviceCodeStatus {
  state: 'pending' | 'done' | 'error' | 'cancelled'
  error?: string
}

// ---------------------------------------------------------------------------
// Native Anthropic OAuth (subscription "Log in with Claude") — see ADR-014
// ---------------------------------------------------------------------------

/** Account info returned by cli.js after a successful OAuth token exchange. */
export interface OAuthAccount {
  email: string | null
  organization: string | null
  subscriptionType: string | null // e.g. "max", "pro"
  tokenSource?: string | null
  apiKeySource?: string | null
  apiProvider?: string | null
}

// --- Multiple-account support (ADR-015) ---

export interface AccountInfo {
  id: string
  email: string | null
  subscriptionType: string | null
  organization: string | null
  createdAt: number
  /**
   * The identity the account was last seen with WHILE ACTIVE (ADR-071 §6).
   *
   * `~/.claude.json` describes the active account only, so an account that is
   * not active has nothing left to read its key off — these four are how the
   * limits provider can still name a stored account it is only reading
   * credentials for. Absent on an account that has not been active since this
   * shipped; such an account's readings land under `unknown`.
   */
  accountUuid?: string | null
  organizationUuid?: string | null
  organizationName?: string | null
  billingType?: BillingType | null
  /**
   * When those four were last read out of THIS account's own credential (S2e).
   *
   * Null means never. A credentials file whose mtime is newer says the account
   * was signed in again since, so the identity is re-read on the next refresh
   * the user asks for — the four columns are otherwise trusted as they stand,
   * because re-reading them spends a refresh grant (ADR-071 §6).
   */
  identityCheckedAt?: number | null
}

export interface AccountsState {
  /** Multi-account mode (app-owned per-account credential files, ADR-015). */
  enabled: boolean
  activeId: string | null
  accounts: AccountInfo[]
  /**
   * The login `account:add` just started, echoed back on the RESPONSE only
   * (ADR-057 / S4-UI).
   *
   * `addAccount` creates the account and kicks off a sign-in whose `manualUrl`
   * a remote client needs in order to render the paste-back flow. That URL used
   * to exist only on the `auth:state` event, which is `host-local` — so a remote
   * add-account started a flow the caller could never see.
   *
   * Delivering it here rather than widening `auth:state`'s delivery is
   * deliberate: an in-flight OAuth flow belongs to the ONE client that started
   * it, and `manualUrl` carries that flow's `state` (its CSRF token). Fanning it
   * out would let any other admitted client finish someone else's sign-in with
   * their own account. `auth:sign-in` already returns its state to its caller
   * for the same reason; this makes `account:add` consistent with it.
   *
   * Present ONLY on the value returned by a REMOTE `account:add`. Never
   * persisted, never on `account:changed`, never on `account:get`.
   */
  pendingSignIn?: AuthFlowState
}

export type AuthFlowStatus = 'idle' | 'authorizing' | 'success' | 'error'

/**
 * Broadcast to the renderer on every transition of the native login flow (ADR-014).
 * Renamed from AuthState in Phase 4 to free that name for the resolved tri-state.
 */
export interface AuthFlowState {
  status: AuthFlowStatus
  account: OAuthAccount | null
  error: string | null
  /**
   * The claude.ai URL to open in ANY browser for a REMOTE-initiated sign-in
   * (ADR-057): the host does not open a browser on itself, so the remote UI
   * shows this URL, the user consents anywhere, claude.ai displays a code, and
   * `auth:submit-code` completes the exchange host-side. Absent on the desktop
   * path, which opens the host browser directly (byte-identical to before).
   */
  manualUrl?: string
}
