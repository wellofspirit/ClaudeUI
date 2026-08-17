/**
 * @vitest-environment node
 */
import { describe, it, expect } from 'vitest'
import { findForkAnchorUuid, findPiForkAnchorEntryId, PI_FORK_CLONE_LATEST_SENTINEL } from '../../../core/services/fork-anchor'

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
