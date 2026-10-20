/**
 * @vitest-environment node
 *
 * A resumed parent's canonical seed carries the X-Agents still running (ADR-105 §5):
 * the history read puts their task records beside the transcript, and the seed has to
 * keep them, or a reopened session's roster and attention gate would not know.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const { readSessionHistory } = vi.hoisted(() => ({ readSessionHistory: vi.fn() }))
vi.mock('../../../core/services/engine-history', () => ({ readSessionHistory }))
vi.mock('../../../core/services/logger', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }
}))

import { seedCanonicalTranscript } from '../../../core/ipc/seed-canonical-transcript'
import { syncCore } from '../../../core/services/sync-host'

const history = (extra: Record<string, unknown> = {}): Record<string, unknown> => ({
  messages: [],
  taskNotifications: [],
  customTitle: null,
  statusLine: null,
  agentIdToToolUseId: {},
  warnings: [],
  ...extra
})

beforeEach(() => syncCore.resetCanonicalForTests())

describe('seedCanonicalTranscript — running X-Agents', () => {
  it('seeds the active task records the history read returned', async () => {
    const record = {
      taskId: 's-abc123',
      taskType: 'dispatch',
      isBackgrounded: true,
      wakesParent: false,
      startedAt: 5
    }
    readSessionHistory.mockResolvedValue(history({ activeTasks: { toolu_1: record } }))
    await seedCanonicalTranscript('seed-active', 'seed-active', '/cwd', undefined, 'pi')
    expect(syncCore.getCanonicalState().sessions['seed-active'].activeTasks).toEqual({
      toolu_1: record
    })
  })

  it('a read with none leaves the session’s records alone', async () => {
    readSessionHistory.mockResolvedValue(history())
    await seedCanonicalTranscript('seed-none', 'seed-none', '/cwd', undefined, 'pi')
    expect(syncCore.getCanonicalState().sessions['seed-none'].activeTasks).toEqual({})
  })
})
