/**
 * `collectAgentLinkRecords` (ADR-088 S3b, G7): what a resumed parent session
 * rebuilds its depth-1 agent records from. Pure: in-memory session entries.
 */
import { describe, expect, it } from 'vitest'
import { collectAgentLinkRecords } from '../pi-subagent-store'
import type { PiSessionEntry } from '../pi-protocol'

const A = '11111111-1111-4111-8111-111111111111'
const B = '22222222-2222-4222-8222-222222222222'

let seq = 0
const base = () => ({ id: `e${seq++}`, parentId: null, timestamp: '2024-01-01T00:00:00.000Z' })

function agentResult(callId: string, cuiAgent: Record<string, unknown>): PiSessionEntry {
  return {
    ...base(),
    type: 'message',
    message: {
      role: 'toolResult',
      toolCallId: callId,
      toolName: 'agent',
      content: [{ type: 'text', text: 'x' }],
      details: { cuiAgent },
      isError: false,
      timestamp: 1
    }
  } as PiSessionEntry
}

function notification(details: Record<string, unknown>): PiSessionEntry {
  return {
    ...base(),
    type: 'custom_message',
    customType: 'claudeui-agent-message',
    content: [{ type: 'text', text: 'n' }],
    display: true,
    details: { v: 1, kind: 'task-notification', deliveryId: `d${seq}`, title: 't', ...details }
  } as PiSessionEntry
}

describe('collectAgentLinkRecords (ADR-088 S3b review R2)', () => {
  it("reads a foreground link's cuiAgent (stoppedBy included)", () => {
    expect(
      collectAgentLinkRecords([
        agentResult('call-1', {
          v: 1,
          agentId: A,
          subagentType: 'Explore',
          name: 'scout',
          description: 'Scan',
          status: 'stopped',
          stoppedBy: 'user',
          model: 'openai-codex/m'
        })
      ])
    ).toEqual([
      {
        agentId: A,
        originToolUseId: 'call-1',
        subagentType: 'Explore',
        name: 'scout',
        description: 'Scan',
        model: 'openai-codex/m',
        background: false,
        status: 'stopped',
        stoppedBy: 'user'
      }
    ])
  })

  it('a background launch takes its status from the notification; the LATEST notification wins', () => {
    const [link] = collectAgentLinkRecords([
      agentResult('call-1', {
        v: 1,
        agentId: A,
        subagentType: 'general-purpose',
        background: true,
        status: 'async_launched',
        model: 'm'
      }),
      notification({ agentId: A, toolUseId: 'call-1', status: 'completed', runIndex: 1 }),
      notification({
        agentId: A,
        toolUseId: 'call-1',
        status: 'stopped',
        stoppedBy: 'user',
        runIndex: 2
      })
    ])
    expect(link).toMatchObject({ background: true, status: 'stopped', stoppedBy: 'user' })
    const [later] = collectAgentLinkRecords([
      agentResult('call-1', {
        v: 1,
        agentId: A,
        subagentType: 'g',
        background: true,
        status: 'async_launched'
      }),
      notification({ agentId: A, toolUseId: 'call-1', status: 'stopped', stoppedBy: 'user' }),
      notification({ agentId: A, toolUseId: 'call-1', status: 'completed' })
    ])
    expect(later).toMatchObject({ status: 'completed', stoppedBy: null })
  })

  it('ignores an invalid id, a notification with a mismatched agent id, and one with no link', () => {
    const links = collectAgentLinkRecords([
      agentResult('call-bad', { v: 1, agentId: '../x', subagentType: 'g', status: 'completed' }),
      agentResult('call-1', { v: 1, agentId: A, subagentType: 'g', status: 'completed' }),
      notification({ agentId: B, toolUseId: 'call-1', status: 'stopped', stoppedBy: 'user' }),
      notification({ agentId: B, toolUseId: 'call-nolink', status: 'completed' })
    ])
    expect(links).toEqual([
      expect.objectContaining({
        agentId: A,
        originToolUseId: 'call-1',
        status: 'completed',
        stoppedBy: null
      })
    ])
  })
})
