/**
 * The composer's model catalog arrives one engine at a time: one
 * `getEngineModels(engineId)` request per engine, each filling only its own
 * slice of `availableModels` (engine-models.ts). Guards the bug it replaced: a
 * single all-engine reply waited for the slowest probe, so a pi probe running
 * to its 15s timeout hid Claude's, opencode's and Codex's models with it.
 *
 * The `session:get-engine-models` handler answers like main: per engine when
 * asked for one, and — asked for none — one reply after every engine answered.
 *
 * Renders <InputBox /> against `bootTestApp` with a View mock (the pattern of
 * InputBox.component.test.ts).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, render } from '@testing-library/react'
import { createElement } from 'react'
import { useSessionStore } from '../../../../stores/session-store'
import type { InputBoxViewProps } from '../View'
import type { EngineId, EngineModelGroup, ModelInfo } from '../../../../../../shared/types'
import { InputBox } from '../InputBox'
import { mirrorStoreIntoReplica, resetReplicaSeam } from '@test/helpers/replica-seed'

vi.mock('../View', () => ({
  InputBoxView: (_props: InputBoxViewProps) => null
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

const ROUTE = 'engine-models-route'
const ENGINES: EngineId[] = ['claude', 'opencode', 'pi', 'codex']

interface Deferred<T> {
  promise: Promise<T>
  resolve: (value: T) => void
}
function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((res) => {
    resolve = res
  })
  return { promise, resolve }
}

const group = (engineId: EngineId, ...values: string[]): EngineModelGroup => ({
  engineId,
  vendorId: engineId === 'claude' ? 'anthropic' : `${engineId}-vendor`,
  vendorName: engineId,
  models: values.map((value): ModelInfo => ({
    value,
    displayName: value,
    description: '',
    engineId
  }))
})

/** Never settles: a probe still running toward its timeout. */
const never = (): Promise<EngineModelGroup[]> => new Promise(() => {})

describe('InputBox model catalog, per engine', () => {
  let app: Awaited<ReturnType<typeof import('@test/helpers/boot-test-app').bootTestApp>>
  /** What main answers for one engine; the test sets it. */
  let answer: (engineId: EngineId) => Promise<EngineModelGroup[]>
  /** The engine each `session:get-engine-models` request named (undefined = all). */
  let requests: Array<EngineId | undefined>

  beforeEach(async () => {
    const { bootTestApp } = await import('@test/helpers/boot-test-app')
    app = await bootTestApp()
    resetReplicaSeam()
    requests = []
    answer = async () => []
    app.bridge.ipcMain.handle('session:get-models', () => [])
    app.bridge.ipcMain.handle('session:get-engine-models', (_e: unknown, engineId?: EngineId) => {
      requests.push(engineId)
      if (engineId) return answer(engineId)
      return Promise.all(ENGINES.map((id) => answer(id))).then((all) => all.flat())
    })
    app.bridge.ipcMain.handle('provider-account:list', () => ({ ok: true, data: null }))
    app.bridge.ipcMain.handle('file:list-dir', () => [])
    useSessionStore.setState({
      activeSessionId: null,
      sessions: {},
      recentSessionIds: [],
      availableModels: [],
      lastSelectedEngineId: 'claude'
    })
    mirrorStoreIntoReplica()
    useSessionStore.getState().createNewSession(ROUTE, '/test/cwd')
    useSessionStore.setState({ activeSessionId: ROUTE })
  })

  afterEach(() => {
    cleanup()
    app.teardown()
  })

  const shown = (): string[] =>
    useSessionStore.getState().availableModels.map((m) => `${m.engineId ?? 'claude'}:${m.value}`)

  async function mount(): Promise<void> {
    render(createElement(InputBox))
    await act(async () => {})
  }

  it("a pi probe that never answers holds back no other engine's models", async () => {
    answer = async (id) =>
      id === 'pi'
        ? never()
        : [group(id, { claude: 'opus', opencode: 'oc/a', codex: 'gpt' }[id] as string)]

    await mount()

    expect(requests).toEqual(ENGINES)
    expect(shown()).toEqual(['claude:opus', 'opencode:oc/a', 'codex:gpt'])
  })

  it('keeps the engine order whatever order the answers arrive in', async () => {
    const pending = Object.fromEntries(
      ENGINES.map((id) => [id, deferred<EngineModelGroup[]>()])
    ) as Record<EngineId, Deferred<EngineModelGroup[]>>
    answer = (id) => pending[id].promise
    await mount()

    for (const id of ['codex', 'pi', 'opencode', 'claude'] as const) {
      await act(async () => pending[id].resolve([group(id, `${id}-model`)]))
    }

    expect(shown()).toEqual([
      'claude:claude-model',
      'opencode:opencode-model',
      'pi:pi-model',
      'codex:codex-model'
    ])
  })

  it("an answer carrying other engines' groups fills only its own slice", async () => {
    // A host that predates the argument answers every engine to every request.
    answer = async () => [group('claude', 'opus'), group('pi', 'pi/a')]
    await mount()
    expect(shown()).toEqual(['claude:opus', 'pi:pi/a'])
  })

  it("re-fetches one engine on its reload, without orphaning another engine's answer in flight", async () => {
    const pi = deferred<EngineModelGroup[]>()
    let claudeAnswers = 0
    answer = async (id) => {
      if (id === 'pi') return pi.promise
      if (id === 'claude') return [group('claude', `opus-${++claudeAnswers}`)]
      return []
    }
    await mount()
    requests = []

    await act(async () => useSessionStore.getState().reloadEngineModels('claude'))
    expect(requests).toEqual(['claude'])
    expect(shown()).toEqual(['claude:opus-2'])

    // pi's first request is still its latest: its late answer lands.
    await act(async () => pi.resolve([group('pi', 'pi/a')]))
    expect(shown()).toEqual(['claude:opus-2', 'pi:pi/a'])
  })

  it('re-fetches only pi when pi is reloaded (engine:models-changed)', async () => {
    await mount()
    requests = []
    await act(async () => useSessionStore.getState().reloadEngineModels('pi'))
    expect(requests).toEqual(['pi'])

    // A whole reload still asks every engine.
    requests = []
    await act(async () => useSessionStore.getState().reloadModels())
    expect(requests).toEqual(ENGINES)
  })

  it('drops an answer that a cwd change made stale', async () => {
    const claude = [deferred<EngineModelGroup[]>(), deferred<EngineModelGroup[]>()]
    let claudeRequests = 0
    answer = (id) => (id === 'claude' ? claude[claudeRequests++].promise : Promise.resolve([]))
    await mount()

    // Another project's session: every engine is asked again, the list cleared.
    await act(async () => {
      useSessionStore.getState().createNewSession('other-route', '/other/cwd')
      useSessionStore.setState({ activeSessionId: 'other-route' })
    })
    expect(claudeRequests).toBe(2)

    await act(async () => claude[1].resolve([group('claude', 'fresh')]))
    await act(async () => claude[0].resolve([group('claude', 'stale')]))
    expect(shown()).toEqual(['claude:fresh'])
  })

  it("falls back to getModels() for Claude's slice only when Claude's request fails", async () => {
    app.bridge.ipcMain.handle('session:get-models', () => [
      { value: 'bare', displayName: 'bare', description: '' }
    ])
    answer = async (id) => {
      if (id === 'claude') throw new Error('not logged in')
      return id === 'opencode' ? [group('opencode', 'oc/a')] : []
    }

    await mount()

    expect(shown()).toEqual(['claude:bare', 'opencode:oc/a'])
  })
})
