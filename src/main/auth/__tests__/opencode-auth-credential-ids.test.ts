/**
 * @vitest-environment node
 *
 * Unit tests for OpencodeAuthProvider.listVendorCredentialIds() — the READ-ONLY
 * peek at opencode's own auth.json used by the custom-provider key indicator.
 *
 * The data dir resolves from $XDG_DATA_HOME (fallback ~/.local/share), read at
 * call time — so each test points XDG_DATA_HOME at a fresh temp dir.
 *
 * Guards:
 *   1. api + oauth entries → { id: 'api' | 'oauth' } (types mapped correctly)
 *   2. NO key/token material in the return value (security invariant)
 *   3. missing file → {}
 *   4. malformed JSON → {}
 *   5. non-object JSON (array/scalar) → {}
 *   6. non-object entries are skipped
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import fs from 'fs'
import path from 'path'
import os from 'os'

// listVendorCredentialIds never touches the server, but importing the module
// pulls in the server manager / client / model-discovery — mock them out like
// the sibling OpencodeAuthProvider.test.ts does.
vi.mock('../../../core/opencode/OpencodeServerManager', () => ({
  opencodeServerManager: { acquire: vi.fn(), release: vi.fn() }
}))
vi.mock('../../../core/opencode/OpencodeClient', () => ({ OpencodeClient: vi.fn() }))
vi.mock('../../../core/opencode/model-discovery', () => ({
  invalidateOpencodeModelCache: vi.fn()
}))
vi.mock('../../../core/services/persisted-sessions-dir', () => ({
  PERSISTED_SESSIONS_DIR: '/fake/persisted'
}))
vi.mock('../../../core/services/logger', () => ({
  logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() }
}))

// Import SUT AFTER mocking
import { OpencodeAuthProvider } from '../../../core/auth/OpencodeAuthProvider'

describe('OpencodeAuthProvider.listVendorCredentialIds', () => {
  let tmpDir: string
  let prevXdg: string | undefined
  let provider: OpencodeAuthProvider

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'opencode-auth-test-'))
    prevXdg = process.env.XDG_DATA_HOME
    process.env.XDG_DATA_HOME = tmpDir
    provider = new OpencodeAuthProvider()
  })

  afterEach(() => {
    if (prevXdg === undefined) delete process.env.XDG_DATA_HOME
    else process.env.XDG_DATA_HOME = prevXdg
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  function writeAuthJson(data: unknown): void {
    const dir = path.join(tmpDir, 'opencode')
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(
      path.join(dir, 'auth.json'),
      typeof data === 'string' ? data : JSON.stringify(data)
    )
  }

  it('returns provider ids with their credential kind for api + oauth entries', async () => {
    writeAuthJson({
      'my-ollama': { type: 'api', key: 'sk-secret-123' },
      anthropic: { type: 'oauth', access: 'at-secret', refresh: 'rt-secret', expires: 123 }
    })

    const result = await provider.listVendorCredentialIds()
    expect(result).toEqual({ 'my-ollama': 'api', anthropic: 'oauth' })
  })

  it('never includes key or token material in the return value', async () => {
    writeAuthJson({
      'my-ollama': { type: 'api', key: 'sk-secret-123' },
      anthropic: { type: 'oauth', access: 'at-secret', refresh: 'rt-secret', expires: 123 }
    })

    const result = await provider.listVendorCredentialIds()
    const serialized = JSON.stringify(result)
    expect(serialized).not.toContain('sk-secret-123')
    expect(serialized).not.toContain('at-secret')
    expect(serialized).not.toContain('rt-secret')
    // Values are ONLY the credential-kind strings.
    for (const v of Object.values(result)) {
      expect(['api', 'oauth']).toContain(v)
    }
  })

  it("maps non-oauth entry types (e.g. 'wellknown') to 'api'", async () => {
    writeAuthJson({ github: { type: 'wellknown', token: 'gh-secret' } })

    const result = await provider.listVendorCredentialIds()
    expect(result).toEqual({ github: 'api' })
  })

  it('returns {} when auth.json does not exist', async () => {
    // No file written — data dir is empty.
    await expect(provider.listVendorCredentialIds()).resolves.toEqual({})
  })

  it('returns {} on malformed JSON', async () => {
    writeAuthJson('{ not json !!!')
    await expect(provider.listVendorCredentialIds()).resolves.toEqual({})
  })

  it('returns {} when the top level is not an object', async () => {
    writeAuthJson(['my-ollama'])
    await expect(provider.listVendorCredentialIds()).resolves.toEqual({})
  })

  it('skips entries that are not objects', async () => {
    writeAuthJson({
      'my-ollama': { type: 'api', key: 'sk-x' },
      bogus: 'a-string',
      alsoBogus: null
    })

    const result = await provider.listVendorCredentialIds()
    expect(result).toEqual({ 'my-ollama': 'api' })
  })
})
