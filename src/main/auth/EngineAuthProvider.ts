/**
 * EngineAuthProvider — per-engine auth abstraction (ADR-021 / Phase 4).
 *
 * One implementation per engine. Capability-gated:
 *   - signIn/submitCode/cancelSignIn → capabilities.auth.canDriveLogin
 *   - addAccount/switchAccount/deleteAccount → capabilities.auth.multiAccount
 *
 * Claude's implementation (ClaudeAuthProvider) wraps the existing AuthManager +
 * AccountManager unchanged — no behavior change for Claude.
 */

import type { VendorId, VendorAuthMap, AuthFlowState, AccountsState } from '../../shared/types'

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
}
