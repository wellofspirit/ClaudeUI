/**
 * The composer on a harness that does not run (ADR-082 §8, S7b): the banner
 * goes above the input, Send stays off, the model picker reads "Install
 * <label> to choose a model", and the models reload once the install lands.
 * Plus the placeholder, which now names the session's own harness.
 *
 * Renders <InputBox /> against `bootTestApp` with a View mock (the pattern of
 * InputBox.component.test.ts) and a `harness:state` handler.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, render } from '@testing-library/react'
import { createElement } from 'react'
import { useSessionStore } from '../../../../stores/session-store'
import type { InputBoxViewProps } from '../View'
import type { EngineId } from '../../../../../../shared/types'
import type {
  HarnessId,
  HarnessStateEntry,
  HarnessStateSnapshot
} from '../../../../../../shared/harness-types'
import { InputBox } from '../InputBox'
import { harnessStore } from '../../../SettingsDialog/harness-store'
import { mirrorStoreIntoReplica, resetReplicaSeam } from '@test/helpers/replica-seed'

let viewProps: InputBoxViewProps

vi.mock('../View', () => ({
  InputBoxView: (props: InputBoxViewProps) => {
    viewProps = props
    return null
  }
}))
vi.mock('../../../../hooks/useSlashMenu', () => ({
  useSlashMenu: () => ({
    slashMenuOpen: false,
    slashMenuIndex: 0,
    slashFilter: '',
    filteredCommands: [],
    handleInputChange: () => {},
    handleKeyDown: () => false,
    handleSelect: () => {}
  })
}))
vi.mock('../../../../hooks/useFileMention', () => ({
  useFileMention: () => ({
    fileMentionOpen: false,
    fileMentionIndex: 0,
    filteredEntries: [],
    handleInputChange: () => {},
    handleKeyDown: () => false,
    handleConfirm: () => {}
  })
}))
vi.mock('../../../../hooks/useIsMobile', () => ({ useIsMobile: () => false }))

const ROUTE = 'harness-route'

function entry(id: HarnessId, available: boolean): HarnessStateEntry {
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
    installable: id !== 'claude'
  }
}

function snapshot(missing: HarnessId[] = []): HarnessStateSnapshot {
  const of = (id: HarnessId): HarnessStateEntry => entry(id, !missing.includes(id))
  return {
    harnesses: { claude: of('claude'), opencode: of('opencode'), pi: of('pi'), codex: of('codex') },
    detection: { running: false },
    installs: [],
    updates: { mode: 'ask', available: [], status: { running: false, results: [] } },
    upgradePrompt: { pending: false, candidates: [] }
  }
}

describe('InputBox on a harness that does not run', () => {
  let app: Awaited<ReturnType<typeof import('@test/helpers/boot-test-app').bootTestApp>>
  let state: HarnessStateSnapshot
  let modelFetches: number
  let creates: unknown[][]

  beforeEach(async () => {
    const { bootTestApp } = await import('@test/helpers/boot-test-app')
    app = await bootTestApp()
    resetReplicaSeam()
    harnessStore.resetForTests()
    state = snapshot()
    modelFetches = 0
    creates = []
    app.bridge.ipcMain.handle('harness:state', () => state)
    app.bridge.ipcMain.handle('session:get-models', () => [])
    app.bridge.ipcMain.handle('session:get-engine-models', () => {
      modelFetches++
      return [{ engineId: 'claude', vendorId: 'anthropic', vendorName: 'Anthropic', models: [] }]
    })
    app.bridge.ipcMain.handle('session:create', (_e: unknown, ...args: unknown[]) => {
      creates.push(args)
      return null
    })
    app.bridge.ipcMain.handle('session:send', () => null)
    app.bridge.ipcMain.handle('provider-account:list', () => ({ ok: true, data: null }))
    app.bridge.ipcMain.handle('file:list-dir', () => [])
    useSessionStore.setState({
      activeSessionId: null,
      sessions: {},
      recentSessionIds: [],
      sessionEngines: {},
      availableModels: [],
      lastSelectedEngineId: 'claude'
    })
    mirrorStoreIntoReplica()
  })

  afterEach(() => {
    cleanup()
    harnessStore.resetForTests()
    app.teardown()
  })

  /** Load the harness snapshot, then create and render a session on `engine`. */
  async function sessionOn(engine: EngineId, missing: HarnessId[] = []): Promise<void> {
    state = snapshot(missing)
    await harnessStore.refresh()
    useSessionStore.setState({ lastSelectedEngineId: engine })
    useSessionStore.getState().createNewSession(ROUTE, '/test/cwd')
    useSessionStore.setState({ activeSessionId: ROUTE })
    render(createElement(InputBox))
    await act(async () => {})
  }

  it('blocks Send, replaces the model picker and shows the banner for a missing harness', async () => {
    await sessionOn('opencode', ['opencode'])
    expect(useSessionStore.getState().sessions[ROUTE].selectedEngineId).toBe('opencode')
    expect(viewProps.sendBlocked).toBe(true)
    expect(viewProps.modelNotice).toBe('Install opencode to choose a model')
    expect(viewProps.models).toEqual([])
    expect(viewProps.banner).not.toBeNull()
    // Enter / Send do nothing: no spawn, no error after send.
    await act(async () => {
      useSessionStore.getState().setDraftText('hello')
    })
    await act(async () => {
      await viewProps.onSend()
    })
    expect(creates).toEqual([])
    expect(useSessionStore.getState().sessions[ROUTE].errors).toEqual([])
  })

  it('leaves a harness that runs alone', async () => {
    await sessionOn('pi')
    expect(viewProps.sendBlocked).toBe(false)
    expect(viewProps.modelNotice).toBeUndefined()
    expect(viewProps.banner).toBeNull()
  })

  it('never blocks a session whose process is already running', async () => {
    await sessionOn('opencode', ['opencode'])
    await act(async () => {
      useSessionStore.getState().markSdkActive(ROUTE)
    })
    expect(viewProps.sendBlocked).toBe(false)
    expect(viewProps.banner).toBeNull()
  })

  it('reloads the models when the harness starts to run, and unlocks the composer', async () => {
    await sessionOn('opencode', ['opencode'])
    const before = modelFetches
    state = snapshot()
    await act(async () => {
      await harnessStore.refresh()
    })
    await act(async () => {})
    expect(modelFetches).toBe(before + 1)
    expect(viewProps.sendBlocked).toBe(false)
    expect(viewProps.banner).toBeNull()
  })

  describe('a harness that keeps running as a different binary', () => {
    /** Main reads, in order: pi's catalog warmed, then the registry re-read. */
    let reads: string[]

    beforeEach(() => {
      reads = []
      app.bridge.ipcMain.handle('session:get-pi-model-catalog', () => {
        reads.push('pi-catalog')
        return []
      })
      app.bridge.ipcMain.handle('provider-registry:list', () => {
        reads.push('registry')
        return { entries: [], opencodeInstalled: true }
      })
    })

    /** The snapshot with `id` resolved to another managed version. */
    function upgraded(id: HarnessId, version: string): HarnessStateSnapshot {
      const next = snapshot()
      next.harnesses[id] = {
        ...next.harnesses[id],
        resolved: { ...next.harnesses[id].resolved, version, path: `/store/${id}/${version}` }
      }
      return next
    }

    async function refreshTo(next: HarnessStateSnapshot): Promise<void> {
      state = next
      await act(async () => {
        await harnessStore.refresh()
      })
      await act(async () => {})
    }

    it('reloads the models, then the registry once pi’s catalog is warm, on a pi update', async () => {
      await sessionOn('pi')
      const before = modelFetches
      await refreshTo(upgraded('pi', '0.99.2'))
      expect(modelFetches).toBe(before + 1)
      expect(reads).toEqual(['pi-catalog', 'registry'])
    })

    it('reloads on an opencode selection change without warming pi', async () => {
      await sessionOn('opencode')
      const before = modelFetches
      await refreshTo(upgraded('opencode', '1.18.34'))
      expect(modelFetches).toBe(before + 1)
      expect(reads).toEqual(['registry'])
    })

    it('reloads when a harness stops running', async () => {
      await sessionOn('claude')
      const before = modelFetches
      await refreshTo(snapshot(['pi']))
      expect(modelFetches).toBe(before + 1)
    })

    it('reloads nothing for a re-read that changed nothing (a detection run)', async () => {
      await sessionOn('pi')
      const before = modelFetches
      await refreshTo(snapshot())
      expect(modelFetches).toBe(before)
      expect(reads).toEqual([])
    })
  })

  it.each([
    ['claude', 'Ask Claude anything, / for commands'],
    ['opencode', 'Ask opencode anything, / for commands'],
    ['pi', 'Ask pi anything, / for commands'],
    ['codex', 'Ask Codex anything']
  ] as const)('the placeholder names the session’s harness: %s', async (engine, text) => {
    // Missing, so opencode keeps its engine (no model to fall back from).
    await sessionOn(engine, engine === 'claude' ? [] : [engine])
    expect(viewProps.placeholder).toBe(text)
  })
})
