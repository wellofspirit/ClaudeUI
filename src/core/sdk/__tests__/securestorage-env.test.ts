import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { buildEnv } from '../args'
import { setSecurestorageEnv } from '../securestorage-env'

/**
 * buildEnv() SKIP_SECURESTORAGE / CLAUDE_SECURESTORAGE_CONFIG_DIR overlay
 * (ADR-015). The active-account dir is held in module state
 * (setSecurestorageEnv) and must be authoritative over anything in the spawn
 * env — an inherited SKIP_SECURESTORAGE from the parent shell must not defeat
 * per-account credential isolation.
 */
describe('buildEnv securestorage overlay', () => {
  beforeEach(() => setSecurestorageEnv(null))
  afterEach(() => setSecurestorageEnv(null))

  it('active account dir WINS over an inherited SKIP_SECURESTORAGE + dir (the fix)', () => {
    setSecurestorageEnv({ dir: '/accounts/active-account' })
    const env = buildEnv({
      // Inherited from the parent shell — must NOT be treated as a per-spawn override.
      SKIP_SECURESTORAGE: '1',
      CLAUDE_SECURESTORAGE_CONFIG_DIR: '/inherited/shared/dir'
    })
    expect(env.SKIP_SECURESTORAGE).toBe('1')
    expect(env.CLAUDE_SECURESTORAGE_CONFIG_DIR).toBe('/accounts/active-account')
  })

  it('active account dir is applied when nothing is inherited', () => {
    setSecurestorageEnv({ dir: '/accounts/acct-1' })
    const env = buildEnv({})
    expect(env.SKIP_SECURESTORAGE).toBe('1')
    expect(env.CLAUDE_SECURESTORAGE_CONFIG_DIR).toBe('/accounts/acct-1')
  })

  it('single-account (no module state): honors an inherited SKIP_SECURESTORAGE as-is', () => {
    const env = buildEnv({
      SKIP_SECURESTORAGE: '1',
      CLAUDE_SECURESTORAGE_CONFIG_DIR: '/inherited/dir'
    })
    expect(env.SKIP_SECURESTORAGE).toBe('1')
    expect(env.CLAUDE_SECURESTORAGE_CONFIG_DIR).toBe('/inherited/dir')
  })

  it('single-account (no module state, no inherited value): clears both vars → Keychain mode', () => {
    const env = buildEnv({})
    expect(env.SKIP_SECURESTORAGE).toBeUndefined()
    expect(env.CLAUDE_SECURESTORAGE_CONFIG_DIR).toBeUndefined()
  })
})
