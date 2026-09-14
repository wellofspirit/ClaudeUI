import { expect, it, vi } from 'vitest'
import { historyFor, readSessionHistory } from '../../services/engine-history'

const mocks = vi.hoisted(() => ({
  claude: vi.fn(),
  codex: vi.fn(),
  anchor: vi.fn(),
  deleteThread: vi.fn(async () => {})
}))
vi.mock('../../services/db', () => ({
  getSessionMeta: (id: string) => (id === 'native' ? { engineId: 'codex' } : undefined)
}))
vi.mock('../../services/session-history', () => ({ loadSessionHistory: mocks.claude }))
vi.mock('../history', () => ({
  loadCodexHistory: mocks.codex,
  listCodexSessions: vi.fn(),
  resolveCodexForkAnchor: mocks.anchor
}))
vi.mock('../delete', () => ({ deleteCodexThread: mocks.deleteThread }))

it('routes metadata-owned native reads without touching Claude files', async () => {
  const result = {
    messages: [],
    taskNotifications: [],
    customTitle: null,
    statusLine: null,
    agentIdToToolUseId: {},
    warnings: []
  }
  mocks.codex.mockResolvedValue(result)
  expect(await readSessionHistory('native', 'unused')).toBe(result)
  expect(mocks.codex).toHaveBeenCalledExactlyOnceWith('native')
  expect(mocks.claude).not.toHaveBeenCalled()
  expect(() => readSessionHistory('native', 'unused', undefined, 'claude')).toThrow(
    'does not match'
  )
  expect(mocks.claude).not.toHaveBeenCalled()
  expect(() => historyFor('unknown')).toThrow('Unsupported history engine')
})

it('retains the explicit legacy-Claude rule only for missing metadata', async () => {
  mocks.claude.mockResolvedValue({ messages: [] })
  await readSessionHistory('legacy', 'project', 'anchor')
  expect(mocks.claude).toHaveBeenCalledWith('legacy', 'project', 'anchor')
})

it('routes the codex branch anchor to the native turn resolver', async () => {
  mocks.anchor.mockResolvedValue({ anchorUuid: 'turn-1' })
  expect(
    await historyFor('codex').forkAnchor('root', '/isolated', 'codex:["root","turn-1"]', 3)
  ).toEqual({ anchorUuid: 'turn-1' })
  expect(mocks.anchor).toHaveBeenCalledExactlyOnceWith(
    'root',
    'codex:["root","turn-1"]',
    expect.objectContaining({ cwd: '/isolated' })
  )
})

it('seeds a codex branch from the source truncated at its anchor turn', async () => {
  const result = { messages: [], taskNotifications: [], customTitle: null, statusLine: null }
  mocks.codex.mockResolvedValue(result)
  expect(await historyFor('codex').read('root', 'project', 'turn-1')).toBe(result)
  expect(mocks.codex).toHaveBeenLastCalledWith('root', undefined, 'turn-1')
})

/**
 * The codex `delete` entry was `unsupported` — it threw for every caller — so
 * nothing engine-neutral could remove a Codex session. It is the LEAF case now:
 * one thread, no subtree, because this seam takes one id and has nowhere to put
 * a plan. A branched session goes through `handlers-core.deleteSession`'s walk,
 * which calls the same native delete per node.
 */
it('deletes one codex thread natively instead of refusing', async () => {
  await historyFor('codex').delete('thread-1', 'unused-project-key')
  expect(mocks.deleteThread).toHaveBeenCalledExactlyOnceWith('thread-1')
})
