/**
 * @vitest-environment node
 *
 * applyHandbacks — the join of a transcript's hand-back notifications with their peer rows
 * and the subagent's sidechain (the loader-level cases are in
 * src/main/services/__tests__/session-history-handback.test.ts).
 */
import { describe, it, expect, vi } from 'vitest'
import type { ChatMessage, TaskNotification } from '../../../shared/types'
import { applyHandbacks, type HandbackNotice, type SidechainCall } from '../handback-history'
import { POINTER } from './handback-frame-native'

const entry = (taskId: string): TaskNotification => ({
  taskId,
  toolUseId: null,
  status: 'completed',
  outputFile: '',
  summary: 'Agent "worker" finished'
})
const notice = (taskId: string, timestamp: number): HandbackNotice => ({
  entry: entry(taskId),
  parsed: {
    taskId,
    status: 'completed',
    summary: '',
    result: POINTER('worker'),
    outputFile: '',
    raw: `${taskId}@${timestamp}`
  },
  timestamp
})

describe('applyHandbacks', () => {
  it('reads a task’s sidechain once, however many of its notifications fall back to it', async () => {
    const calls: SidechainCall[] = [
      { timestamp: 10, message: 'one' },
      { timestamp: 20, message: 'two' },
      { timestamp: 30, message: 'three' }
    ]
    const sidechainCalls = vi.fn(async (_taskId: string) => calls)
    const notices = [notice('a1', 11), notice('a1', 21), notice('a1', 31), notice('b2', 31)]
    await applyHandbacks({ notices, peers: [], messages: [] as ChatMessage[], sidechainCalls })
    expect(notices.map((n) => n.entry.summary)).toEqual(['one', 'two', 'three', 'three'])
    expect(sidechainCalls.mock.calls.map(([id]) => id)).toEqual(['a1', 'b2'])
  })

  it('takes the last call inside the run’s window: after the previous notification, at or before this one', async () => {
    const sidechainCalls = async (): Promise<SidechainCall[]> => [
      { timestamp: 10, message: 'run one' },
      { timestamp: 20, message: 'run two (early)' },
      { timestamp: 25, message: 'run two' },
      { timestamp: 40, message: 'run three' }
    ]
    const notices = [notice('a1', 15), notice('a1', 30)]
    await applyHandbacks({ notices, peers: [], messages: [], sidechainCalls })
    expect(notices.map((n) => n.entry.summary)).toEqual(['run one', 'run two'])
  })

  it('a notification with no known time takes no call at all', async () => {
    const n = notice('a1', 15)
    delete (n as { timestamp?: number }).timestamp
    await applyHandbacks({
      notices: [n],
      peers: [],
      messages: [],
      sidechainCalls: async () => [{ timestamp: 10, message: 'x' }]
    })
    expect(n.entry.summary).toBe('Agent "worker" finished')
  })
})
