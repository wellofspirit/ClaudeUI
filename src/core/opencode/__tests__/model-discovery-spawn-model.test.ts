/**
 * @vitest-environment node
 *
 * `resolveOpencodeSpawnModel` — the authoritative spawn chokepoint.
 *
 * The rule under test (owner ruling 2026-08-21): a REQUESTED model is an
 * explicit user reference, so one that the catalog no longer offers must throw
 * rather than be swapped for a substitute. Substituting is how a session
 * spawned on a no-vision model while its picker showed a vision one. The
 * NO-request path is untouched — nothing was configured there, so the built-in
 * ladder may still pick a model quietly (`agent-generate.ts` depends on it).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const { mockAcquire, mockRelease, MockOpencodeClient } = vi.hoisted(() => ({
  mockAcquire: vi.fn(),
  mockRelease: vi.fn(),
  MockOpencodeClient: vi.fn()
}))

vi.mock('../OpencodeServerManager', () => ({
  opencodeServerManager: { acquire: mockAcquire, release: mockRelease }
}))
vi.mock('../OpencodeClient', () => ({ OpencodeClient: MockOpencodeClient }))
vi.mock('../../services/persisted-sessions-dir', () => ({
  PERSISTED_SESSIONS_DIR: '/tmp/persisted'
}))
// Hermetic: never read the developer's real engines/opencode.json.
vi.mock('../../services/ui-config', () => ({ loadEngineConfig: () => ({}) }))

import {
  resolveOpencodeSpawnModel,
  invalidateOpencodeModelCache,
  ModelUnavailableError
} from '../model-discovery'

function model(id: string, providerID: string): unknown {
  return {
    id,
    providerID,
    api: { id: '', url: '', npm: '' },
    name: id,
    family: 'f',
    capabilities: {
      temperature: true,
      reasoning: false,
      attachment: false,
      toolcall: true,
      input: { text: true, audio: false, image: false, video: false, pdf: false },
      output: { text: true, audio: false, image: false, video: false, pdf: false }
    }
  }
}

const CATALOG = {
  providers: [
    {
      id: 'opencode',
      name: 'OpenCode Zen',
      source: 'env' as const,
      env: [],
      options: {},
      models: { 'mimo-v2.5-free': model('mimo-v2.5-free', 'opencode') }
    },
    {
      id: 'openai',
      name: 'OpenAI',
      source: 'env' as const,
      env: [],
      options: {},
      models: { 'gpt-5.6': model('gpt-5.6', 'openai') }
    }
  ]
}

function withCatalog(catalog: unknown): void {
  mockAcquire.mockReset().mockResolvedValue({ baseUrl: 'http://127.0.0.1:9999', authHeader: 'x' })
  mockRelease.mockReset().mockReturnValue(undefined)
  MockOpencodeClient.mockReset().mockImplementation(function () {
    return { getConfigProviders: vi.fn().mockResolvedValue(catalog) }
  })
  invalidateOpencodeModelCache()
}

describe('resolveOpencodeSpawnModel', () => {
  beforeEach(() => withCatalog(CATALOG))

  it('returns a requested model that is available', async () => {
    expect(await resolveOpencodeSpawnModel('openai/gpt-5.6')).toBe('openai/gpt-5.6')
  })

  /** PRE-FIX: returned 'opencode/mimo-v2.5-free' with a warn log. */
  it('THROWS for a requested model the catalog no longer offers', async () => {
    await expect(resolveOpencodeSpawnModel('openai/gpt-5.5')).rejects.toBeInstanceOf(
      ModelUnavailableError
    )
    await expect(resolveOpencodeSpawnModel('openai/gpt-5.5')).rejects.toThrow(
      /openai\/gpt-5\.5.*no longer available/
    )
  })

  it('still resolves the built-in ladder when NOTHING was requested (agent-generate path)', async () => {
    expect(await resolveOpencodeSpawnModel()).toBe('opencode/mimo-v2.5-free')
  })

  it('passes a requested model through unchanged when the catalog is empty (cannot validate)', async () => {
    withCatalog({ providers: [] })
    expect(await resolveOpencodeSpawnModel('openai/gpt-5.5')).toBe('openai/gpt-5.5')
  })

  it('passes a requested model through unchanged when discovery itself fails', async () => {
    withCatalog(CATALOG)
    MockOpencodeClient.mockImplementation(function () {
      return { getConfigProviders: vi.fn().mockRejectedValue(new Error('server down')) }
    })
    expect(await resolveOpencodeSpawnModel('openai/gpt-5.5')).toBe('openai/gpt-5.5')
  })
})
