/**
 * `collectAgentLinkRecords` (ADR-089 S3b, G7): what a resumed parent session
 * rebuilds its depth-1 agent records from. Pure: in-memory session entries.
 */
import { describe, expect, it } from 'vitest'
import { collectAgentLinkRecords } from '../pi-subagent-store'
import type { PiSessionEntry } from '../pi-protocol'

const A = '11111111-1111-4111-8111-111111111111'
const B = '22222222-2222-4222-8222-222222222222'
const C = '33333333-3333-4333-8333-333333333333'
const D = '44444444-4444-4444-8444-444444444444'
const E = '55555555-5555-4555-8555-555555555555'

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

describe('collectAgentLinkRecords (ADR-089 S3b review R2)', () => {
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

describe('collectAgentLinkRecords — the task (ADR-089 review F8)', () => {
  it("recovers prompt and description from the parent's own agent call input", () => {
    const call: PiSessionEntry = {
      ...base(),
      type: 'message',
      message: {
        role: 'assistant',
        content: [
          {
            type: 'toolCall',
            id: 'call-1',
            name: 'agent',
            arguments: { description: 'Scan the repo', prompt: 'THE TASK' }
          }
        ],
        api: 'a',
        provider: 'p',
        model: 'm',
        usage: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }
        },
        stopReason: 'toolUse',
        timestamp: 1
      }
    } as PiSessionEntry
    const [link] = collectAgentLinkRecords([
      call,
      agentResult('call-1', { v: 1, agentId: A, subagentType: 'g', status: 'completed' })
    ])
    expect(link).toMatchObject({ prompt: 'THE TASK', description: 'Scan the repo' })
  })
})

describe('collectAgentLinkRecords — failure (ADR-089 S1b)', () => {
  it('reads details.cuiAgent.failure; a failed link WITHOUT it stays absent (the manager treats it as transient)', () => {
    const [withField, without] = collectAgentLinkRecords([
      agentResult('call-1', {
        v: 1,
        agentId: A,
        subagentType: 'g',
        status: 'failed',
        failure: 'permanent'
      }),
      agentResult('call-2', { v: 1, agentId: B, subagentType: 'g', status: 'failed' })
    ])
    expect(withField.failure).toBe('permanent')
    expect('failure' in without).toBe(false)
  })

  it('reads failureMessage beside failure, capped to one line of at most 200 characters; absent without a failure or when not a string', () => {
    const base = { v: 1, subagentType: 'g', status: 'failed' }
    const [ok, crafted, noFailure, notString, empty] = collectAgentLinkRecords([
      agentResult('c1', { ...base, agentId: A, failure: 'permanent', failureMessage: 'too long' }),
      agentResult('c2', {
        ...base,
        agentId: B,
        failure: 'permanent',
        failureMessage: ['x'.repeat(500), 'second line'].join('\n')
      }),
      agentResult('c3', { ...base, agentId: C, failureMessage: 'orphan' }),
      agentResult('c4', { ...base, agentId: D, failure: 'permanent', failureMessage: 42 }),
      agentResult('c5', { ...base, agentId: E, failure: 'transient', failureMessage: '  ' })
    ])
    expect(ok.failureMessage).toBe('too long')
    expect(crafted.failureMessage).toBe('x'.repeat(200))
    expect('failureMessage' in noFailure).toBe(false)
    expect('failureMessage' in notString).toBe(false)
    expect('failureMessage' in empty).toBe(false)
  })

  it('validates the value: anything but transient/permanent is absent', () => {
    for (const bad of ['bogus', 3, null, {}, 'PERMANENT']) {
      const [link] = collectAgentLinkRecords([
        agentResult('call-1', {
          v: 1,
          agentId: A,
          subagentType: 'g',
          status: 'failed',
          failure: bad
        })
      ])
      expect('failure' in link, String(bad)).toBe(false)
    }
  })

  it('a notification carries the latest run failure; a later non-failed notification clears it', () => {
    const launch = agentResult('call-1', {
      v: 1,
      agentId: A,
      subagentType: 'g',
      background: true,
      status: 'async_launched'
    })
    const [failed] = collectAgentLinkRecords([
      launch,
      notification({ agentId: A, toolUseId: 'call-1', status: 'failed', failure: 'transient' })
    ])
    expect(failed).toMatchObject({ status: 'failed', failure: 'transient' })
    const [withMsg] = collectAgentLinkRecords([
      launch,
      notification({
        agentId: A,
        toolUseId: 'call-1',
        status: 'failed',
        failure: 'permanent',
        failureMessage: ['nope', 'more'].join('\n')
      })
    ])
    expect(withMsg).toMatchObject({ failure: 'permanent', failureMessage: 'nope' })
    const [resumed] = collectAgentLinkRecords([
      launch,
      notification({
        agentId: A,
        toolUseId: 'call-1',
        status: 'failed',
        failure: 'permanent',
        failureMessage: 'nope'
      }),
      notification({ agentId: A, toolUseId: 'call-1', status: 'completed', runIndex: 2 })
    ])
    expect(resumed.status).toBe('completed')
    expect('failure' in resumed).toBe(false)
    expect('failureMessage' in resumed).toBe(false)
    // An old failed notification with no field leaves the link without one.
    const [old] = collectAgentLinkRecords([
      launch,
      notification({ agentId: A, toolUseId: 'call-1', status: 'failed' })
    ])
    expect(old.status).toBe('failed')
    expect('failure' in old).toBe(false)
  })
})

describe('collectAgentLinkRecords — an isError agent result (V1a)', () => {
  it('a failed foreground agent whose toolResult is NOW marked isError still yields its link, status and failure', () => {
    const entry = agentResult('call-1', {
      v: 1,
      agentId: A,
      subagentType: 'g',
      status: 'failed',
      failure: 'permanent',
      failureMessage: 'prompt is too long'
    }) as unknown as { message: { isError: boolean } }
    entry.message.isError = true
    expect(collectAgentLinkRecords([entry as unknown as PiSessionEntry])).toEqual([
      expect.objectContaining({
        agentId: A,
        status: 'failed',
        failure: 'permanent',
        failureMessage: 'prompt is too long'
      })
    ])
  })
})
