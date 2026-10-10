/**
 * The composer's model catalog, filled one engine at a time (engine-models.ts:
 * one `getEngineModels(engineId)` request per engine). `setEngineModels`
 * replaces one engine's slice and keeps the claude, opencode, pi, codex order
 * whatever order the answers arrive in; the reload nonces say which engine's
 * slice to re-fetch.
 */
import { beforeEach, describe, expect, it } from 'vitest'
import { useSessionStore } from '../session-store'
import type { EngineId, ModelInfo } from '../../../../shared/types'

const model = (engineId: EngineId | undefined, value: string): ModelInfo => ({
  value,
  displayName: value,
  description: '',
  ...(engineId ? { engineId } : {})
})

const store = () => useSessionStore.getState()
const values = (): string[] => store().availableModels.map((m) => m.value)

beforeEach(() => {
  useSessionStore.setState({
    availableModels: [],
    modelReloadNonce: 0,
    engineModelReloadNonces: { claude: 0, opencode: 0, pi: 0, codex: 0 }
  })
})

describe('setEngineModels', () => {
  it('keeps the engine order whatever order the answers arrive in', () => {
    store().setEngineModels('codex', [model('codex', 'gpt')])
    store().setEngineModels('pi', [model('pi', 'pi/a')])
    store().setEngineModels('opencode', [model('opencode', 'oc/a')])
    store().setEngineModels('claude', [model('claude', 'opus')])
    expect(values()).toEqual(['opus', 'oc/a', 'pi/a', 'gpt'])
  })

  it("replaces only its own engine's slice, in place", () => {
    store().setEngineModels('claude', [model('claude', 'opus')])
    store().setEngineModels('opencode', [model('opencode', 'oc/a'), model('opencode', 'oc/b')])
    store().setEngineModels('pi', [model('pi', 'pi/a')])

    store().setEngineModels('opencode', [model('opencode', 'oc/c')])
    expect(values()).toEqual(['opus', 'oc/c', 'pi/a'])

    store().setEngineModels('pi', [])
    expect(values()).toEqual(['opus', 'oc/c'])
  })

  it("treats a model without an engineId as Claude's (the getModels() fallback)", () => {
    store().setEngineModels('opencode', [model('opencode', 'oc/a')])
    store().setEngineModels('claude', [model(undefined, 'bare')])
    expect(values()).toEqual(['bare', 'oc/a'])

    // Claude's next answer replaces the bare rows, not adds to them.
    store().setEngineModels('claude', [model('claude', 'opus')])
    expect(values()).toEqual(['opus', 'oc/a'])
  })
})

describe('model reload nonces', () => {
  it('reloadModels re-fetches every engine and every Settings pane', () => {
    store().reloadModels()
    expect(store().modelReloadNonce).toBe(1)
    expect(store().engineModelReloadNonces).toEqual({ claude: 1, opencode: 1, pi: 1, codex: 1 })
  })

  it('reloadEngineModels re-fetches that engine only, and still nudges the Settings panes', () => {
    store().reloadEngineModels('pi')
    expect(store().engineModelReloadNonces).toEqual({ claude: 0, opencode: 0, pi: 1, codex: 0 })
    expect(store().modelReloadNonce).toBe(1)
  })
})
