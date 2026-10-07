/**
 * @vitest-environment node
 *
 * CredentialSync's opencode 2.x lifecycle (ADR-097 §5): the vend at start, the
 * pre-turn gate, the `provider.auth` recovery, the resume resync, the slot
 * handed back on quit, and the token check that recognises ClaudeUI's own
 * sign-in. The vault is in memory, every refresh is an injected fake (nothing
 * reaches auth.openai.com), and opencode is a spy target or the real credential
 * store over an in-memory table.
 */
import { describe, expect, it, vi } from 'vitest'
import {
  CredentialSync,
  OPENCODE_AUTH_RECOVERY_COOLDOWN_MS,
  REFRESH_MARGIN_MS,
  type VaultLike
} from '../../../../core/auth/vault/CredentialSync'
import type { TokenResponse, VaultCredential } from '../../../../core/auth/vault/codex-oauth'
import { memoryFedTokenHistory } from '../../../../core/auth/vault/fed-token-history'
import { fakeOpencodeTarget, storeBackedOpencode } from './fixtures/fake-opencode-target'
import { logger } from '../../../../core/services/logger'

const b64url = (value: object) => Buffer.from(JSON.stringify(value)).toString('base64url')
/** A fake, unsigned JWT with only an `exp` (and an account claim). */
const jwt = (expSeconds: number, tag: string) =>
  `${b64url({ alg: 'none' })}.${b64url({
    'https://api.openai.com/auth': { chatgpt_account_id: 'acct-1' },
    exp: expSeconds,
    tag
  })}.fake-${tag}`

const NOW = 1_800_000_000_000
const MIN = 60_000

function vaultWith(initial: VaultCredential | null) {
  const state = { current: initial }
  const vault: VaultLike = {
    load: async () => state.current,
    save: async (cred) => void (state.current = cred),
    removeCredential: async () => void (state.current = null),
    hasUnreadableLegacyVault: () => false,
    beginLogin: async () => ({ authorizeUrl: 'https://auth.invalid/authorize' }),
    completeLogin: async () => {
      throw new Error('not in this test')
    },
    cancelLogin: () => {}
  }
  return { vault, state }
}

const cred = (tag: string, expiresIn: number): VaultCredential => ({
  type: 'oauth',
  access: `fake-access-${tag}`,
  refresh: `fake-refresh-${tag}`,
  expires: NOW + expiresIn,
  accountId: 'acct-1'
})

function setup(
  initial: VaultCredential | null,
  opts: {
    refresh?: (refresh: string) => Promise<TokenResponse>
    runs?: boolean
    opencodeRoute?: boolean
    clock?: { now: number }
  } = {}
) {
  const clock = opts.clock ?? { now: NOW }
  const { vault, state } = vaultWith(initial)
  const refresh = vi.fn(
    opts.refresh ??
      (async () => ({
        access_token: 'fake-access-refreshed',
        refresh_token: 'fake-refresh-refreshed',
        expires_in: 3600
      }))
  )
  const opencode = fakeOpencodeTarget()
  const history = memoryFedTokenHistory()
  const sync = new CredentialSync({
    vault,
    now: () => clock.now,
    refreshAccessToken: refresh,
    getEnabledRoutes: () => ({ pi: false, opencode: opts.opencodeRoute ?? true }),
    harnessRuns: (engine) => engine === 'opencode' && (opts.runs ?? true),
    fedTokens: history
  })
  sync.configure({ opencode: opencode.target })
  return { sync, state, refresh, opencode, history, clock }
}

describe('start (§5 rule 4)', () => {
  it('vends the active account once: the store prunes a crash’s generations and re-takes the slot', async () => {
    vi.useFakeTimers()
    try {
      const h = setup(cred('a', 60 * MIN))
      await h.sync.start()
      expect(h.opencode.feed).toHaveBeenCalledTimes(1)
      expect(h.opencode.feed).toHaveBeenCalledWith(
        'openai',
        expect.objectContaining({ access: 'fake-access-a', accountId: 'acct-1' })
      )
      h.sync.stop()
    } finally {
      vi.useRealTimers()
    }
  })

  it('with no credential, whatever ClaudeUI left in opencode goes', async () => {
    const h = setup(null)
    await h.sync.start()
    expect(h.opencode.feed).not.toHaveBeenCalled()
    expect(h.opencode.remove).toHaveBeenCalledWith('openai')
  })
})

describe('the pre-turn gate (§5 rule 2)', () => {
  it('a vended token with more than 15 min of REAL expiry left: the turn goes, nothing is called', async () => {
    const h = setup(cred('a', 60 * MIN))
    await h.sync.feedAll(cred('a', 60 * MIN))
    h.opencode.feed.mockClear()
    await expect(h.sync.opencodeTurnGate()).resolves.toBeNull()
    expect(h.refresh).not.toHaveBeenCalled()
    expect(h.opencode.feed).not.toHaveBeenCalled()
  })

  it('15 min or less left: refresh and rotate FIRST, then the turn goes', async () => {
    const h = setup(cred('a', 10 * MIN))
    await h.sync.feedAll(cred('a', 10 * MIN))
    h.opencode.feed.mockClear()
    await expect(h.sync.opencodeTurnGate()).resolves.toBeNull()
    expect(h.refresh).toHaveBeenCalledWith('fake-refresh-a')
    expect(h.opencode.feed).toHaveBeenCalledWith(
      'openai',
      expect.objectContaining({ access: 'fake-access-refreshed' })
    )
    expect(h.opencode.vended()?.access).toBe('fake-access-refreshed')
  })

  it('opencode does not hold the vault’s current token (a vend failed): re-vend, no refresh', async () => {
    const h = setup(cred('b', 60 * MIN))
    await expect(h.sync.opencodeTurnGate()).resolves.toBeNull()
    expect(h.refresh).not.toHaveBeenCalled()
    expect(h.opencode.vended()?.access).toBe('fake-access-b')
  })

  it('offline (the refresh fails): the turn is HELD with a notice, nothing is sent', async () => {
    const h = setup(cred('a', 5 * MIN), {
      refresh: async () => {
        throw new TypeError('fetch failed')
      }
    })
    await h.sync.feedAll(cred('a', 5 * MIN))
    const held = await h.sync.opencodeTurnGate()
    expect(held).toMatch(/couldn't refresh your ChatGPT sign-in/)
    h.sync.stop()
  })

  it('a revoked refresh token: held, and the notice asks for a sign-in', async () => {
    const h = setup(cred('a', 5 * MIN), {
      refresh: async () => {
        throw new Error('Token refresh failed: 400 invalid_grant')
      }
    })
    await expect(h.sync.opencodeTurnGate()).resolves.toMatch(/Sign in to ChatGPT again/)
  })

  it('nothing to gate: no vault credential, the opencode route off, or opencode not installed', async () => {
    await expect(setup(null).sync.opencodeTurnGate()).resolves.toBeNull()
    const off = setup(cred('a', 5 * MIN), { opencodeRoute: false })
    await expect(off.sync.opencodeTurnGate()).resolves.toBeNull()
    expect(off.refresh).not.toHaveBeenCalled()
    const missing = setup(cred('a', 5 * MIN), { runs: false })
    await expect(missing.sync.opencodeTurnGate()).resolves.toBeNull()
    expect(missing.refresh).not.toHaveBeenCalled()
  })
})

describe('provider.auth → refresh and rotate (§5 rule 3)', () => {
  it('refreshes at once whatever the expiry says, rotates opencode’s row, and cools down', async () => {
    const clock = { now: NOW }
    const h = setup(cred('a', 6 * 60 * MIN), { clock })
    await h.sync.feedAll(cred('a', 6 * 60 * MIN))
    await h.sync.opencodeAuthFailed()
    expect(h.refresh).toHaveBeenCalledTimes(1)
    expect(h.opencode.vended()?.access).toBe('fake-access-refreshed')
    // A second failure right after: no second token request.
    await h.sync.opencodeAuthFailed()
    expect(h.refresh).toHaveBeenCalledTimes(1)
    clock.now += OPENCODE_AUTH_RECOVERY_COOLDOWN_MS + 1
    await h.sync.opencodeAuthFailed()
    expect(h.refresh).toHaveBeenCalledTimes(2)
    h.sync.stop()
  })

  it('does nothing without a ChatGPT credential of ClaudeUI’s', async () => {
    const h = setup(null)
    await h.sync.opencodeAuthFailed()
    expect(h.refresh).not.toHaveBeenCalled()
  })
})

describe('system resume (§5 rule 2)', () => {
  it('re-schedules from the wall clock: a deadline slept through refreshes now', async () => {
    vi.useFakeTimers()
    try {
      const clock = { now: NOW }
      const h = setup(cred('a', REFRESH_MARGIN_MS + 60 * MIN), { clock })
      await h.sync.start()
      expect(h.refresh).not.toHaveBeenCalled()
      // The machine slept two hours: the clock moved, the timer did not fire.
      clock.now += 2 * 60 * MIN
      await h.sync.onSystemResume()
      await vi.advanceTimersByTimeAsync(0)
      expect(h.refresh).toHaveBeenCalledTimes(1)
      expect(h.opencode.vended()?.access).toBe('fake-access-refreshed')
      h.sync.stop()
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('graceful quit', () => {
  it('hands the slot back (removes ClaudeUI’s ChatGPT rows)', async () => {
    const h = setup(cred('a', 60 * MIN))
    await h.sync.prepareQuit()
    expect(h.opencode.remove).toHaveBeenCalledWith('openai')
  })

  it('does nothing while opencode is not installed', async () => {
    const h = setup(cred('a', 60 * MIN), { runs: false })
    await h.sync.prepareQuit()
    expect(h.opencode.remove).not.toHaveBeenCalled()
  })
})

describe('the token check handed to opencode', () => {
  it('recognises the vault’s refresh tokens and the 1.x copies ClaudeUI fed opencode — nothing else', async () => {
    const h = setup(cred('a', 60 * MIN))
    h.history.record('opencode', 'fake-refresh-fed-to-auth-json-in-1x')
    await h.sync.feedAll(cred('a', 60 * MIN))
    const check = h.opencode.checks[0]
    await expect(check('fake-refresh-a')).resolves.toBe(true)
    await expect(check('fake-refresh-fed-to-auth-json-in-1x')).resolves.toBe(true)
    await expect(check('fake-refresh-users-own-sign-in')).resolves.toBe(false)
  })

  it('end to end: the imported copy of ClaudeUI’s 1.x sign-in is never restored on quit', async () => {
    const { vault } = vaultWith(cred('a', 60 * MIN))
    const opencode = storeBackedOpencode()
    // opencode's migration imported 1.x's auth.json: the vault's refresh token.
    opencode.holdsOwn('fake-refresh-a')
    const sync = new CredentialSync({
      vault,
      now: () => NOW,
      refreshAccessToken: async () => {
        throw new Error('no refresh in this test')
      },
      getEnabledRoutes: () => ({ pi: false, opencode: true }),
      harnessRuns: (engine) => engine === 'opencode'
    })
    sync.configure({ opencode: opencode.target })
    await sync.feedAll(cred('a', 60 * MIN))
    expect(opencode.held()).toBe('a')
    await sync.prepareQuit()
    // Removing ClaudeUI's row would have activated the copy: it stays active.
    expect(opencode.held()).toBe('a')
    expect(opencode.ours()).toHaveLength(1)
  })
})

// ── Review fixes (S7 review) ─────────────────────────────────────────────────

describe('M2: one expiry decides "fresh?" and "refresh?"', () => {
  it('a JWT exp earlier than the vault’s expiry: the gate REFRESHES (it used to re-vend and hold)', async () => {
    const access = jwt(Math.floor(NOW / 1000) + 10 * 60, 'short') // 10 min left by the token
    const h = setup({ ...cred('a', 60 * MIN), access }) // 60 min by the vault
    await h.sync.feedAll({ ...cred('a', 60 * MIN), access })
    await expect(h.sync.opencodeTurnGate()).resolves.toBeNull()
    expect(h.refresh).toHaveBeenCalledTimes(1)
    expect(h.opencode.vended()?.access).toBe('fake-access-refreshed')
  })
})

describe('L3: resume respects needs-sign-in and the give-up back-off', () => {
  it('a needs-sign-in account gets no refresh on resume, and the gate holds without one', async () => {
    const h = setup(cred('a', 5 * MIN), {
      refresh: async () => {
        throw new Error('Token refresh failed: 400 invalid_grant')
      }
    })
    await h.sync.opencodeTurnGate() // learns the token is dead
    expect(h.sync.needsReauth).toBe(true)
    h.refresh.mockClear()
    await h.sync.onSystemResume()
    await h.sync.opencodeAuthFailed()
    await expect(h.sync.opencodeTurnGate()).resolves.toMatch(/Sign in to ChatGPT again/)
    expect(h.refresh).not.toHaveBeenCalled()
    h.sync.stop()
  })

  it('an account in the give-up back-off keeps its back-off timer on resume', async () => {
    vi.useFakeTimers()
    try {
      const clock = { now: NOW }
      const h = setup(cred('a', 5 * MIN), {
        clock,
        refresh: async () => {
          throw new TypeError('fetch failed')
        }
      })
      await h.sync.start()
      // Exhaust the transient retries into the escalating give-up back-off.
      for (let i = 0; i < 6; i++) await vi.advanceTimersByTimeAsync(2 * 60_000)
      const calls = h.refresh.mock.calls.length
      await h.sync.onSystemResume()
      await vi.advanceTimersByTimeAsync(1_000)
      expect(h.refresh.mock.calls.length).toBe(calls)
      h.sync.stop()
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('L4: nothing re-vends while the slot is handed back', () => {
  it('after prepareQuit: no vend, no gate refresh, no recovery, no timers', async () => {
    vi.useFakeTimers()
    try {
      const h = setup(cred('a', REFRESH_MARGIN_MS + 60 * MIN))
      await h.sync.start()
      h.opencode.feed.mockClear()
      await h.sync.prepareQuit()
      expect(vi.getTimerCount()).toBe(0)
      expect((await h.sync.feedAll(cred('b', 60 * MIN))).opencode).toBe(false)
      await expect(h.sync.opencodeTurnGate()).resolves.toBeNull()
      await h.sync.opencodeAuthFailed()
      await h.sync.onSystemResume()
      expect(h.opencode.feed).not.toHaveBeenCalled()
      expect(h.refresh).not.toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('L7: an expired token is never vended', () => {
  it('start does not vend it (the immediate refresh does)', async () => {
    const h = setup(cred('a', -MIN), {
      refresh: async () => {
        throw new TypeError('fetch failed')
      }
    })
    await h.sync.start()
    expect(h.opencode.feed).not.toHaveBeenCalled()
    h.sync.stop()
  })

  it('the gate: expired and the refresh fails → needs sign-in, held, nothing vended', async () => {
    const h = setup(cred('a', -MIN), {
      refresh: async () => {
        throw new TypeError('fetch failed')
      }
    })
    await expect(h.sync.opencodeTurnGate()).resolves.toMatch(/Sign in to ChatGPT again/)
    expect(h.sync.needsReauth).toBe(true)
    expect(h.opencode.feed).not.toHaveBeenCalled()
    h.sync.stop()
  })
})

describe('L5: a token echoed by an error never reaches the log', () => {
  it('a failed opencode vend is logged redacted', async () => {
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {})
    try {
      const token = jwt(Math.floor(NOW / 1000) + 3600, 'leaky')
      const h = setup(cred('a', 60 * MIN))
      h.opencode.feed.mockRejectedValueOnce(
        new Error(`opencode credential.create 400: {"access":"${token}"} Bearer ${token}`)
      )
      await h.sync.feedAll(cred('a', 60 * MIN))
      const logged = JSON.stringify(warn.mock.calls)
      expect(logged).toContain('opencode vend failed')
      expect(logged).not.toContain(token)
      expect(logged).not.toContain('leaky')
    } finally {
      warn.mockRestore()
    }
  })
})

describe('the store-level copy check', () => {
  it('isClaudeuiRefreshToken answers for the vault and the 1.x history', async () => {
    const h = setup(cred('a', 60 * MIN))
    h.history.record('opencode', 'fake-refresh-1x')
    await expect(h.sync.isClaudeuiRefreshToken('fake-refresh-a')).resolves.toBe(true)
    await expect(h.sync.isClaudeuiRefreshToken('fake-refresh-1x')).resolves.toBe(true)
    await expect(h.sync.isClaudeuiRefreshToken('users-own')).resolves.toBe(false)
  })
})
