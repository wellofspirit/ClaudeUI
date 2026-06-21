/**
 * @vitest-environment node
 *
 * Verify the AuthState → AuthFlowState rename is complete.
 * This test imports the shared types and confirms:
 *  - AuthFlowState is the login-flow object (has status/account/error fields)
 *  - AuthState is the tri-state string union
 *  - AccountRef.authState uses AuthState (tri-state)
 *  - SessionStatus.account is AccountRef | null
 */
import { describe, it, expect } from 'vitest'
import type { AuthFlowState, AuthState, AccountRef, SessionStatus } from '../../../shared/types'

describe('AuthState → AuthFlowState rename (Phase 4)', () => {
  it('AuthFlowState is the login-flow object with status/account/error', () => {
    const flow: AuthFlowState = {
      status: 'idle',
      account: null,
      error: null
    }
    expect(flow.status).toBe('idle')
    expect(flow.account).toBeNull()
    expect(flow.error).toBeNull()
  })

  it('AuthFlowState covers all login-flow statuses', () => {
    const statuses: AuthFlowState['status'][] = ['idle', 'authorizing', 'success', 'error']
    expect(statuses).toHaveLength(4)
  })

  it('AuthState is the resolved tri-state string union', () => {
    const states: AuthState[] = ['authenticated', 'unauthenticated', 'unknown']
    expect(states).toHaveLength(3)
  })

  it('AccountRef.authState uses the AuthState tri-state type', () => {
    const ref: AccountRef = {
      engineId: 'claude',
      vendorId: 'anthropic',
      billingType: 'subscription',
      authState: 'authenticated', // must accept tri-state, not old login-flow object
      label: 'user@example.com'
    }
    expect(ref.authState).toBe('authenticated')
  })

  it('SessionStatus.account is AccountRef | null', () => {
    // Type-level: confirm the shape compiles.
    const status: Pick<SessionStatus, 'account'> = { account: null }
    expect(status.account).toBeNull()

    const statusWithAccount: Pick<SessionStatus, 'account'> = {
      account: {
        engineId: 'claude',
        vendorId: 'anthropic',
        billingType: 'subscription',
        authState: 'authenticated',
        label: 'user@example.com',
        accountId: 'acct-123'
      }
    }
    expect(statusWithAccount.account?.authState).toBe('authenticated')
  })
})
