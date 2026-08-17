/**
 * @vitest-environment node
 *
 * Unit tests for AccountManager (ADR-015).
 *
 * Strategy: mock the heavy collaborators (service-session, auth-manager,
 * logger, electron) and point os.homedir() at a tmp dir so accounts live in a
 * scratch area. securestorage-env is used REAL so we can assert the active
 * account dir actually gets wired into the spawn env.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'

const hoisted = vi.hoisted(() => {
  const realFs = require('fs') as typeof import('fs')
  const realOs = require('os') as typeof import('os')
  const realPath = require('path') as typeof import('path')
  const home = realFs.mkdtempSync(realPath.join(realOs.tmpdir(), 'claudeui-acct-test-'))
  return { TEST_HOME: home, loginCb: { current: null as null | ((a: unknown) => void) } }
})

vi.mock('node:os', async () => {
  const actual = await vi.importActual<typeof import('os')>('os')
  return {
    ...actual,
    default: { ...actual, homedir: () => hoisted.TEST_HOME },
    homedir: () => hoisted.TEST_HOME
  }
})
vi.mock('electron', async () => await import('../../../test/stubs/electron-shim'))
vi.mock('../service-session', () => ({ serviceSession: { stop: vi.fn() } }))
vi.mock('../auth-manager', () => ({
  authManager: {
    onLoginSuccess: vi.fn((cb: (a: unknown) => void) => {
      hoisted.loginCb.current = cb
    }),
    // Returns a promise so the fire-and-forget `void signIn().catch(...)` in
    // addAccount() has something to attach to (prod signIn is always async).
    signIn: vi.fn(async () => {})
  }
}))
vi.mock('../../../core/services/logger', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }
}))

import { accountManager } from '../account-manager'
import { setLiveSessionCanceller } from '../session-invalidation'
import { getSecurestorageEnv } from '../../../core/sdk/securestorage-env'
import { serviceSession } from '../service-session'
import { authManager } from '../auth-manager'
import { logger } from '../../../core/services/logger'

const ACCOUNTS_DIR = path.join(hoisted.TEST_HOME, '.claude', 'ui', 'accounts')

function makeWindow(): { sent: Array<[string, unknown]>; win: any } {
  const sent: Array<[string, unknown]> = []
  return {
    sent,
    win: {
      isDestroyed: () => false,
      webContents: { send: (ch: string, data: unknown) => sent.push([ch, data]) }
    }
  }
}

describe('AccountManager', () => {
  let sent: Array<[string, unknown]>

  beforeEach(() => {
    vi.clearAllMocks()
    fs.rmSync(ACCOUNTS_DIR, { recursive: true, force: true })
    const w = makeWindow()
    sent = w.sent
    accountManager.init(w.win) // reloads (now-empty) state from disk
  })

  it('registers a login-success listener on init', () => {
    expect(authManager.onLoginSuccess).toHaveBeenCalled()
    expect(typeof hoisted.loginCb.current).toBe('function')
  })

  it('enabling with no accounts seeds one and wires its dir into the spawn env', async () => {
    const state = await accountManager.setEnabled(true)
    expect(state.enabled).toBe(true)
    expect(state.accounts).toHaveLength(1)
    expect(state.activeId).toBe(state.accounts[0].id)

    const ss = getSecurestorageEnv()
    expect(ss?.dir).toBe(path.join(ACCOUNTS_DIR, state.activeId!))
    expect(fs.existsSync(ss!.dir)).toBe(true)
    expect(serviceSession.stop).toHaveBeenCalled()
    expect(sent.some(([ch]) => ch === 'account:changed')).toBe(true)
  })

  it('disabling clears the securestorage env (back to Keychain mode)', async () => {
    await accountManager.setEnabled(true)
    expect(getSecurestorageEnv()).not.toBeNull()
    await accountManager.setEnabled(false)
    expect(getSecurestorageEnv()).toBeNull()
  })

  it('addAccount creates a new active account and starts its login', async () => {
    await accountManager.setEnabled(true)
    const before = accountManager.getState().accounts.length
    const state = await accountManager.addAccount()
    expect(state.accounts.length).toBe(before + 1)
    const active = state.accounts.find((a) => a.id === state.activeId)!
    expect(active.id).toBe(state.accounts[state.accounts.length - 1].id)
    expect(getSecurestorageEnv()?.dir).toBe(path.join(ACCOUNTS_DIR, state.activeId!))
    expect(authManager.signIn).toHaveBeenCalled()
  })

  it('a failing login start on addAccount is caught (no unhandled rejection) and logged', async () => {
    ;(authManager.signIn as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new Error('service session down')
    )
    await accountManager.setEnabled(true)
    await accountManager.addAccount()
    // Flush the fire-and-forget catch.
    await new Promise((r) => setTimeout(r, 0))
    expect(logger.error).toHaveBeenCalled()
  })

  it('switchAccount changes active + env + requests session respawn', async () => {
    await accountManager.setEnabled(true)
    const first = accountManager.getState().accounts[0].id
    await accountManager.addAccount() // active is now the second
    sent.length = 0
    const state = await accountManager.switchAccount(first)
    expect(state.activeId).toBe(first)
    expect(getSecurestorageEnv()?.dir).toBe(path.join(ACCOUNTS_DIR, first))
    expect(sent.some(([ch]) => ch === 'account:respawn-sessions')).toBe(true)
  })

  /**
   * F5. The respawn broadcast above is a REQUEST to one renderer; it never
   * stopped the processes holding the old account's credential, and no other
   * client heard about the switch at all. Cancelling main-side is what makes the
   * `disconnected` status (→ `sdkActive: false` in canonical and in every
   * replica) happen.
   *
   * PRE-FIX: `cancelled` stays empty — nothing main-side reacted to a switch.
   */
  it('switching accounts cancels every live session MAIN-side', async () => {
    const cancelled: string[] = []
    setLiveSessionCanceller(() => cancelled.push('cancelAll'))
    try {
      await accountManager.setEnabled(true)
      const first = accountManager.getState().accounts[0].id
      await accountManager.addAccount()
      cancelled.length = 0
      await accountManager.switchAccount(first)
      expect(cancelled).toEqual(['cancelAll'])
    } finally {
      setLiveSessionCanceller(null)
    }
  })

  /** A windowless boot (or a not-yet-wired one) must not throw on a switch. */
  it('an unwired canceller is a no-op, not a throw', async () => {
    setLiveSessionCanceller(null)
    await expect(accountManager.setEnabled(true)).resolves.toBeDefined()
  })

  /**
   * R4. `persistAndApply` is the common tail of four different mutations, and
   * only some of them move the EFFECTIVE credential dir. Deleting an account the
   * user is not signed in as changes nothing a running process reads — cancelling
   * there destroys live turns for a settings-list edit the user does not connect
   * to their sessions.
   */
  it('deleting a NON-active account does not cancel anything', async () => {
    const cancelled: string[] = []
    setLiveSessionCanceller(() => cancelled.push('cancel'))
    try {
      await accountManager.setEnabled(true)
      await accountManager.addAccount() // second account is now active
      const inactive = accountManager
        .getState()
        .accounts.find((a) => a.id !== accountManager.getState().activeId)!
      cancelled.length = 0
      sent.length = 0

      await accountManager.deleteAccount(inactive.id)

      expect(cancelled).toEqual([])
      // …and the renderer is not asked to respawn either: nothing changed for it.
      expect(sent.some(([ch]) => ch === 'account:respawn-sessions')).toBe(false)
      // The account list itself still changed, so the state broadcast still goes.
      expect(sent.some(([ch]) => ch === 'account:changed')).toBe(true)
    } finally {
      setLiveSessionCanceller(null)
    }
  })

  it('deleting the ACTIVE account does cancel (the dir really moves)', async () => {
    const cancelled: string[] = []
    setLiveSessionCanceller(() => cancelled.push('cancel'))
    try {
      await accountManager.setEnabled(true)
      await accountManager.addAccount()
      const activeId = accountManager.getState().activeId!
      cancelled.length = 0

      await accountManager.deleteAccount(activeId)

      expect(cancelled).toEqual(['cancel'])
    } finally {
      setLiveSessionCanceller(null)
    }
  })

  it('deleteAccount removes the dir and reassigns active', async () => {
    await accountManager.setEnabled(true)
    await accountManager.addAccount()
    const state0 = accountManager.getState()
    const activeId = state0.activeId!
    const activeDir = path.join(ACCOUNTS_DIR, activeId)
    expect(fs.existsSync(activeDir)).toBe(true)

    const state = await accountManager.deleteAccount(activeId)
    expect(state.accounts.some((a) => a.id === activeId)).toBe(false)
    expect(fs.existsSync(activeDir)).toBe(false)
    expect(state.activeId).not.toBe(activeId)
    expect(state.activeId).toBe(state.accounts[0]?.id ?? null)
  })

  it('a successful login stamps the active account email', async () => {
    await accountManager.setEnabled(true)
    const activeId = accountManager.getState().activeId
    // Invoke the captured onLoginSuccess callback as auth-manager would.
    hoisted.loginCb.current?.({
      email: 'user@example.com',
      subscriptionType: 'max',
      organization: 'Org'
    })
    const acc = accountManager.getState().accounts.find((a) => a.id === activeId)!
    expect(acc.email).toBe('user@example.com')
    expect(acc.subscriptionType).toBe('max')
  })
})
