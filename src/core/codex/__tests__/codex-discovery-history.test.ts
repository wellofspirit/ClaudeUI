import { beforeEach, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { discoverCodexModels } from '../model-discovery'
import {
  listCodexSessions,
  loadCodexHistory,
  resolveCodexForkAnchor,
  scanCodexLineage
} from '../history'
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
  /**
   * The lineage cache (db v17), as a map so the tests can seed and inspect it:
   * thread id -> [lineage or null, the native `updatedAt` it was verified at].
   */
  forks: new Map<string, [string | null, number | null]>()
}))
vi.mock('../codex-locate', () => ({
  codexBinaryAvailable: () => mocks.available,
  locateCodexBinary: () => (mocks.available ? '/fixture/codex' : null)
}))
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
  recordCodexLineage: (threadId: string, forkedFromId: string | null, verifiedAt: number | null) =>
    void mocks.forks.set(threadId, [forkedFromId, verifiedAt]),
  listCodexLineage: () =>
    [...mocks.forks].map(([threadId, [forkedFromId, verifiedAt]]) => ({
      threadId,
      forkedFromId,
      verifiedAt
    })),
  listCodexForks: () =>
    [...mocks.forks]
      .filter(([threadId, [forkedFromId]]) => forkedFromId && forkedFromId !== threadId)
      .map(([threadId, [forkedFromId]]) => ({ threadId, forkedFromId }))
}))
/** The confirm pass's delay, so no test here waits the real 750 ms. */
const instant = { sleep: async (): Promise<void> => {} }

beforeEach(() => {
  vi.clearAllMocks()
  mocks.available = true
  mocks.forks.clear()
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

// ---------------------------------------------------------------------------
// The LAUNCH SCAN (db v17). Replaces the one-time adoption and the per-delete
// sweep: one `thread/list`, then a metadata read for the ids the cache cannot
// answer for. A root earns a row too, which is the whole reason the candidate
// set now shrinks instead of being every codex session forever.
// ---------------------------------------------------------------------------

const listedRoot = {
  id: 'root',
  model: 'native',
  modelProvider: 'openai',
  name: 'Root',
  cwd: '/isolated',
  createdAt: 1,
  updatedAt: 2
}

/** Every `thread/read` the scan issued, in order. */
const readIds = (): string[] => mocks.read.mock.calls.map(([params]) => params.threadId)

it('reads every unknown thread on the first launch, and nothing at all on the second', async () => {
  mocks.list.mockResolvedValue([listedRoot, { ...listedRoot, id: 'grown-fork', updatedAt: 9 }])
  mocks.meta.mockReturnValue({ root: { engineId: 'codex' }, claude: { engineId: 'claude' } })
  mocks.read.mockImplementation(async ({ threadId }: { threadId: string }) =>
    threadId === 'root'
      ? { thread: listedRoot }
      : { thread: { ...listedRoot, id: 'grown-fork', updatedAt: 9, forkedFromId: 'root' } }
  )
  expect(await scanCodexLineage({ cwd: '/isolated' }, instant)).toEqual({ read: 2, learned: 2 })
  // Both are cached WITH the `updatedAt` they were read at — the root included,
  // which is what v16 never did.
  expect([...mocks.forks]).toEqual([
    ['root', [null, 2]],
    ['grown-fork', ['root', 9]]
  ])

  // SECOND LAUNCH, same listing: nothing is read. PRE-FIX every delete plan
  // re-read every codex session_meta id, because a root never earned a row.
  mocks.read.mockClear()
  expect(await scanCodexLineage({ cwd: '/isolated' }, instant)).toEqual({ read: 0, learned: 0 })
  expect(readIds()).toEqual([])
})

it('re-reads only the thread whose native updatedAt moved', async () => {
  mocks.forks.set('root', [null, 2])
  mocks.forks.set('other', [null, 7])
  mocks.list.mockResolvedValue([
    { ...listedRoot, updatedAt: 5 },
    { ...listedRoot, id: 'other', updatedAt: 7 }
  ])
  mocks.meta.mockReturnValue({})
  mocks.read.mockResolvedValue({ thread: { ...listedRoot, updatedAt: 5, forkedFromId: null } })
  // A thread forked by another client between launches shows a new `updatedAt`;
  // one nobody touched shows the cached one and costs nothing.
  expect(await scanCodexLineage({ cwd: '/isolated' }, instant)).toEqual({ read: 1, learned: 0 })
  expect(readIds()).toEqual(['root'])
  expect(mocks.forks.get('root')).toEqual([null, 5])
})

it('reads a codex session_meta id the listing does not carry, and caches its lineage', async () => {
  // What the one-time adoption was for: a branch that predates the cache, or
  // one that has never run a turn, exists only in `session_meta`.
  mocks.list.mockResolvedValue([listedRoot])
  mocks.meta.mockReturnValue({
    root: { engineId: 'codex' },
    lost: { engineId: 'codex' },
    claude: { engineId: 'claude' }
  })
  mocks.read.mockImplementation(async ({ threadId }: { threadId: string }) =>
    threadId === 'root'
      ? { thread: listedRoot }
      : { thread: { ...listedRoot, id: 'lost', name: 'Lost branch', forkedFromId: 'root' } }
  )
  expect(await scanCodexLineage({ cwd: '/isolated' }, instant)).toEqual({ read: 2, learned: 2 })
  // A Claude id is never read at all.
  expect(readIds().sort()).toEqual(['lost', 'root'])
  expect(mocks.forks.get('lost')).toEqual(['root', 2])
})

it('tombstones a twice-refused id instead of asking about it forever', async () => {
  mocks.list.mockResolvedValue([listedRoot])
  mocks.meta.mockReturnValue({ root: { engineId: 'codex' }, gone: { engineId: 'codex' } })
  mocks.read.mockImplementation(async ({ threadId }: { threadId: string }) => {
    if (threadId === 'gone') throw new CodexTransportError('rpc-error--32600')
    return { thread: listedRoot }
  })
  await scanCodexLineage({ cwd: '/isolated' }, instant)
  // `(null, null)`: a row, so it is never a candidate again, but not a branch,
  // so it joins no delete plan and no sidebar row.
  expect(mocks.forks.get('gone')).toEqual([null, null])
  mocks.read.mockClear()
  expect(await scanCodexLineage({ cwd: '/isolated' }, instant)).toEqual({ read: 0, learned: 0 })
})

it('leaves a broken read uncached so the next launch retries it', async () => {
  mocks.list.mockResolvedValue([listedRoot])
  mocks.meta.mockReturnValue({ root: { engineId: 'codex' }, flaky: { engineId: 'codex' } })
  mocks.read.mockImplementation(async ({ threadId }: { threadId: string }) => {
    if (threadId === 'flaky') throw new CodexTransportError('request-timeout')
    return { thread: listedRoot }
  })
  await scanCodexLineage({ cwd: '/isolated' }, instant)
  expect(mocks.forks.has('flaky')).toBe(false)
  mocks.read.mockClear()
  await scanCodexLineage({ cwd: '/isolated' }, instant)
  expect(readIds()).toEqual(['flaky'])
})

it('keeps a branch whose FIRST refusal a re-read does not confirm', async () => {
  // The 2026-09-13 incident: a fresh app-server refused two live forks, the
  // adoption believed it, and both branches fell out of the sidebar and out of
  // every delete plan.
  mocks.list.mockResolvedValue([listedRoot])
  mocks.meta.mockReturnValue({ root: { engineId: 'codex' }, flaky: { engineId: 'codex' } })
  let refusals = 1
  mocks.read.mockImplementation(async ({ threadId }: { threadId: string }) => {
    if (threadId === 'flaky' && refusals-- > 0) throw new CodexTransportError('rpc-error--32600')
    if (threadId === 'root') return { thread: listedRoot }
    return { thread: { ...listedRoot, id: 'flaky', forkedFromId: 'root' } }
  })
  await scanCodexLineage({ cwd: '/isolated' }, instant)
  // PRE-FIX this was a tombstone and the branch was gone for good.
  expect(mocks.forks.get('flaky')).toEqual(['root', 2])
})

it('re-reads everything it knows in the `all` mode a refused delete asks for', async () => {
  mocks.forks.set('root', [null, 2])
  mocks.forks.set('fork', ['root', 2])
  mocks.list.mockResolvedValue([listedRoot])
  mocks.meta.mockReturnValue({ root: { engineId: 'codex' }, 'meta-only': { engineId: 'codex' } })
  mocks.read.mockResolvedValue({ thread: listedRoot })
  await scanCodexLineage({ cwd: '/isolated' }, instant, 'all')
  // `verified_at` is ignored: a cached root, a cached branch and a session_meta
  // id are all read, because the cache has just been proven incomplete.
  expect(readIds().sort()).toEqual(['fork', 'meta-only', 'root'])
})

it('reads nothing when there is no binary to ask', async () => {
  mocks.available = false
  expect(await scanCodexLineage({ cwd: '/isolated' }, instant)).toEqual({ read: 0, learned: 0 })
  expect(mocks.list).not.toHaveBeenCalled()
})

// ---------------------------------------------------------------------------
// The sidebar listing: the cheapest pass, plus the cached branches the native
// listing does not carry
// ---------------------------------------------------------------------------

it('learns the lineage of a thread that appeared while the app was running', async () => {
  mocks.forks.set('root', [null, 2])
  mocks.list.mockResolvedValue([listedRoot, { ...listedRoot, id: 'outside', forkedFromId: null }])
  mocks.meta.mockReturnValue({ root: { engineId: 'codex' } })
  mocks.read.mockResolvedValue({
    thread: { ...listedRoot, id: 'outside', forkedFromId: 'root' }
  })
  const listed = await listCodexSessions(undefined, instant)
  // A thread another client forked is listed with NO lineage on the entry, so
  // only a read can tell it from a root — and a delete plan for `root` is wrong
  // until it does.
  expect(readIds()).toEqual(['outside'])
  expect(mocks.forks.get('outside')).toEqual(['root', 2])
  // ...and being in both sources must not make it two sidebar rows.
  expect(listed.map((session) => session.sessionId)).toEqual(['root', 'outside'])
})

it('does not re-read the session the user is talking to', async () => {
  // The listing polls every 30 s and an active thread's `updatedAt` moves every
  // turn, so the sidebar pass is `new`, never `changed`.
  mocks.forks.set('root', [null, 2])
  mocks.list.mockResolvedValue([{ ...listedRoot, updatedAt: 999 }])
  mocks.meta.mockReturnValue({ root: { engineId: 'codex' } })
  await listCodexSessions(undefined, instant)
  expect(readIds()).toEqual([])
})

it('lists a cached branch the native listing omits, and tombstones one that is gone', async () => {
  mocks.list.mockResolvedValue([listedRoot])
  mocks.meta.mockReturnValue({ root: { engineId: 'codex' } })
  mocks.forks.set('root', [null, 2])
  mocks.forks.set('fresh-fork', ['root', null])
  mocks.forks.set('gone', ['root', null])
  mocks.forks.set('unreachable', ['root', null])
  mocks.read.mockImplementation(async ({ threadId }: { threadId: string }) => {
    if (threadId === 'gone') throw new CodexTransportError('rpc-error--32600')
    if (threadId === 'unreachable') throw new CodexTransportError('request-timeout')
    return { thread: { ...listedRoot, id: threadId, name: 'Fresh fork', forkedFromId: 'root' } }
  })
  expect((await listCodexSessions(undefined, instant)).map((s) => s.sessionId)).toEqual([
    'root',
    'fresh-fork'
  ])
  // Only a refusal the re-read confirmed drops the branch; a broken read keeps it.
  expect(mocks.forks.get('gone')).toEqual([null, null])
  expect(mocks.forks.get('unreachable')).toEqual(['root', null])
})

it('never treats a thread that claims itself as its own branch', async () => {
  // Defensive: a lineage pointing at itself is a chain nothing can walk.
  mocks.list.mockResolvedValue([listedRoot])
  mocks.meta.mockReturnValue({ root: { engineId: 'codex' } })
  mocks.read.mockImplementation(async () => ({ thread: { ...listedRoot, forkedFromId: 'root' } }))
  await scanCodexLineage({ cwd: '/isolated' }, instant)
  expect(mocks.forks.get('root')).toEqual([null, 2])
})

it('renders every F20 thread-item kind on the COLD path, image bytes included', async () => {
  // `history.ts` and `CodexSession.item` share `mapCodexItem`, so this is the
  // cold half of the same proof: at HEAD the mapper's `default` dropped all
  // eleven and a reloaded thread showed only its messages and commands.
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00])
  const directory = mkdtempSync(join(tmpdir(), 'codex-cold-history-'))
  const imagePath = join(directory, 'shot.png')
  writeFileSync(imagePath, png)
  try {
    mocks.history.mockResolvedValue({
      id: 'root',
      modelProvider: 'openai',
      name: null,
      createdAt: 1,
      turns: [
        {
          id: 'turn',
          status: 'completed',
          startedAt: 1,
          items: [
            {
              type: 'webSearch',
              id: 'ws',
              query: 'electron 38',
              action: { type: 'search', query: 'electron 38' },
              results: [{ title: 'Electron 38', url: 'https://electronjs.org' }]
            },
            {
              type: 'mcpToolCall',
              id: 'mcp',
              server: 'verify-stub',
              tool: 'ping',
              status: 'completed',
              arguments: {},
              appContext: null,
              pluginId: null,
              readOnlyHint: true,
              result: { content: [{ type: 'text', text: 'pong' }] },
              error: null,
              durationMs: 3
            },
            { type: 'imageView', id: 'iv', path: imagePath },
            {
              type: 'imageGeneration',
              id: 'ig',
              status: 'completed',
              revisedPrompt: 'a cat',
              result: 'QUJD',
              failure: null,
              savedPath: '/tmp/cat.png'
            },
            { type: 'sleep', id: 'zz', durationMs: 2500 },
            { type: 'plan', id: 'turn-plan', text: '## Step one' },
            { type: 'contextCompaction', id: 'cc' },
            { type: 'hookPrompt', id: 'hp', fragments: [{ text: 'policy', hookRunId: '9f2a' }] },
            {
              type: 'functionCallOutput',
              id: 'fco',
              name: 'request_user_input_async',
              namespace: null,
              output: 'answered'
            },
            { type: 'enteredReviewMode', id: 'erm', review: 'uncommitted changes' },
            { type: 'exitedReviewMode', id: 'xrm', review: '## 2 findings' }
          ]
        }
      ]
    })
    const { messages } = await loadCodexHistory('root')
    const named = (name: string): unknown =>
      messages
        .flatMap((message) => message.content)
        .find((block) => block.type === 'tool_use' && block.toolName === name)
    expect(named('webSearch')).toBeDefined()
    expect(named('mcp__verify-stub__ping')).toBeDefined()
    expect(named('imageView')).toBeDefined()
    expect(named('imageGeneration')).toBeDefined()
    expect(named('sleep')).toBeDefined()
    expect(named('plan')).toBeDefined()
    expect(named('request_user_input_async')).toBeDefined()
    const systemBlocks = messages
      .filter((message) => message.role === 'system')
      .flatMap((message) => message.content)
      .map((block) => block.type)
    expect(systemBlocks).toEqual(
      expect.arrayContaining(['compact_separator', 'context_note', 'text', 'review_result'])
    )
    // The bytes behind the `view_image` path are read on the cold path too —
    // the app-server runs where the path is local.
    // The result text is EMPTY (the path is the card header, and `FileReadBody`
    // would render it as the file's content); the BYTES are what the cold read
    // adds, so the block is found by its images and its owning tool_use.
    const viewCard = messages
      .flatMap((message) => message.content)
      .find((block) => block.type === 'tool_use' && block.toolName === 'imageView')
    const viewed = messages
      .flatMap((message) => message.content)
      .find(
        (block) =>
          block.type === 'tool_result' &&
          viewCard?.type === 'tool_use' &&
          block.toolUseId === viewCard.toolUseId
      )
    expect(viewed).toMatchObject({
      toolResult: '',
      images: [{ mediaType: 'image/png', base64Data: png.toString('base64') }]
    })
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})
