/**
 * EngineAuthProvider — per-engine auth abstraction (ADR-021 / Phase 4 + 5c update).
 *
 * One implementation per engine. Capability-gated:
 *   - signIn/submitCode/cancelSignIn → capabilities.auth.canDriveLogin
 *   - addAccount/switchAccount/deleteAccount → capabilities.auth.multiAccount
 *   - listVendorAuthOptions/setVendorApiKey/oauthAuthorize/oauthCallback/removeVendorAuth
 *     → capabilities.auth.canDriveLogin (multi-vendor engines like opencode)
 *
 * Claude's implementation (ClaudeAuthProvider) wraps the existing AuthManager +
 * AccountManager unchanged — no behavior change for Claude.
 *
 * ADR-021 update (Phase 5c): added per-vendor auth methods for multi-vendor engines
 * (opencode). Claude does NOT implement these; they are optional and gated.
 */

import type { VendorId, VendorAuthMap, VendorAuthOption, AuthFlowState, AccountsState } from '../../shared/types'

export interface EngineAuthProvider {
  /** Probe all vendors for this engine. Always available. */
  probe(): Promise<VendorAuthMap>

  // --- Driven login (capabilities.auth.canDriveLogin) ---
  signIn?(vendorId?: VendorId): Promise<AuthFlowState>
  submitCode?(code: string): Promise<AuthFlowState>
  cancelSignIn?(): Promise<void>

  // --- Multi-account (capabilities.auth.multiAccount) ---
  addAccount?(): Promise<AccountsState>
  switchAccount?(id: string): Promise<AccountsState>
  deleteAccount?(id: string): Promise<AccountsState>

  // --- Per-vendor auth (multi-vendor engines like opencode; canDriveLogin) ---

  /** GET /provider/auth — the auth-option catalog per vendor. */
  listVendorAuthOptions?(): Promise<Record<VendorId, VendorAuthOption[]>>

  /** PUT /auth/{vendorId} {type:'api', key} — store an API key for a vendor. */
  setVendorApiKey?(vendorId: VendorId, key: string): Promise<void>

  /**
   * Which vendor ids have stored credentials, read from the engine's own auth
   * store. READ-ONLY: returns only ids + credential kind, never key material.
   */
  listVendorCredentialIds?(): Promise<Record<VendorId, 'api' | 'oauth'>>

  /**
   * POST /provider/{vendorId}/oauth/authorize — start an OAuth flow.
   * Returns the URL to open plus instructions for the user.
   */
  oauthAuthorize?(
    vendorId: VendorId,
    method: number,
    inputs?: Record<string, string>
  ): Promise<{ url: string; method: 'auto' | 'code'; instructions: string }>

  /**
   * POST /provider/{vendorId}/oauth/callback — submit the paste code.
   * Returns true on success.
   */
  oauthCallback?(vendorId: VendorId, method: number, code?: string): Promise<boolean>

  /** DELETE /auth/{vendorId} — remove credentials for a vendor. */
  removeVendorAuth?(vendorId: VendorId): Promise<void>

  /**
   * Abandon an in-flight OAuth flow started via oauthAuthorize, releasing any
   * resources held open across the authorize → callback handshake (e.g. the
   * server process hosting the loopback redirect). Safe to call with no active
   * flow.
   */
  cancelVendorOauth?(): Promise<void>
}
