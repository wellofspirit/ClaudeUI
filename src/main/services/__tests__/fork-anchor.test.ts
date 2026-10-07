/**
 * @vitest-environment node
 */
import { describe, it, expect } from 'vitest'
import {
  findForkAnchorUuid,
  findPiForkAnchorEntryId,
  PI_FORK_CLONE_LATEST_SENTINEL
} from '../../../core/services/fork-anchor'

// Minimal JSONL line builders mirroring the cli.js transcript shape.
const userLine = (uuid: string, text: string): Record<string, unknown> => ({
  type: 'user',
  uuid,
  message: { role: 'user', content: [{ type: 'text', text }] }
})

const assistantText = (uuid: string, msgId: string, text: string): Record<string, unknown> => ({
  type: 'assistant',
  uuid,
  message: { id: msgId, role: 'assistant', content: [{ type: 'text', text }] }
})

const assistantTools = (
  uuid: string,
  msgId: string,
  toolUseIds: string[]
): Record<string, unknown> => ({
  type: 'assistant',
  uuid,
  message: {
    id: msgId,
    role: 'assistant',
    content: toolUseIds.map((id) => ({ type: 'tool_use', id, name: 'Bash', input: {} }))
  }
})

const toolResultLine = (uuid: string, toolUseIds: string[]): Record<string, unknown> => ({
  type: 'user',
  uuid,
  message: {
    role: 'user',
    content: toolUseIds.map((id) => ({ type: 'tool_result', tool_use_id: id, content: 'ok' }))
  }
})

// The lines cli.js writes around a background agent's completion (shapes from a
// real 2.1.290 transcript, trimmed).
const AGENT = 'a590150601107b985'
const notificationXml = (agentId: string): string =>
  `<task-notification>\n<task-id>${agentId}</task-id>\n<status>completed</status>\n` +
  `<summary>Agent "sleep" finished</summary>\n</task-notification>`

/** The agent's handback note: an isMeta user line, origin `peer`. */
const handbackLine = (uuid: string): Record<string, unknown> => ({
  type: 'user',
  uuid,
  isMeta: true,
  origin: { kind: 'peer', from: AGENT, handback: true },
  message: { role: 'user', content: 'Another Claude session sent a message: <agent-message …>' }
})

/** Queue bookkeeping: no uuid. */
const queueOp = (operation: string, content?: string): Record<string, unknown> => ({
  type: 'queue-operation',
  operation,
  ...(content ? { content } : {})
})

/** A delivered completion, as the turn-starting user line. */
const notificationLine = (uuid: string, agentId = AGENT): Record<string, unknown> => ({
  type: 'user',
  uuid,
  origin: { kind: 'task-notification', producer: 'session-task' },
  message: { role: 'user', content: notificationXml(agentId) }
})

/** A delivered completion absorbed mid-turn, as a queued_command attachment. */
const queuedNotification = (uuid: string, agentId: string): Record<string, unknown> => ({
  type: 'attachment',
  uuid,
  attachment: {
    type: 'queued_command',
    commandMode: 'task-notification',
    prompt: notificationXml(agentId)
  }
})

describe('findForkAnchorUuid', () => {
  it('returns the assistant line uuid for a text-only turn', () => {
    const lines = [
      userLine('u1', 'hi'),
      assistantText('a1', 'msg_1', 'hello'),
      userLine('u2', 'again'),
      assistantText('a2', 'msg_2', 'world')
    ]
    expect(findForkAnchorUuid(lines, 'msg_1')).toBe('a1')
    expect(findForkAnchorUuid(lines, 'msg_2')).toBe('a2')
  })

  it('snaps forward past the trailing tool_result so the prefix stays balanced', () => {
    const lines = [
      userLine('u1', 'run it'),
      assistantTools('a1', 'msg_1', ['tool_1']),
      toolResultLine('tr1', ['tool_1']),
      assistantText('a2', 'msg_2', 'done')
    ]
    // Anchoring on a1 alone would drop tr1 → dangling tool_use. Expect tr1.
    expect(findForkAnchorUuid(lines, 'msg_1')).toBe('tr1')
  })

  it('includes multiple tool_results across several lines for the same turn', () => {
    const lines = [
      userLine('u1', 'do two things'),
      assistantTools('a1', 'msg_1', ['t1', 't2']),
      toolResultLine('tr1', ['t1']),
      toolResultLine('tr2', ['t2']),
      assistantText('a2', 'msg_2', 'both done')
    ]
    expect(findForkAnchorUuid(lines, 'msg_1')).toBe('tr2')
  })

  it('stops at the next assistant turn and does not consume unrelated results', () => {
    const lines = [
      userLine('u1', 'q'),
      assistantTools('a1', 'msg_1', ['t1']),
      toolResultLine('tr1', ['t1']),
      assistantTools('a2', 'msg_2', ['t2']),
      toolResultLine('tr2', ['t2'])
    ]
    // Forking from msg_1 must not swallow msg_2's result tr2.
    expect(findForkAnchorUuid(lines, 'msg_1')).toBe('tr1')
    expect(findForkAnchorUuid(lines, 'msg_2')).toBe('tr2')
  })

  it('falls back to a direct line-uuid match', () => {
    const lines = [userLine('u1', 'hi'), assistantText('a1', 'msg_1', 'hello')]
    expect(findForkAnchorUuid(lines, 'a1')).toBe('a1')
    expect(findForkAnchorUuid(lines, 'u1')).toBe('u1')
  })

  it('returns null when the message id is not found', () => {
    const lines = [assistantText('a1', 'msg_1', 'hello')]
    expect(findForkAnchorUuid(lines, 'msg_missing')).toBeNull()
  })

  it('prefers the last line sharing a message id (defensive against partials)', () => {
    const lines = [assistantText('a1', 'msg_1', 'partial'), assistantText('a1b', 'msg_1', 'final')]
    expect(findForkAnchorUuid(lines, 'msg_1')).toBe('a1b')
  })
  describe('completions delivered right after the turn stay in the branch', () => {
    // Cut before the notification, the fork's first send makes cli.js reap the
    // agent as "didn't finish before the previous session ended".
    it('the real shape: forking the reply anchors on the notification after it (GUARD)', () => {
      const lines = [
        userLine('u1', 'start an agent'),
        handbackLine('hb'),
        queueOp('enqueue', notificationXml(AGENT)),
        assistantText('a1', 'msg_1', 'The background agent ran `sleep 45` and replied "done".'),
        queueOp('dequeue'),
        notificationLine('n1')
      ]
      expect(findForkAnchorUuid(lines, 'msg_1')).toBe('n1')
    })

    it('two deliveries in a row, a user line then a queued_command attachment: the last wins', () => {
      const lines = [
        userLine('u1', 'start two agents'),
        assistantText('a1', 'msg_1', 'both launched'),
        queueOp('dequeue'),
        notificationLine('n1', 'agentA'),
        { type: 'attachment', uuid: 'env', attachment: { type: 'environment' } },
        queuedNotification('n2', 'agentB'),
        { type: 'system', uuid: 's1', subtype: 'informational' }
      ]
      expect(findForkAnchorUuid(lines, 'msg_1')).toBe('n2')
    })

    it('a completion after a real prompt or another assistant line does not move the anchor', () => {
      const afterPrompt = [
        assistantText('a1', 'msg_1', 'reply'),
        userLine('u2', 'next question'),
        notificationLine('n1')
      ]
      expect(findForkAnchorUuid(afterPrompt, 'msg_1')).toBe('a1')

      const afterAssistant = [
        assistantText('a1', 'msg_1', 'reply'),
        assistantText('a2', 'msg_2', 'more'),
        notificationLine('n1')
      ]
      expect(findForkAnchorUuid(afterAssistant, 'msg_1')).toBe('a1')

      const afterSteer = [
        assistantText('a1', 'msg_1', 'reply'),
        {
          type: 'attachment',
          uuid: 'steer',
          attachment: { type: 'queued_command', commandMode: 'prompt', prompt: 'also do X' }
        },
        queuedNotification('n1', AGENT)
      ]
      expect(findForkAnchorUuid(afterSteer, 'msg_1')).toBe('a1')
    })

    it('a plain user line with no notification is not a delivery', () => {
      // `<task-notification>` text typed by a human (origin `human`) is a prompt.
      const lines = [
        assistantText('a1', 'msg_1', 'reply'),
        {
          type: 'user',
          uuid: 'typed',
          origin: { kind: 'human' },
          message: { role: 'user', content: notificationXml(AGENT) }
        }
      ]
      expect(findForkAnchorUuid(lines, 'msg_1')).toBe('a1')
    })

    it('a tool-using turn balances first, then a following notification moves it further', () => {
      const lines = [
        userLine('u1', 'run it'),
        assistantTools('a1', 'msg_1', ['t1']),
        toolResultLine('tr1', ['t1']),
        queueOp('dequeue'),
        queuedNotification('n1', AGENT),
        assistantText('a2', 'msg_2', 'done'),
        notificationLine('n2', 'later')
      ]
      expect(findForkAnchorUuid(lines, 'msg_1')).toBe('n1')
      // Forking the later reply picks up the delivery after it, not the earlier one.
      expect(findForkAnchorUuid(lines, 'msg_2')).toBe('n2')
    })

    it('the tool_result of the next turn stops the walk', () => {
      const lines = [
        assistantTools('a1', 'msg_1', ['t1']),
        toolResultLine('tr1', ['t1']),
        toolResultLine('tr-other', ['t9']),
        notificationLine('n1')
      ]
      expect(findForkAnchorUuid(lines, 'msg_1')).toBe('tr1')
    })
  })
})

describe('findPiForkAnchorEntryId', () => {
  const u = (id: string) => ({ id, role: 'user' })
  const a = (id: string) => ({ id, role: 'assistant' })
  const sys = (id: string) => ({ id, role: 'system' })

  it('forking an earlier assistant returns the FOLLOWING user entry id', () => {
    const messages = [u('u1'), a('a1'), u('u2'), a('a2')]
    // Fork at a1 (index 1) — the next user turn (u2) is what gets dropped.
    expect(findPiForkAnchorEntryId(messages, 1)).toBe('u2')
  })

  it('forking the LATEST assistant message returns the clone-latest sentinel (nothing to drop)', () => {
    const messages = [u('u1'), a('a1'), u('u2'), a('a2')]
    expect(findPiForkAnchorEntryId(messages, 3)).toBe(PI_FORK_CLONE_LATEST_SENTINEL)
  })

  it('skips a system (compaction) slot between the target and the next user turn', () => {
    const messages = [u('u1'), a('a1'), sys('c1'), u('u2'), a('a2')]
    expect(findPiForkAnchorEntryId(messages, 1)).toBe('u2')
  })

  it('returns null when the index is out of range (message not yet flushed to disk)', () => {
    const messages = [u('u1'), a('a1')]
    expect(findPiForkAnchorEntryId(messages, 5)).toBeNull()
    expect(findPiForkAnchorEntryId(messages, -1)).toBeNull()
  })

  it('an empty message list always returns null', () => {
    expect(findPiForkAnchorEntryId([], 0)).toBeNull()
  })
})
