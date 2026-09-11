import { expect, it, vi } from 'vitest'
import { historyFor, readSessionHistory } from '../../services/engine-history'

const mocks = vi.hoisted(() => ({ claude: vi.fn(), codex: vi.fn() }))
vi.mock('../../services/db', () => ({
  getSessionMeta: (id: string) => (id === 'native' ? { engineId: 'codex' } : undefined)
}))
vi.mock('../../services/session-history', () => ({ loadSessionHistory: mocks.claude }))
vi.mock('../history', () => ({ loadCodexHistory: mocks.codex, listCodexSessions: vi.fn() }))

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
