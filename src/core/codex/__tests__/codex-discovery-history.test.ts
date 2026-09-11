import { beforeEach, expect, it, vi } from 'vitest'
import { discoverCodexModels } from '../model-discovery'
import { listCodexSessions, loadCodexHistory } from '../history'
import { setSessionMeta } from '../../services/db'

const mocks = vi.hoisted(() => ({
  available: true,
  models: vi.fn(),
  config: vi.fn(),
  history: vi.fn(),
  list: vi.fn(),
  dispose: vi.fn()
}))
vi.mock('../codex-locate', () => ({ codexBinaryAvailable: () => mocks.available }))
vi.mock('../CodexService', () => ({
  CodexService: class {
    models = mocks.models
    effectiveConfig = mocks.config
    history = mocks.history
    listAllThreads = mocks.list
    dispose = mocks.dispose
  }
}))
vi.mock('../../services/db', () => ({
  setSessionMeta: vi.fn(),
  getSessionMeta: () => undefined,
  ensureCodexSessionOverrides: vi.fn()
}))
beforeEach(() => {
  vi.clearAllMocks()
  mocks.available = true
  mocks.config.mockResolvedValue({ model_provider: 'openai', model: 'native' })
})

it('does not seed models for an unavailable installation', async () => {
  mocks.available = false
  expect(await discoverCodexModels()).toEqual([])
  expect(mocks.models).not.toHaveBeenCalled()
})

it('maps actual native catalog identity and dynamic efforts without Claude coercion', async () => {
  mocks.models.mockResolvedValue([
    { model: 'hidden', hidden: true },
    {
      model: 'native',
      displayName: 'Native',
      description: 'Native model',
      inputModalities: ['text', 'image'],
      supportedReasoningEfforts: [{ reasoningEffort: 'ultra', description: 'Native ultra' }],
      defaultReasoningEffort: 'ultra'
    }
  ])
  const groups = await discoverCodexModels()
  expect(groups).toHaveLength(1)
  expect(groups[0].models).toEqual([
    expect.objectContaining({
      value: 'native',
      engineId: 'codex',
      vendorId: 'openai',
      supportsEffort: false,
      vision: true,
      nativeEffortOptions: [{ value: 'ultra', description: 'Native ultra' }]
    })
  ])
  expect(mocks.dispose).toHaveBeenCalledOnce()
})

it('keeps thread/turn/item IDs stable and marks interrupted history incomplete', async () => {
  const command = {
    type: 'commandExecution',
    id: 'same',
    command: 'pwd',
    cwd: '/isolated',
    status: 'completed',
    exitCode: 0,
    aggregatedOutput: 'result'
  }
  mocks.history.mockResolvedValue({
    id: 'root',
    modelProvider: 'openai',
    name: null,
    createdAt: 1,
    turns: [
      { id: 'one', status: 'completed', startedAt: 1, items: [command] },
      { id: 'two', status: 'interrupted', startedAt: 2, items: [command] }
    ]
  })
  const history = await loadCodexHistory('root')
  expect(history.messages).toHaveLength(2)
  expect(new Set(history.messages.map((message) => message.id)).size).toBe(2)
  expect(
    history.messages.every(
      (message) => message.content.filter((block) => block.type === 'tool_result').length === 1
    )
  ).toBe(true)
  expect(history.warnings[0]).toContain('unresolved work')
  expect(history.statusLine).toBeNull()
})

it('lists roots only and records their actual provider/model metadata', async () => {
  const root = {
    id: 'root',
    model: 'native',
    modelProvider: 'openai',
    name: 'Root',
    cwd: '/isolated',
    createdAt: 1,
    updatedAt: 2
  }
  mocks.list.mockResolvedValue([root, { ...root, id: 'child', parentThreadId: 'root' }])
  expect(await listCodexSessions()).toEqual([
    {
      sessionId: 'root',
      engineId: 'codex',
      cwd: '/isolated',
      projectKey: '-isolated',
      title: 'Root',
      timestamp: 1000,
      lastActivityAt: 2000
    }
  ])
  expect(setSessionMeta).toHaveBeenCalledExactlyOnceWith('root', {
    engineId: 'codex',
    model: { engineId: 'codex', vendorId: 'openai', modelId: 'native' }
  })
})
