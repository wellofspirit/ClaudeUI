/**
 * The parity fold must not hide what the reducer's first-wins rules would:
 * a second terminal notification or a second result for one call fails.
 */
import { describe, expect, it } from 'vitest'
import type { OpencodeMapperOutput } from '../event-mapper'
import { foldOutputs } from '../../../test/helpers/opencode-v2-transcript'

const notification: OpencodeMapperOutput = {
  kind: 'task-notification',
  notification: {
    taskId: 'ses_c',
    toolUseId: 'call_1',
    status: 'completed',
    outputFile: '',
    summary: ''
  }
}
const message: OpencodeMapperOutput = {
  kind: 'message',
  message: {
    id: 'msg_a',
    role: 'assistant',
    timestamp: 1,
    content: [{ type: 'tool_use', toolUseId: 'call_1', toolName: 'read', toolInput: {} }]
  }
}
const result: OpencodeMapperOutput = {
  kind: 'tool-result',
  result: { toolUseId: 'call_1', result: 'x', isError: false }
}

describe('foldOutputs is strict', () => {
  it('a duplicate task-notification fails', () => {
    expect(() => foldOutputs([notification, notification])).toThrow('duplicate task-notification')
  })
  it('a duplicate tool-result fails', () => {
    expect(() => foldOutputs([message, result, result])).toThrow('duplicate tool-result')
  })
  it('one of each folds', () => {
    expect(foldOutputs([message, result, notification]).taskNotifications).toHaveLength(1)
  })
})
