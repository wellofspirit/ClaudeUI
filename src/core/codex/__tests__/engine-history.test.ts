import { expect, it, vi } from 'vitest'
import { historyFor, readSessionHistory } from '../../services/engine-history'

const mocks = vi.hoisted(() => ({ claude: vi.fn(), codex: vi.fn(), anchor: vi.fn() }))
vi.mock('../../services/db', () => ({
  getSessionMeta: (id: string) => (id === 'native' ? { engineId: 'codex' } : undefined)
}))
vi.mock('../../services/session-history', () => ({ loadSessionHistory: mocks.claude }))
vi.mock('../history', () => ({
  loadCodexHistory: mocks.codex,
  listCodexSessions: vi.fn(),
  resolveCodexForkAnchor: mocks.anchor
}))

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
