/**
 * @vitest-environment node
 *
 * ADR-082 §8 "As built (S7d)" — the ChatGPT credential is not fed into, taken
 * out of, watched in, or adopted from a harness that does not run, and the
 * harness gets it once it arrives.
 *
 * SAFETY: no refresh runs here (every credential is far from expiry and the
 * refresher is an injected fake), the vault is in memory, pi's feed target is
 * a spy over a temp directory — never `~/.pi` — and opencode 2.x is the real
 * credential store over an in-memory credential table, never a real opencode.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  CredentialSync,
  OPENCODE_CODEX_VENDOR_ID,
  PI_CODEX_VENDOR_ID,
  type CodexEntrySnapshot,
  type CodexFeedTarget,
  type VaultLike
} from '../../../../core/auth/vault/CredentialSync'
import type { VaultCredential } from '../../../../core/auth/vault/codex-oauth'
import { storeBackedOpencode } from './fixtures/fake-opencode-target'

type Engine = 'pi' | 'opencode'

const cred = (refresh: string): VaultCredential => ({
  type: 'oauth',
  access: `access-${refresh}`,
  refresh,
  expires: Date.now() + 10 * 24 * 60 * 60 * 1000
})

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'credential-sync-harness-runs-'))
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

function setup(vaultCred: VaultCredential | null, running: Record<Engine, boolean>) {
  const state = { current: vaultCred }
  const vault: VaultLike = {
    load: async () => state.current,
    save: async (next) => void (state.current = next),
    removeCredential: async () => void (state.current = null),
    hasUnreadableLegacyVault: () => false,
    beginLogin: async () => ({ authorizeUrl: 'https://auth.invalid/authorize' }),
    completeLogin: async () => {
      throw new Error('not in this test')
    },
    cancelLogin: () => {}
  }
  /** pi's store, so what a removal took out is really gone for the next read. */
  const piTarget = () => {
    const store = new Map<string, CodexEntrySnapshot>()
    const feed = vi.fn(async (vendorId: string, input: CodexEntrySnapshot) => {
      store.set(vendorId, input)
    })
    const read = vi.fn(async (vendorId: string) => store.get(vendorId) ?? null)
    const remove = vi.fn(async (vendorId: string) => void store.delete(vendorId))
    // An EXISTING directory, so a watcher would really be armed.
    const t: CodexFeedTarget = {
      authFilePath: () => join(dir, 'pi-auth.json'),
      feedOauthCredential: feed,
      readOauthEntry: read,
      removeVendorAuth: remove
    }
    return { t, store, feed, read, remove }
  }
  const pi = piTarget()
  const opencode = storeBackedOpencode(() => running.opencode)
  const sync = new CredentialSync({
    vault,
    refreshAccessToken: async () => {
      throw new Error('no refresh in this test')
    },
    harnessRuns: (engine) => running[engine]
  })
  sync.configure({ pi: pi.t, opencode: opencode.target })
  const watching = (engine: Engine): boolean =>
    (sync as unknown as { watchers: Map<Engine, unknown> }).watchers.has(engine)
  return { sync, state, pi, opencode, running, watching }
}

describe('the ChatGPT feed and a harness that does not run (ADR-082 §8, S7d)', () => {
  it('feedAll writes opencode only while pi does not run', async () => {
    const h = setup(null, { pi: false, opencode: true })
    const result = await h.sync.feedAll(cred('r1'))
    expect(result).toEqual({ pi: false, opencode: true })
    expect(h.pi.feed).not.toHaveBeenCalled()
    expect(h.pi.read).not.toHaveBeenCalled()
    expect(h.opencode.feed).toHaveBeenCalledWith(OPENCODE_CODEX_VENDOR_ID, expect.anything())
    expect(h.opencode.held()).toBe('access-r1')
    expect(h.watching('pi')).toBe(false)
    // opencode 2.x has no auth file to watch (ADR-093 §5).
    expect(h.watching('opencode')).toBe(false)
    h.sync.stop()
  })

  it('pi arriving is fed the active credential once; opencode is not rewritten', async () => {
    const h = setup(cred('r1'), { pi: false, opencode: true })
    await h.sync.start()
    expect(h.pi.feed).not.toHaveBeenCalled()
    expect(h.watching('pi')).toBe(false)
    h.opencode.feed.mockClear()

    h.running.pi = true
    await h.sync.harnessArrived('pi')

    expect(h.pi.feed).toHaveBeenCalledTimes(1)
    expect(h.pi.feed).toHaveBeenCalledWith(
      PI_CODEX_VENDOR_ID,
      expect.objectContaining({ refresh: 'r1' })
    )
    expect(h.opencode.feed).not.toHaveBeenCalled()
    expect(h.watching('pi')).toBe(true)
    h.sync.stop()
  })

  it('an arrival while the harness still does not run feeds nothing', async () => {
    const h = setup(cred('r1'), { pi: false, opencode: true })
    await h.sync.harnessArrived('pi')
    expect(h.pi.feed).not.toHaveBeenCalled()
  })

  it('start does not adopt from a harness that does not run', async () => {
    const h = setup(null, { pi: false, opencode: true })
    // pi's store holds a credential — say, one disconnected while pi was away.
    h.pi.read.mockResolvedValue({ access: 'a', refresh: 'stale', expires: Date.now() + 1e9 })
    await h.sync.start()
    expect(h.pi.read).not.toHaveBeenCalled()
    expect(h.state.current).toBeNull()
    h.sync.stop()
  })

  it('a disconnect takes pi’s copy out at once and records opencode’s, which goes when opencode can run', async () => {
    const h = setup(cred('r1'), { pi: false, opencode: false })
    h.pi.store.set(PI_CODEX_VENDOR_ID, cred('r1'))
    await h.opencode.holdsOurs('r1')

    await h.sync.disconnectChatgpt()

    // pi's auth.json is a file edit whether or not pi runs.
    expect(h.pi.remove).toHaveBeenCalledWith(PI_CODEX_VENDOR_ID)
    expect(h.pi.store.size).toBe(0)
    // opencode 2.x: no server without opencode — the removal waits in
    // ClaudeUI's record, and runs before the next operation once it can.
    expect(h.opencode.remove).toHaveBeenCalledWith(OPENCODE_CODEX_VENDOR_ID)
    expect(h.opencode.ours()).toHaveLength(1)
    h.running.opencode = true
    await h.sync.harnessArrived('opencode')
    expect(h.opencode.ours()).toEqual([])
  })

  it('opencode running: the disconnect removes ClaudeUI’s rows at once', async () => {
    const h = setup(cred('r1'), { pi: true, opencode: true })
    await h.opencode.holdsOurs('r1')
    await h.sync.disconnectChatgpt()
    expect(h.opencode.remove).toHaveBeenCalledWith(OPENCODE_CODEX_VENDOR_ID)
    expect(h.opencode.ours()).toEqual([])
  })

  it('a copy disconnected while opencode did not run is gone: nothing adopts it back', async () => {
    const h = setup(cred('r1'), { pi: false, opencode: false })
    await h.opencode.holdsOurs('r1')
    await h.sync.disconnectChatgpt()

    // A restart with opencode installed: the vault is empty, so reconcile would
    // bootstrap from any engine copy it found.
    h.running.opencode = true
    await h.sync.start()
    expect(h.state.current).toBeNull()
    expect(h.opencode.ours()).toEqual([])
    h.sync.stop()
  })
})
