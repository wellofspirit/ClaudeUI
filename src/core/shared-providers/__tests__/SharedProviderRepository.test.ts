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
