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

describe('SharedProviderRepository — curation record (ADR-074 §3)', () => {
  it('round-trips a curation record, and keeps it on ChatGPT through normalisation', () => {
    const repo = new SharedProviderRepository()
    repo.save({ ...provider, curation: { linked: true, models: ['m'] } })
    expect(repo.get('local-api')?.curation).toEqual({ linked: true, models: ['m'] })
    const chatgpt = repo.get('chatgpt')!
    repo.save({ ...chatgpt, curation: { linked: false } })
    expect(new SharedProviderRepository().get('chatgpt')?.curation).toEqual({ linked: false })
  })

  it('rejects a malformed record', () => {
    const repo = new SharedProviderRepository()
    for (const curation of [
      { linked: 'yes' },
      { linked: true, models: 'm' },
      { linked: true, models: ['m', 'm'] },
      { linked: true, models: [''] }
    ]) {
      expect(() => repo.save({ ...provider, curation: curation as never })).toThrow(/curation/)
    }
  })
})

describe('SharedProviderRepository — a second key’s origin (ADR-074 slice 10)', () => {
  const clone = {
    ...provider,
    id: 'openrouter-work',
    name: 'OpenRouter (Work)',
    baseUrl: 'https://openrouter.ai/api/v1',
    models: [{ id: 'moonshotai/kimi-k3', contextWindow: 262144 }],
    derivedFrom: 'openrouter'
  }

  it('round-trips `derivedFrom` on a custom definition, with a slash in a model id', () => {
    const repo = new SharedProviderRepository()
    repo.save(clone)
    expect(new SharedProviderRepository().get('openrouter-work')).toEqual(clone)
  })

  it('rejects it anywhere but a custom definition, and anything but a vendor id', () => {
    const repo = new SharedProviderRepository()
    const catalog = {
      id: 'openrouter',
      name: 'OpenRouter',
      kind: 'catalog' as const,
      models: [],
      managed: true as const,
      routes: { pi: { enabled: true }, opencode: { enabled: true } }
    }
    expect(() => repo.save({ ...catalog, derivedFrom: 'groq' })).toThrow(/origin/)
    for (const derivedFrom of ['', 'Open Router', '../x', 'openrouter-work', 42]) {
      expect(() => repo.save({ ...clone, derivedFrom: derivedFrom as never })).toThrow(/origin/)
    }
    // A hand-edited file with a bad origin is skipped like any other bad file.
    repo.save(clone)
    writeFileSync(
      sharedProviderPath('openrouter-work'),
      JSON.stringify({ ...clone, derivedFrom: 'Bad Id' })
    )
    expect(repo.get('openrouter-work')).toBeNull()
  })
})

describe('SharedProviderRepository — switched off (ADR-074 slice 10)', () => {
  it('round-trips `disabled` on a key or endpoint provider', () => {
    const repo = new SharedProviderRepository()
    repo.save({ ...provider, disabled: true })
    expect(new SharedProviderRepository().get('local-api')?.disabled).toBe(true)
  })

  it('rejects a non-boolean, and any on a subscription', () => {
    const repo = new SharedProviderRepository()
    expect(() => repo.save({ ...provider, disabled: 'yes' as never })).toThrow(/on\/off/)
    const chatgpt = repo.get('chatgpt')!
    expect(() => repo.save({ ...chatgpt, disabled: true })).toThrow(/on\/off/)
  })
})

describe('SharedProviderRepository — second keys, one level deep (slice 10 review)', () => {
  const clone = {
    ...provider,
    id: 'openrouter-work',
    name: 'OpenRouter (Work)',
    derivedFrom: 'openrouter',
    copiedAt: '2026-09-23'
  }

  it('keeps the copy date, and rejects a malformed one or one without an origin', () => {
    const repo = new SharedProviderRepository()
    repo.save(clone)
    expect(repo.get('openrouter-work')?.copiedAt).toBe('2026-09-23')
    expect(() => repo.save({ ...clone, copiedAt: '23 Sep' })).toThrow(/copy date/)
    expect(() => repo.save({ ...provider, copiedAt: '2026-09-23' })).toThrow(/copy date/)
  })

  it('refuses a second key of a second key', () => {
    const repo = new SharedProviderRepository()
    repo.save(clone)
    expect(() =>
      repo.save({ ...clone, id: 'openrouter-work-eu', derivedFrom: 'openrouter-work' })
    ).toThrow(/itself a second key/)
  })
})
