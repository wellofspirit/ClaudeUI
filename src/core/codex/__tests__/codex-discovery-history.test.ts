import { beforeEach, expect, it, vi } from 'vitest'
import { discoverCodexModels } from '../model-discovery'
import { listCodexSessions, loadCodexHistory, resolveCodexForkAnchor } from '../history'
import { setSessionMeta } from '../../services/db'
import { CodexTransportError } from '../CodexAppServerClient'

const mocks = vi.hoisted(() => ({
  available: true,
  models: vi.fn(),
  config: vi.fn(),
  history: vi.fn(),
  list: vi.fn(),
  read: vi.fn(),
  meta: vi.fn(() => ({}) as Record<string, { engineId: string }>),
  dispose: vi.fn(),
  /** The fork registry (db v16), as a map so the tests can seed and inspect it. */
  forks: new Map<string, string | null>(),
  swept: { done: false }
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
  ensureCodexSessionOverrides: vi.fn(),
  registerCodexFork: (threadId: string, forkedFromId: string | null) => {
    if (!mocks.forks.has(threadId)) mocks.forks.set(threadId, forkedFromId)
  },
  listCodexForks: () =>
    [...mocks.forks].map(([threadId, forkedFromId]) => ({ threadId, forkedFromId })),
  deleteCodexFork: (threadId: string) => void mocks.forks.delete(threadId),
  codexForkSweepDone: () => mocks.swept.done,
  markCodexForkSweepDone: () => void (mocks.swept.done = true)
}))
beforeEach(() => {
  vi.clearAllMocks()
  mocks.available = true
  mocks.forks.clear()
  mocks.swept.done = false
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

it('adopts pre-registry forks once, then reads only what the registry holds', async () => {
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
  // What the sweep found is now REGISTERED, so the next refresh reads it
  // directly. `deleted` failed with a non-definitive error, so the sweep is not
  // marked done and it is retried — once it is refused definitively it is gone
  // from the round for good (the prune test below).
  expect([...mocks.forks]).toEqual([['fork', 'root']])
})

it('never sweeps session metadata again once the registry has been adopted', async () => {
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
  // A table full of ids the native list omits — every one of which the old
  // sweep re-probed on EVERY refresh. None of them may be read now.
  mocks.meta.mockReturnValue({
    root: { engineId: 'codex' },
    'deleted-last-week': { engineId: 'codex' },
    'deleted-behind-our-back': { engineId: 'codex' },
    claude: { engineId: 'claude' }
  })
  mocks.swept.done = true
  mocks.forks.set('fork', 'root')
  mocks.read.mockImplementation(async ({ threadId }: { threadId: string }) => {
    if (threadId !== 'fork') throw new Error('no such thread')
    return { thread: { ...root, id: 'fork', name: 'Fork', forkedFromId: 'root' } }
  })
  expect((await listCodexSessions()).map((session) => session.sessionId)).toEqual(['root', 'fork'])
  expect(mocks.read.mock.calls.map(([params]) => params.threadId)).toEqual(['fork'])
})

it('prunes a definitively refused fork and keeps one whose read merely broke', async () => {
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
  mocks.meta.mockReturnValue({ root: { engineId: 'codex' } })
  mocks.swept.done = true
  mocks.forks.set('gone', 'root')
  mocks.forks.set('unreachable', 'root')
  mocks.read.mockImplementation(async ({ threadId }: { threadId: string }) => {
    // `-32600` is the app-server's answer for a thread it cannot resolve at all
    // ("thread not loaded: <id>" / "invalid thread id"); an IO or transport
    // failure is `-32603` or a transport code, never this.
    if (threadId === 'gone') throw new CodexTransportError('rpc-error--32600')
    throw new CodexTransportError('request-timeout')
  })
  expect((await listCodexSessions()).map((session) => session.sessionId)).toEqual(['root'])
  expect([...mocks.forks.keys()]).toEqual(['unreachable'])
})

it('reconstructs a spawned child transcript under its parent card on a cold read', async () => {
  const spawn = {
    type: 'collabAgentToolCall',
    id: 'collab-1',
    tool: 'spawnAgent',
    status: 'completed',
    senderThreadId: 'root',
    receiverThreadIds: ['child'],
    prompt: 'survey the tests',
    model: 'native',
    reasoningEffort: 'ultra',
    agentsStates: { child: { status: 'completed', message: null } }
  }
  const threads: Record<string, unknown> = {
    root: {
      id: 'root',
      modelProvider: 'openai',
      name: null,
      createdAt: 1,
      turns: [{ id: 'one', status: 'completed', startedAt: 1, items: [spawn] }]
    },
    child: {
      id: 'child',
      modelProvider: 'openai',
      name: null,
      createdAt: 2,
      turns: [
        {
          id: 'c1',
          status: 'completed',
          startedAt: 2,
          items: [
            { type: 'agentMessage', id: 'm1', text: 'three gaps' },
            {
              type: 'commandExecution',
              id: 'k1',
              command: 'ls',
              cwd: '/isolated',
              status: 'completed',
              exitCode: 0,
              aggregatedOutput: 'files'
            }
          ]
        }
      ]
    }
  }
  mocks.history.mockImplementation(async (id: string) => threads[id])
  const history = await loadCodexHistory('root')
  expect(history.messages).toHaveLength(1)
  const card = 'codex:["root","one","collab-1"]'
  expect(history.subagentMessages?.[card]?.map((message) => message.id)).toEqual([
    'codex:["child","c1","m1"]',
    'codex:["child","c1","k1"]'
  ])
  // The child's own tool results ride inside its messages, exactly as the live
  // `session:subagent-tool-result` path folds them in.
  expect(
    history.subagentMessages![card][1].content.some((block) => block.type === 'tool_result')
  ).toBe(true)
})

it('never fails a cold read because one child thread is gone', async () => {
  const spawn = {
    type: 'collabAgentToolCall',
    id: 'collab-1',
    tool: 'spawnAgent',
    status: 'completed',
    senderThreadId: 'root',
    receiverThreadIds: ['child'],
    prompt: 'go',
    model: 'native',
    reasoningEffort: 'ultra',
    agentsStates: {}
  }
  mocks.history.mockImplementation(async (id: string) => {
    if (id === 'root')
      return {
        id: 'root',
        modelProvider: 'openai',
        name: null,
        createdAt: 1,
        turns: [{ id: 'one', status: 'completed', startedAt: 1, items: [spawn] }]
      }
    throw new Error('thread not found: child')
  })
  const history = await loadCodexHistory('root')
  expect(history.messages).toHaveLength(1)
  expect(history.subagentMessages).toEqual({})
})

it('reconstructs a v2 child from its subAgentActivity pair on a cold read', async () => {
  const threads: Record<string, unknown> = {
    root: {
      id: 'root',
      modelProvider: 'openai',
      name: null,
      createdAt: 1,
      turns: [
        {
          id: 'one',
          status: 'completed',
          startedAt: 1,
          items: [
            {
              type: 'subAgentActivity',
              id: 'spawn-call',
              kind: 'started',
              agentThreadId: 'child',
              agentPath: '/root/fixture_child'
            },
            {
              type: 'subAgentActivity',
              id: 'subagent-completed-c1',
              kind: 'completed',
              agentThreadId: 'child',
              agentPath: '/root/fixture_child'
            }
          ]
        }
      ]
    },
    child: {
      id: 'child',
      modelProvider: 'openai',
      name: null,
      createdAt: 2,
      turns: [
        {
          id: 'c1',
          status: 'completed',
          startedAt: 2,
          items: [{ type: 'agentMessage', id: 'm1', text: 'v2 child done' }]
        }
      ]
    }
  }
  mocks.history.mockImplementation(async (id: string) => threads[id])
  const history = await loadCodexHistory('root')
  const card = 'codex:["root","one","spawn-call"]'
  // The started activity is the card; the completed one, whose id is its own,
  // closes it.
  expect(history.messages).toHaveLength(1)
  expect(history.messages[0].content).toEqual([
    expect.objectContaining({ type: 'tool_use', toolUseId: card, toolName: 'collab:spawnAgent' }),
    expect.objectContaining({
      type: 'tool_result',
      toolUseId: card,
      toolResult: 'Agent completed.'
    })
  ])
  expect(history.subagentMessages?.[card]?.map((message) => message.id)).toEqual([
    'codex:["child","c1","m1"]'
  ])
})
