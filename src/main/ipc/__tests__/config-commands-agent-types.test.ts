/**
 * @vitest-environment node
 *
 * ADR-094 — `config:list-agent-types`: the agent types an engine can spawn, for
 * the type tile's settings page. A `config` query, so an ordinary authenticated
 * remote connection reaches it (`remote-channel-parity.test.ts` pins that
 * half). What THIS file pins is the perimeter: the engine is one of the four
 * `EngineId`s, the cwd a string or nothing, and the answer is the catalog's own.
 * The catalog itself is covered in `core/services/__tests__/agent-type-catalog.test.ts`.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest'

const catalog = vi.hoisted(() => ({
  listAgentTypes: vi.fn((engine: string) => [{ type: `${engine}-type`, source: 'builtin' }])
}))
vi.mock('../../../core/services/agent-type-catalog', () => catalog)

vi.mock('../../../core/services/logger', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }
}))

import { configCommands } from '../../../core/ipc/config-commands'
import type { SessionManager } from '../../../core/services/session-manager'

const commands = configCommands({} as unknown as SessionManager)
const command = commands.find((c) => c.channel === 'config:list-agent-types')!
const invoke = (...args: unknown[]): Promise<unknown> =>
  (command.handler as (...a: unknown[]) => Promise<unknown>)(...args)

beforeEach(() => catalog.listAgentTypes.mockClear())

describe('config:list-agent-types', () => {
  it('is a read-only `config` query', () => {
    expect(command).toMatchObject({ capability: 'config', kind: 'query' })
  })

  it('answers the catalog for each engine, passing the cwd through', async () => {
    for (const engine of ['claude', 'opencode', 'pi', 'codex']) {
      expect(await invoke(engine, '/repo/app')).toEqual({
        ok: true,
        data: [{ type: `${engine}-type`, source: 'builtin' }]
      })
      expect(catalog.listAgentTypes).toHaveBeenLastCalledWith(engine, '/repo/app')
    }
  })

  it('treats a missing, empty or non-string cwd as none', async () => {
    await invoke('claude', '')
    expect(catalog.listAgentTypes).toHaveBeenLastCalledWith('claude', undefined)
    await invoke('claude')
    expect(catalog.listAgentTypes).toHaveBeenLastCalledWith('claude', undefined)
    await invoke('claude', { not: 'a path' })
    expect(catalog.listAgentTypes).toHaveBeenLastCalledWith('claude', undefined)
  })

  it('refuses an unknown engine, including a path-shaped one, before the catalog is read', async () => {
    for (const bad of ['gemini', '', '../claude', 'constructor', undefined]) {
      expect(await invoke(bad, '/repo/app')).toMatchObject({ ok: false })
    }
    expect(catalog.listAgentTypes).not.toHaveBeenCalled()
  })
})
