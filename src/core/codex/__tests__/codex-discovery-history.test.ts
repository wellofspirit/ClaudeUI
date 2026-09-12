import { beforeEach, expect, it, vi } from 'vitest'
import { discoverCodexModels } from '../model-discovery'
import { listCodexSessions, loadCodexHistory, resolveCodexForkAnchor } from '../history'
import { setSessionMeta } from '../../services/db'

const mocks = vi.hoisted(() => ({
  available: true,
  models: vi.fn(),
  config: vi.fn(),
  history: vi.fn(),
  list: vi.fn(),
  read: vi.fn(),
  meta: vi.fn(() => ({}) as Record<string, { engineId: string }>),
  dispose: vi.fn()
}))
vi.mock('../codex-locate', () => ({ codexBinaryAvailable: () => mocks.available }))
vi.mock('../CodexService', () => ({
  CodexService: class {
    models = mocks.models
    effectiveConfig = mocks.config
    history = mocks.history
    readThread = mocks.read
    listAllThreads = mocks.list
    dispose = mocks.dispose
  }
}))
vi.mock('../../services/db', () => ({
  setSessionMeta: vi.fn(),
  getSessionMeta: () => undefined,
  allSessionMeta: () => mocks.meta(),
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

it('truncates a forked seed at the anchor turn and refuses an anchor it cannot find', async () => {
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
      { id: 'two', status: 'completed', startedAt: 2, items: [command] }
    ]
  })
  // The canonical seed for a branch reads the SOURCE through the anchor turn, so
  // the post-anchor turns the new thread never saw must not reach any client.
  const seeded = await loadCodexHistory('root', { cwd: '/isolated' }, 'one')
  expect(seeded.messages).toHaveLength(1)
  expect(seeded.messages[0].id).toBe('codex:["root","one","same"]')
  expect((await loadCodexHistory('root', { cwd: '/isolated' })).messages).toHaveLength(2)
  await expect(loadCodexHistory('root', { cwd: '/isolated' }, 'gone')).rejects.toThrow(
    'Codex fork anchor turn is not in this thread'
  )
  // An ANCHORLESS read of a turnless thread is empty, not a missing anchor.
  mocks.history.mockResolvedValue({
    id: 'root',
    modelProvider: 'openai',
    name: null,
    createdAt: 1,
    turns: []
  })
  expect((await loadCodexHistory('root', { cwd: '/isolated' })).messages).toEqual([])
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

it('anchors a fork on the completed turn that owns the message, and refuses the rest', async () => {
  mocks.history.mockResolvedValue({
    id: 'root',
    modelProvider: 'openai',
    name: null,
    createdAt: 1,
    turns: [
      { id: 'one', status: 'completed', startedAt: 1, items: [] },
      { id: 'two', status: 'inProgress', startedAt: 2, items: [] }
    ]
  })
  expect(await resolveCodexForkAnchor('root', 'codex:["root","one","assistant"]')).toEqual({
    anchorUuid: 'one'
  })
  // A fork through a running turn is refused by the binary, so it never reaches it.
  expect(await resolveCodexForkAnchor('root', 'codex:["root","two","assistant"]')).toEqual({
    anchorUuid: null,
    reason: 'turn-in-progress'
  })
  expect(await resolveCodexForkAnchor('root', 'codex:["root","gone","assistant"]')).toEqual({
    anchorUuid: null,
    reason: 'turn-not-found'
  })
  // A Claude JSONL uuid reaching this engine reads nothing at all.
  expect(await resolveCodexForkAnchor('root', '7b2f-not-a-codex-id')).toEqual({
    anchorUuid: null,
    reason: 'not-a-codex-message'
  })
  expect(mocks.history).toHaveBeenCalledTimes(3)
  expect(mocks.dispose).toHaveBeenCalledTimes(3)
})

it('reports a refused source read rather than throwing at the branch button', async () => {
  mocks.history.mockRejectedValue(new Error('native refusal'))
  expect(await resolveCodexForkAnchor('root', 'codex:["root","one","assistant"]')).toEqual({
    anchorUuid: null,
    reason: 'read-failed'
  })
  expect(mocks.dispose).toHaveBeenCalledOnce()
})

it('restores forks from session metadata, which native listing never returns', async () => {
  const root = {
    id: 'root',
    model: 'native',
    modelProvider: 'openai',
    name: 'Root',
    cwd: '/isolated',
    createdAt: 1,
    updatedAt: 2
  }
  mocks.list.mockResolvedValue([root])
  mocks.meta.mockReturnValue({
    root: { engineId: 'codex' },
    fork: { engineId: 'codex' },
    deleted: { engineId: 'codex' },
    claude: { engineId: 'claude' }
  })
  mocks.read.mockImplementation(async ({ threadId }: { threadId: string }) => {
    if (threadId !== 'fork') throw new Error('no such thread')
    return { thread: { ...root, id: 'fork', name: 'Fork', forkedFromId: 'root' } }
  })
  expect((await listCodexSessions()).map((session) => session.sessionId)).toEqual(['root', 'fork'])
  // The natively listed root is never read again, and a non-codex id never at all.
  expect(mocks.read.mock.calls.map(([params]) => params.threadId).sort()).toEqual([
    'deleted',
    'fork'
  ])
  expect(setSessionMeta).toHaveBeenCalledWith('fork', {
    engineId: 'codex',
    model: { engineId: 'codex', vendorId: 'openai', modelId: 'native' }
  })
})
