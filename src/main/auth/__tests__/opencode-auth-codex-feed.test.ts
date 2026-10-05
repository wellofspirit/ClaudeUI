/**
 * @vitest-environment node
 *
 * Unit tests for OpencodeAuthProvider's M6b CredentialSync feed target:
 * authFilePath() / feedOauthCredential() / readOauthEntry(). All pure file
 * I/O (no opencode server involved) — same lightweight harness as the
 * sibling opencode-auth-credential-ids.test.ts (mocks the server/client/
 * model-discovery modules purely to satisfy OpencodeAuthProvider.ts's
 * imports; $XDG_DATA_HOME is redirected to a fresh temp dir per test so the
 * real opencode data dir is never touched).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import fs from 'fs'
import path from 'path'
import os from 'os'

vi.mock('../../../core/opencode/OpencodeServerManager', () => ({
  opencodeServerManager: { acquire: vi.fn(), release: vi.fn() }
}))
vi.mock('../../../core/opencode/OpencodeClient', () => ({ OpencodeClient: vi.fn() }))
const { mockInvalidateOpencodeModelCache } = vi.hoisted(() => ({
  mockInvalidateOpencodeModelCache: vi.fn()
}))
vi.mock('../../../core/opencode/model-discovery', () => ({
  invalidateOpencodeModelCache: mockInvalidateOpencodeModelCache
}))
vi.mock('../../../core/services/persisted-sessions-dir', () => ({
  PERSISTED_SESSIONS_DIR: '/fake/persisted'
}))
vi.mock('../../../core/services/logger', () => ({
  logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() }
}))

import { OpencodeAuthProvider } from '../../../core/auth/OpencodeAuthProvider'

describe('OpencodeAuthProvider — M6b CredentialSync feed target', () => {
  let tmpDir: string
  let prevXdg: string | undefined
  let provider: OpencodeAuthProvider

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'opencode-auth-codex-feed-test-'))
    prevXdg = process.env.XDG_DATA_HOME
    process.env.XDG_DATA_HOME = tmpDir
    provider = new OpencodeAuthProvider()
    mockInvalidateOpencodeModelCache.mockClear()
  })

  afterEach(() => {
    if (prevXdg === undefined) delete process.env.XDG_DATA_HOME
    else process.env.XDG_DATA_HOME = prevXdg
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  function authJsonPath(): string {
    return path.join(tmpDir, 'opencode', 'auth.json')
  }

  function writeAuthJson(data: unknown): void {
    const dir = path.join(tmpDir, 'opencode')
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(authJsonPath(), typeof data === 'string' ? data : JSON.stringify(data))
  }

  function readAuthJsonRaw(): Record<string, unknown> {
    return JSON.parse(fs.readFileSync(authJsonPath(), 'utf-8'))
  }

  describe('authFilePath', () => {
    it('resolves under $XDG_DATA_HOME/opencode/auth.json', () => {
      expect(provider.authFilePath()).toBe(authJsonPath())
    })
  })

  describe('feedOauthCredential', () => {
    it('creates auth.json (and the opencode data dir) when neither exists yet', async () => {
      await provider.feedOauthCredential('openai', { access: 'a1', refresh: 'r1', expires: 12345 })
      expect(fs.existsSync(authJsonPath())).toBe(true)
      expect(readAuthJsonRaw()).toEqual({
        openai: { type: 'oauth', refresh: 'r1', access: 'a1', expires: 12345 }
      })
    })

    it('persists accountId when provided (unlike pi)', async () => {
      await provider.feedOauthCredential('openai', {
        access: 'a1',
        refresh: 'r1',
        expires: 12345,
        accountId: 'acct-1'
      })
      expect(readAuthJsonRaw().openai).toEqual({
        type: 'oauth',
        refresh: 'r1',
        access: 'a1',
        expires: 12345,
        accountId: 'acct-1'
      })
    })

    it('preserves every other vendor entry byte-for-byte', async () => {
      writeAuthJson({
        anthropic: { type: 'oauth', access: 'x', refresh: 'y', expires: 1 },
        'my-ollama': { type: 'api', key: 'sk-secret-123' }
      })
      await provider.feedOauthCredential('openai', { access: 'a1', refresh: 'r1', expires: 12345 })
      const file = readAuthJsonRaw()
      expect(file.anthropic).toEqual({ type: 'oauth', access: 'x', refresh: 'y', expires: 1 })
      expect(file['my-ollama']).toEqual({ type: 'api', key: 'sk-secret-123' })
    })

    it('preserves unknown fields already on the SAME entry (merge, not overwrite)', async () => {
      writeAuthJson({ openai: { type: 'api', key: 'stale', someUnknownField: 'keep-me' } })
      await provider.feedOauthCredential('openai', { access: 'a2', refresh: 'r2', expires: 999 })
      expect(readAuthJsonRaw().openai).toEqual({
        type: 'oauth',
        key: 'stale',
        someUnknownField: 'keep-me',
        refresh: 'r2',
        access: 'a2',
        expires: 999
      })
    })

    it('invalidates the opencode model cache after a write', async () => {
      await provider.feedOauthCredential('openai', { access: 'a1', refresh: 'r1', expires: 12345 })
      expect(mockInvalidateOpencodeModelCache).toHaveBeenCalledTimes(1)
    })

    // CredentialSync re-feeds the active credential at every boot. A write of
    // what is already there invalidated the model cache, killing the opencode
    // model probe in flight. The test file is compact JSON and the writer
    // indents, so an unchanged raw string proves no write happened.
    describe('an unchanged credential', () => {
      const stored = {
        openai: { type: 'oauth', refresh: 'r1', access: 'a1', expires: 12345, accountId: 'acct-1' },
        anthropic: { type: 'api', key: 'sk-fixture' }
      }
      const cred = { access: 'a1', refresh: 'r1', expires: 12345, accountId: 'acct-1' }

      it('writes nothing and invalidates nothing', async () => {
        writeAuthJson(stored)
        const raw = fs.readFileSync(authJsonPath(), 'utf-8')
        await provider.feedOauthCredential('openai', cred)
        expect(fs.readFileSync(authJsonPath(), 'utf-8')).toBe(raw)
        expect(mockInvalidateOpencodeModelCache).not.toHaveBeenCalled()
      })

      it('is unchanged with unknown fields on the entry, which the merge would keep anyway', async () => {
        writeAuthJson({ openai: { ...stored.openai, enterpriseUrl: 'https://x.test' } })
        const raw = fs.readFileSync(authJsonPath(), 'utf-8')
        await provider.feedOauthCredential('openai', cred)
        expect(fs.readFileSync(authJsonPath(), 'utf-8')).toBe(raw)
        expect(mockInvalidateOpencodeModelCache).not.toHaveBeenCalled()
      })

      it.each([
        ['a rotated token', { ...cred, access: 'a2', refresh: 'r2', expires: 23456 }],
        ['a new expiry alone', { ...cred, expires: 99999 }],
        ['a changed accountId', { ...cred, accountId: 'acct-2' }]
      ])('writes and invalidates for %s', async (_label, changed) => {
        writeAuthJson(stored)
        await provider.feedOauthCredential('openai', changed)
        expect(readAuthJsonRaw()).toEqual({
          openai: { type: 'oauth', ...changed },
          anthropic: stored.anthropic
        })
        expect(mockInvalidateOpencodeModelCache).toHaveBeenCalledTimes(1)
      })

      it('writes over an api entry under the same vendor id', async () => {
        writeAuthJson({ openai: { type: 'api', key: 'sk-fixture' } })
        await provider.feedOauthCredential('openai', cred)
        expect(readAuthJsonRaw().openai).toMatchObject({ type: 'oauth', refresh: 'r1' })
        expect(mockInvalidateOpencodeModelCache).toHaveBeenCalledTimes(1)
      })
    })

    it('refreshes listVendorCredentialIds so it reports openai as oauth-credentialed after a feed', async () => {
      await provider.feedOauthCredential('openai', { access: 'a1', refresh: 'r1', expires: 12345 })
      expect(await provider.listVendorCredentialIds()).toEqual({ openai: 'oauth' })
    })

    if (process.platform !== 'win32') {
      it('sets 0600 permissions on POSIX', async () => {
        await provider.feedOauthCredential('openai', {
          access: 'a1',
          refresh: 'r1',
          expires: 12345
        })
        const mode = fs.statSync(authJsonPath()).mode & 0o777
        expect(mode).toBe(0o600)
      })
    }
  })

  describe('removeVendorAuthDirect (ADR-082 §8, S7d: opencode not running)', () => {
    it('removes only that vendor, keeping every other entry and unknown field', async () => {
      writeAuthJson({
        openrouter: { type: 'api', key: 'sk-fixture-1' },
        openai: { type: 'oauth', access: 'a', refresh: 'r', expires: 1, custom: { keep: true } },
        '#note': 'kept'
      })
      await provider.removeVendorAuthDirect('openrouter')
      expect(readAuthJsonRaw()).toEqual({
        openai: { type: 'oauth', access: 'a', refresh: 'r', expires: 1, custom: { keep: true } },
        '#note': 'kept'
      })
      expect(mockInvalidateOpencodeModelCache).toHaveBeenCalledTimes(1)
    })

    it('never goes through opencode’s server', async () => {
      const { opencodeServerManager } = await import('../../../core/opencode/OpencodeServerManager')
      writeAuthJson({ openrouter: { type: 'api', key: 'sk-fixture-1' } })
      await provider.removeVendorAuthDirect('openrouter')
      expect(opencodeServerManager.acquire).not.toHaveBeenCalled()
    })

    it('creates nothing when there is no auth.json', async () => {
      await provider.removeVendorAuthDirect('openrouter')
      expect(fs.existsSync(path.join(tmpDir, 'opencode'))).toBe(false)
    })

    it('writes nothing when the vendor has no entry', async () => {
      writeAuthJson({ openai: { type: 'api', key: 'sk-fixture-2' } })
      const raw = fs.readFileSync(authJsonPath(), 'utf-8')
      const before = fs.statSync(authJsonPath()).mtimeMs
      await provider.removeVendorAuthDirect('openrouter')
      expect(fs.readFileSync(authJsonPath(), 'utf-8')).toBe(raw)
      expect(fs.statSync(authJsonPath()).mtimeMs).toBe(before)
      expect(mockInvalidateOpencodeModelCache).not.toHaveBeenCalled()
    })

    it('refuses an unreadable file rather than overwrite it', async () => {
      writeAuthJson('{ half-written')
      await expect(provider.removeVendorAuthDirect('openrouter')).rejects.toThrow(
        /Refusing to overwrite/
      )
      expect(fs.readFileSync(authJsonPath(), 'utf-8')).toBe('{ half-written')
    })
  })

  describe('readOauthEntry', () => {
    it('returns the entry (incl. accountId) for a present oauth vendor', async () => {
      writeAuthJson({
        openai: { type: 'oauth', access: 'a1', refresh: 'r1', expires: 999, accountId: 'acct-1' }
      })
      expect(await provider.readOauthEntry('openai')).toEqual({
        access: 'a1',
        refresh: 'r1',
        expires: 999,
        accountId: 'acct-1'
      })
    })

    it('returns null when the vendor is absent', async () => {
      expect(await provider.readOauthEntry('openai')).toBeNull()
    })

    it('returns null for a non-oauth entry', async () => {
      writeAuthJson({ openai: { type: 'api', key: 'sk-x' } })
      expect(await provider.readOauthEntry('openai')).toBeNull()
    })

    it('returns null when the oauth entry is malformed (missing/wrong-typed fields)', async () => {
      writeAuthJson({ openai: { type: 'oauth', access: 'a1' } })
      expect(await provider.readOauthEntry('openai')).toBeNull()
    })

    it('returns null on malformed JSON — never throws', async () => {
      writeAuthJson('{ not json !!!')
      await expect(provider.readOauthEntry('openai')).resolves.toBeNull()
    })
  })
})
