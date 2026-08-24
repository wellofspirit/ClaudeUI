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
