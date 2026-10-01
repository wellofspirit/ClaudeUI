/**
 * `createNewSession`, `setSelectedEngine` and `seedUnsetModel` against the
 * harness snapshot (ADR-082 §8, S7b):
 *
 *   - a remembered harness that is not installed stays selected, with NO model
 *     seeded (its empty catalog would resolve to a phantom default), and no
 *     "configured default is gone" error;
 *   - the opencode→claude fallback still applies to an opencode that runs but
 *     has no usable model, and while the snapshot is unknown;
 *   - a harness this computer cannot run falls back to claude;
 *   - once the harness runs and its catalog arrives, `seedUnsetModel` gives the
 *     session the model a new session would get.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useSessionStore } from '../session-store'
import { harnessStore } from '../../components/SettingsDialog/harness-store'
import type { EngineId, ModelInfo } from '../../../../shared/types'
import type {
  HarnessId,
  HarnessStateEntry,
  HarnessStateSnapshot
} from '../../../../shared/harness-types'
import { mirrorStoreIntoReplica, resetReplicaSeam } from '@test/helpers/replica-seed'

const store = () => useSessionStore.getState()

function entry(id: HarnessId, state: 'ready' | 'missing' | 'unavailable'): HarnessStateEntry {
  const available = state === 'ready'
  return {
    id,
    manifest: { tested: '1.0.0', floor: '1.0.0', ceiling: '9.0.0' },
    selection: id === 'claude' ? { source: 'bundled' } : { source: 'managed', version: 'tested' },
    resolved: {
      source: id === 'claude' ? 'bundled' : 'managed',
      version: available ? '1.0.0' : null,
      path: available ? `/store/${id}` : null,
      available
    },
    system: { detectedAt: null, installs: [], choice: { kind: 'fallback', reason: 'none' } },
    managed: available
      ? [{ version: '1.0.0', verified: 'reviewed', installedAt: '2026-09-29T00:00:00.000Z' }]
      : [],
    installable: id !== 'claude' && state !== 'unavailable'
  }
}

async function harnesses(
  states: Partial<Record<HarnessId, 'ready' | 'missing' | 'unavailable'>>
): Promise<void> {
  const snapshot: HarnessStateSnapshot = {
    harnesses: {
      claude: entry('claude', 'ready'),
      opencode: entry('opencode', states.opencode ?? 'ready'),
      pi: entry('pi', states.pi ?? 'ready'),
      codex: entry('codex', states.codex ?? 'ready')
    },
    detection: { running: false },
    installs: [],
    updates: { mode: 'ask', available: [], status: { running: false, results: [] } },
    upgradePrompt: { pending: false, candidates: [] }
  }
  ;(window as unknown as { api: Record<string, unknown> }).api.harnessState = vi.fn(
    async () => snapshot
  )
  await harnessStore.refresh()
}

const claudeDefault: ModelInfo = { value: 'default', displayName: 'Default', description: '' }
const ocModel = (vendorId: string, modelId: string): ModelInfo => ({
  value: `${vendorId}/${modelId}`,
  displayName: modelId,
  description: '',
  engineId: 'opencode',
  vendorId
})

beforeEach(() => {
  resetReplicaSeam()
  harnessStore.resetForTests()
  ;(globalThis as any).window = globalThis.window || {}
  ;(globalThis as any).window.api = {
    saveSessionConfig: vi.fn(),
    saveSettings: vi.fn(),
    saveSlashCommands: vi.fn(),
    logError: vi.fn()
  } as any
  useSessionStore.setState({
    activeSessionId: null,
    sessions: {},
    recentSessionIds: [],
    sessionEngines: {},
    lastSelectedEngineId: 'claude' as EngineId,
    lastSelectedModelByEngine: {},
    availableModels: [claudeDefault],
    opencodeDefaultModelConfigured: false,
    piDefaultModelConfigured: false
  })
  mirrorStoreIntoReplica()
})

afterEach(() => {
  harnessStore.resetForTests()
})

describe('createNewSession on a harness that is not installed', () => {
  it('keeps a missing opencode selected with no model: no claude fallback, no phantom model', async () => {
    await harnesses({ opencode: 'missing' })
    useSessionStore.setState({ lastSelectedEngineId: 'opencode' as EngineId })
    store().createNewSession('oc-missing', '/tmp/proj')
    const session = store().sessions['oc-missing']
    expect(session.selectedEngineId).toBe('opencode')
    expect(session.status.engineId).toBe('opencode')
    expect(session.selectedModel).toBe('')
    expect(store().sessionEngines['oc-missing']).toEqual({ engineId: 'opencode' })
    // Not the "configured default is gone" error: nothing was configured wrong.
    expect(session.errors).toEqual([])
  })

  it('keeps a missing pi and a missing Codex the same way', async () => {
    await harnesses({ pi: 'missing', codex: 'missing' })
    useSessionStore.setState({
      lastSelectedEngineId: 'codex' as EngineId,
      lastSelectedModelByEngine: { codex: 'gpt-5.5' }
    })
    store().createNewSession('cx-missing', '/tmp/proj')
    expect(store().sessions['cx-missing'].selectedEngineId).toBe('codex')
    expect(store().sessions['cx-missing'].selectedModel).toBe('')
    expect(store().sessions['cx-missing'].codexModelExplicit).toBe(false)
    expect(store().sessions['cx-missing'].errors).toEqual([])

    useSessionStore.setState({ lastSelectedEngineId: 'pi' as EngineId })
    store().createNewSession('pi-missing', '/tmp/proj')
    expect(store().sessions['pi-missing'].selectedEngineId).toBe('pi')
    expect(store().sessions['pi-missing'].selectedModel).toBe('')
  })

  it('still falls back to claude when opencode runs but has no usable model', async () => {
    await harnesses({})
    useSessionStore.setState({ lastSelectedEngineId: 'opencode' as EngineId })
    store().createNewSession('oc-empty', '/tmp/proj')
    expect(store().sessions['oc-empty'].selectedEngineId).toBe('claude')
    expect(store().sessions['oc-empty'].selectedModel).toBe('default')
  })

  it('behaves as before while the harness snapshot is unknown', () => {
    useSessionStore.setState({ lastSelectedEngineId: 'opencode' as EngineId })
    store().createNewSession('oc-unknown', '/tmp/proj')
    expect(store().sessions['oc-unknown'].selectedEngineId).toBe('claude')
  })

  it('falls back to claude for a harness this computer cannot run', async () => {
    await harnesses({ codex: 'unavailable' })
    useSessionStore.setState({ lastSelectedEngineId: 'codex' as EngineId })
    store().createNewSession('cx-here', '/tmp/proj')
    expect(store().sessions['cx-here'].selectedEngineId).toBe('claude')
  })
})

describe('setSelectedEngine to a harness that is not installed', () => {
  it('selects it with no model and no stale-default error', async () => {
    await harnesses({ pi: 'missing' })
    store().createNewSession('s1', '/tmp/proj')
    useSessionStore.setState({ activeSessionId: 's1' })
    store().setSelectedEngine('pi')
    const session = store().sessions['s1']
    expect(session.selectedEngineId).toBe('pi')
    expect(session.selectedModel).toBe('')
    expect(session.errors).toEqual([])
  })
})

describe('seedUnsetModel', () => {
  it('seeds the model a new session would get once the harness runs and its catalog arrives', async () => {
    await harnesses({ opencode: 'missing' })
    useSessionStore.setState({ lastSelectedEngineId: 'opencode' as EngineId })
    store().createNewSession('oc-late', '/tmp/proj')
    // Still missing: nothing to seed.
    store().seedUnsetModel('oc-late')
    expect(store().sessions['oc-late'].selectedModel).toBe('')

    await harnesses({})
    useSessionStore.setState({
      availableModels: [claudeDefault, ocModel('opencode', 'mimo-free'), ocModel('openai', 'gpt-5')]
    })
    store().seedUnsetModel('oc-late')
    expect(store().sessions['oc-late'].selectedModel).toBe('opencode/mimo-free')
    expect(store().sessionEngines['oc-late']).toEqual({
      engineId: 'opencode',
      model: { engineId: 'opencode', vendorId: 'opencode', modelId: 'mimo-free' }
    })
  })

  it('leaves a session that has a model, or has spawned, alone', async () => {
    await harnesses({})
    useSessionStore.setState({
      lastSelectedEngineId: 'opencode' as EngineId,
      availableModels: [claudeDefault, ocModel('openai', 'gpt-5')]
    })
    store().createNewSession('oc-set', '/tmp/proj')
    expect(store().sessions['oc-set'].selectedModel).toBe('openai/gpt-5')
    useSessionStore.setState({ availableModels: [claudeDefault, ocModel('openai', 'o3')] })
    store().seedUnsetModel('oc-set')
    expect(store().sessions['oc-set'].selectedModel).toBe('openai/gpt-5')
  })
})
