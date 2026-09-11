import { expect, it } from 'vitest'
import { applyEvent } from '../../shared/sync/reducer'
import { emptyCanonicalState, fromSnapshot, toSnapshot } from '../../shared/sync/state'
import { resolveCodexCapabilities } from '../../../shared/model-capabilities'

it('retains effective native policy and offered approvals across rekey and reconnect', () => {
  const codex = {
    approvalPolicy: { granular: { rules: true } },
    approvalsReviewer: 'auto_review',
    sandbox: { type: 'readOnly' },
    activePermissionProfile: null,
    modelProvider: 'openai',
    reasoningEffort: 'ultra',
    effortOptions: []
  }
  let state = applyEvent(emptyCanonicalState(), {
    channel: 'session:created',
    args: ['temporary', { cwd: '/isolated', engineId: 'codex' }],
    seq: 1
  })
  state = applyEvent(state, {
    channel: 'session:status',
    args: [
      'temporary',
      {
        state: 'running',
        sessionId: 'root',
        engineId: 'codex',
        capabilities: resolveCodexCapabilities(),
        model: { engineId: 'codex', vendorId: 'openai', modelId: 'native' },
        cwd: '/isolated',
        totalCostUsd: 0,
        account: null,
        codex
      }
    ],
    seq: 2
  })
  state = applyEvent(state, {
    channel: 'session:approval-request',
    args: [
      'root',
      {
        requestId: 'approval',
        toolName: 'commandExecution',
        input: {},
        codex: { decisions: ['decline', 'cancel'], unsupportedDecisions: [] }
      }
    ],
    seq: 3
  })
  const restored = fromSnapshot(toSnapshot(state, 3))
  expect(restored.sessions.root.status.codex).toEqual(codex)
  expect(restored.sessions.root.permissionMode).toBe('default')
  expect(restored.sessions.root.pendingApprovals[0].codex?.decisions).toEqual(['decline', 'cancel'])
})

it('reconciles a host user row by identity, preserving order and native history ID', () => {
  let state = applyEvent(emptyCanonicalState(), {
    channel: 'session:created',
    args: ['root', { cwd: '/isolated', engineId: 'codex' }],
    seq: 1
  })
  state = applyEvent(state, {
    channel: 'session:user-message',
    args: ['root', { id: 'msg-host', timestamp: 1, prompt: 'same text' }],
    seq: 2
  })
  state = applyEvent(state, {
    channel: 'session:message',
    args: [
      'root',
      {
        id: 'assistant',
        role: 'assistant',
        timestamp: 2,
        content: [{ type: 'text', text: 'answer' }]
      }
    ],
    seq: 3
  })
  const message = {
    id: 'codex-native-user',
    replacesMessageId: 'msg-host',
    role: 'user',
    timestamp: 1,
    content: [{ type: 'text', text: 'same text' }]
  }
  state = applyEvent(state, { channel: 'session:message', args: ['root', message], seq: 4 })
  state = applyEvent(state, { channel: 'session:message', args: ['root', message], seq: 5 })
  const replica = fromSnapshot(toSnapshot(state, 5))
  expect(replica.sessions.root.messages.map((message) => message.id)).toEqual([
    'codex-native-user',
    'assistant'
  ])
})
