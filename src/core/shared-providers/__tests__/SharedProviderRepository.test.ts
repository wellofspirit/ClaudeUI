/** @vitest-environment node */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
const home = vi.hoisted(() => ({ value: '' }))
vi.mock('node:os', async () => {
  const actual = await vi.importActual<typeof import('node:os')>('node:os')
  return { ...actual, homedir: () => home.value, default: { ...actual, homedir: () => home.value } }
})
import { SharedProviderRepository, sharedProviderPath } from '../SharedProviderRepository'
let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'providers-'))
  home.value = dir
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))
const provider = {
  id: 'local-api',
  name: 'Local',
  kind: 'custom' as const,
  protocol: 'openai-completions' as const,
  baseUrl: 'http://localhost/v1',
  models: [{ id: 'm' }],
  managed: true as const,
  routes: { pi: { enabled: true }, opencode: { enabled: false } }
}
describe('SharedProviderRepository', () => {
  it('seeds ChatGPT and round-trips custom records with private modes', () => {
    const repo = new SharedProviderRepository()
    expect(repo.get('chatgpt')?.routes.pi.providerId).toBe('openai-codex')
    repo.save(provider)
    expect(repo.get('local-api')).toEqual(provider)
    if (process.platform !== 'win32')
      expect(statSync(sharedProviderPath('local-api')).mode & 0o777).toBe(0o600)
  })
  it('persists ChatGPT route preferences without allowing native mapping changes', () => {
    const repo = new SharedProviderRepository()
    const chatgpt = repo.get('chatgpt')!
    chatgpt.routes.pi.enabled = false
    chatgpt.routes.pi.providerId = 'wrong'
    repo.save(chatgpt)
    const reloaded = new SharedProviderRepository().get('chatgpt')!
    expect(reloaded.routes.pi).toMatchObject({ enabled: false, providerId: 'openai-codex' })
    expect(reloaded.routes.opencode).toMatchObject({ enabled: true, providerId: 'openai' })
  })
  it('skips malformed records and filename/id mismatches', () => {
    const repo = new SharedProviderRepository()
    repo.save(provider)
    const badPath = sharedProviderPath('bad')
    writeFileSync(badPath, JSON.stringify({ ...provider, id: 'different' }))
    writeFileSync(sharedProviderPath('invalid'), JSON.stringify({ managed: true, id: 'invalid' }))
    expect(repo.list()).toEqual(expect.arrayContaining([provider]))
    expect(repo.get('bad')).toBeNull()
    expect(repo.get('invalid')).toBeNull()
  })
  it('persists the ChatGPT per-session accounts flag (ADR-068 §2)', () => {
    const repo = new SharedProviderRepository()
    const chatgpt = repo.get('chatgpt')!
    // Absent means off — the flag only exists once someone turns it on.
    expect(chatgpt.accounts).toBeUndefined()
    repo.save({ ...chatgpt, accounts: { perSession: true } })
    expect(new SharedProviderRepository().get('chatgpt')?.accounts).toEqual({ perSession: true })
    repo.save({ ...chatgpt, accounts: { perSession: false } })
    expect(new SharedProviderRepository().get('chatgpt')?.accounts).toEqual({ perSession: false })
  })
  it('rejects a malformed accounts block rather than storing it', () => {
    const repo = new SharedProviderRepository()
    const chatgpt = repo.get('chatgpt')!
    expect(() =>
      repo.save({
        ...chatgpt,
        accounts: { perSession: 'yes' } as unknown as { perSession: boolean }
      })
    ).toThrow(/accounts/i)
  })
  it('rejects traversal ids', () => {
    expect(() => new SharedProviderRepository().get('../x')).toThrow(/Invalid/)
  })
})

describe('SharedProviderRepository nested validation', () => {
  it('rejects duplicate models, unsafe native ids, and malformed overrides', () => {
    const repo = new SharedProviderRepository()
    expect(() => repo.save({ ...provider, models: [{ id: 'm' }, { id: 'm' }] })).toThrow(/models/)
    expect(() =>
      repo.save({
        ...provider,
        routes: { ...provider.routes, pi: { enabled: true, providerId: '../bad' } }
      })
    ).toThrow(/routes/)
    expect(() =>
      repo.save({
        ...provider,
        models: [{ id: 'm', harnessOverrides: { pi: { enabled: 'yes' as never } } }]
      })
    ).toThrow(/models/)
    expect(() => repo.save({ ...provider, models: [{ id: 'm', contextWindow: -1 }] })).toThrow(
      /models/
    )
    expect(() =>
      repo.save({
        ...provider,
        models: [{ id: 'm', harnessOverrides: { claude: { enabled: true } } as never }]
      })
    ).toThrow(/models/)
  })
})

describe('SharedProviderRepository — catalog kind (ADR-074 §6)', () => {
  const catalog = {
    id: 'openrouter',
    name: 'OpenRouter',
    kind: 'catalog' as const,
    models: [],
    managed: true as const,
    routes: { pi: { enabled: true }, opencode: { enabled: true } }
  }

  it('validates, round-trips, and list() keeps it', () => {
    const repo = new SharedProviderRepository()
    repo.save(catalog)
    expect(repo.get('openrouter')).toEqual(catalog)
    // list() silently drops a file validation rejects — the trap a new kind falls into.
    expect(new SharedProviderRepository().list().map((p) => p.id)).toContain('openrouter')
  })

  it('rejects an endpoint or a model list on a catalog definition', () => {
    const repo = new SharedProviderRepository()
    expect(() => repo.save({ ...catalog, baseUrl: 'https://openrouter.ai/api/v1' })).toThrow(
      /Catalog providers take no protocol, baseUrl or models/
    )
    expect(() => repo.save({ ...catalog, protocol: 'openai-completions' })).toThrow(/Catalog/)
    expect(() => repo.save({ ...catalog, models: [{ id: 'm' }] })).toThrow(/Catalog/)
    // A hand-edited file with an endpoint is skipped, not half-trusted.
    repo.save(catalog)
    writeFileSync(
      sharedProviderPath('openrouter'),
      JSON.stringify({ ...catalog, baseUrl: 'https://x' })
    )
    expect(repo.get('openrouter')).toBeNull()
  })

  it('still rejects an unknown kind', () => {
    const repo = new SharedProviderRepository()
    expect(() => repo.save({ ...catalog, kind: 'mystery' as never })).toThrow(/kind/)
  })
})
