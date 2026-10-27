/** @vitest-environment node */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const service = vi.hoisted(() => ({
  status: vi.fn(),
  overview: vi.fn(),
  models: vi.fn(),
  modelEndpoints: vi.fn()
}))
vi.mock('../../services/openrouter-dashboard', () => ({ openrouterDashboard: service }))
vi.mock('../../services/logger', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }
}))

import { OPENROUTER_CHANNELS, openrouterCommands } from '../openrouter-commands'

const byChannel = (channel: string) => openrouterCommands().find((c) => c.channel === channel)!

beforeEach(() => vi.clearAllMocks())

describe('openrouter commands', () => {
  it('declares exactly the four channels, all config queries', () => {
    const commands = openrouterCommands()
    expect(commands.map((c) => c.channel)).toEqual([...OPENROUTER_CHANNELS])
    for (const c of commands) expect([c.capability, c.kind]).toEqual(['config', 'query'])
  })

  it('wraps answers in the safeHandler envelope, and the payload carries no `ok` of its own', async () => {
    service.status.mockResolvedValue({ configured: true })
    const result = await byChannel('openrouter:status').handler()
    expect(result).toEqual({ ok: true, data: { configured: true } })
    expect((result as { data: object }).data).not.toHaveProperty('ok')
  })

  it('turns a throw into { ok: false, error } with the message only', async () => {
    service.overview.mockRejectedValue(new Error('OpenRouter rejected the key'))
    await expect(byChannel('openrouter:overview').handler()).resolves.toEqual({
      ok: false,
      error: 'OpenRouter rejected the key'
    })
  })

  it('hands the positional argument to the service untouched, whatever its type', async () => {
    service.models.mockResolvedValue([])
    service.modelEndpoints.mockResolvedValue([])
    await byChannel('openrouter:models').handler('user')
    await byChannel('openrouter:models').handler({ scope: 'all' })
    await byChannel('openrouter:model-endpoints').handler('a/b')
    expect(service.models.mock.calls).toEqual([['user'], [{ scope: 'all' }]])
    expect(service.modelEndpoints.mock.calls).toEqual([['a/b']])
  })
})
