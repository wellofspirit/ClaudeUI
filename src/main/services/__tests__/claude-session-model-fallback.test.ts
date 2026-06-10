/**
 * @vitest-environment node
 *
 * Behavioural tests for model-fallback warning plumbing in ClaudeSession
 * (docs/protocol/04-system-subtypes.md §4.20–4.21):
 *
 *   1. `model_refusal_fallback` / `model_fallback` system messages emit a
 *      `session:warning` event carrying the CLI's human-readable `content`.
 *
 *   2. When `content` is absent (older CLI), a sensible fallback text is
 *      composed from original_model/fallback_model, distinguishing the
 *      session-sticky refusal swap from the turn-scoped availability swap.
 *
 *   3. Other system subtypes do not emit warnings.
 *
 * We mirror the real handler into a tiny in-file replica (same approach as
 * claude-session-permissions.test.ts) to avoid pulling Electron / SDK deps.
 */
import { describe, it, expect } from 'vitest'

interface SystemMsg {
  type: 'system'
  subtype?: string
  trigger?: string
  original_model?: string
  fallback_model?: string
  content?: string
  retracted_message_uuids?: string[]
}

interface ChatMsg {
  id: string
}

// Mirrors RETRACTION_UUID_PREFIX_LEN in claude-session.ts (cli.js JWK = 24)
const RETRACTION_UUID_PREFIX_LEN = 24

class TestClaudeSession {
  sent: Array<{ channel: string; args: unknown[] }> = []
  messageHistory: ChatMsg[] = []
  wireUuidToMessageId = new Map<string, string>()

  private send(channel: string, ...args: unknown[]): void {
    this.sent.push({ channel, args })
  }

  // Mirrors the mapping recorded in handleAssistantMessage
  recordAssistantFrame(wireUuid: string, chatMsgId: string): void {
    this.wireUuidToMessageId.set(wireUuid.slice(0, RETRACTION_UUID_PREFIX_LEN), chatMsgId)
    if (!this.messageHistory.some((m) => m.id === chatMsgId)) {
      this.messageHistory.push({ id: chatMsgId })
    }
  }

  // Mirrors ClaudeSession.handleSystemMessage's fallback branch + handleModelFallback
  handleSystemMessage(msg: SystemMsg): void {
    if (msg.subtype === 'model_refusal_fallback' || msg.subtype === 'model_fallback') {
      this.handleModelFallback(msg)
    }
  }

  private handleModelFallback(msg: SystemMsg): void {
    const fallbackText =
      msg.subtype === 'model_refusal_fallback'
        ? `${msg.original_model || 'The model'} refused this request — switched to ${msg.fallback_model || 'a fallback model'} for the rest of the session.`
        : `${msg.original_model || 'The model'} is unavailable — using ${msg.fallback_model || 'a fallback model'} for this turn.`
    const text = msg.content || fallbackText
    this.send('session:warning', text)

    if (msg.subtype === 'model_refusal_fallback') {
      const retracted = msg.retracted_message_uuids ?? []
      const messageIds = [
        ...new Set(
          retracted
            .map((u) => this.wireUuidToMessageId.get(u.slice(0, RETRACTION_UUID_PREFIX_LEN)))
            .filter((id): id is string => !!id)
        )
      ]
      if (messageIds.length > 0) {
        this.messageHistory = this.messageHistory.filter((m) => !messageIds.includes(m.id))
      }
      this.send('session:messages-retracted', { messageIds })
    }
  }
}

describe('ClaudeSession model fallback warnings', () => {
  it('model_refusal_fallback with CLI content forwards the content verbatim', () => {
    const s = new TestClaudeSession()
    const content =
      "Fable 5's safety measures flagged this message. Switched to Opus 4.8."
    s.handleSystemMessage({
      type: 'system',
      subtype: 'model_refusal_fallback',
      trigger: 'refusal',
      original_model: 'claude-fable-5[1m]',
      fallback_model: 'claude-opus-4-8',
      content,
    })

    const warnings = s.sent.filter((e) => e.channel === 'session:warning')
    expect(warnings).toEqual([{ channel: 'session:warning', args: [content] }])
  })

  it('model_refusal_fallback without content composes a session-sticky message', () => {
    const s = new TestClaudeSession()
    s.handleSystemMessage({
      type: 'system',
      subtype: 'model_refusal_fallback',
      original_model: 'claude-fable-5[1m]',
      fallback_model: 'claude-opus-4-8',
    })

    const warnings = s.sent.filter((e) => e.channel === 'session:warning')
    expect(warnings).toHaveLength(1)
    const text = warnings[0].args[0] as string
    expect(text).toContain('claude-fable-5[1m]')
    expect(text).toContain('claude-opus-4-8')
    expect(text).toContain('rest of the session')
  })

  it('model_fallback without content composes a turn-scoped message', () => {
    const s = new TestClaudeSession()
    s.handleSystemMessage({
      type: 'system',
      subtype: 'model_fallback',
      trigger: 'overloaded',
      original_model: 'claude-opus-4-8',
      fallback_model: 'claude-sonnet-4-6',
    })

    expect(s.sent).toHaveLength(1)
    const text = s.sent[0].args[0] as string
    expect(text).toContain('claude-opus-4-8')
    expect(text).toContain('claude-sonnet-4-6')
    expect(text).toContain('this turn')
  })

  it('other system subtypes do not emit warnings', () => {
    const s = new TestClaudeSession()
    s.handleSystemMessage({ type: 'system', subtype: 'compact_boundary' })
    s.handleSystemMessage({ type: 'system', subtype: 'init' })

    expect(s.sent).toEqual([])
  })
})

describe('refusal retraction (retracted_message_uuids)', () => {
  const WIRE_UUID = '2d0d7e37-f0cb-4d75-b0d0-ce157ad0e1aa'

  it('evicts mapped messages and emits session:messages-retracted', () => {
    const s = new TestClaudeSession()
    s.recordAssistantFrame(WIRE_UUID, 'msg_refused')
    s.recordAssistantFrame('11111111-2222-3333-4444-555555555555', 'msg_keep')

    s.handleSystemMessage({
      type: 'system',
      subtype: 'model_refusal_fallback',
      retracted_message_uuids: [WIRE_UUID],
    })

    expect(s.messageHistory).toEqual([{ id: 'msg_keep' }])
    const retraction = s.sent.find((e) => e.channel === 'session:messages-retracted')
    expect(retraction?.args[0]).toEqual({ messageIds: ['msg_refused'] })
  })

  it('matches per-block derived uuids by 24-char prefix (cli.js JWK convention)', () => {
    const s = new TestClaudeSession()
    s.recordAssistantFrame(WIRE_UUID, 'msg_refused')

    // Derived uuid: same first 24 chars, different tail
    const derived = WIRE_UUID.slice(0, 24) + 'ffffffffffff'
    s.handleSystemMessage({
      type: 'system',
      subtype: 'model_refusal_fallback',
      retracted_message_uuids: [derived],
    })

    expect(s.messageHistory).toEqual([])
  })

  it('unknown uuids are a no-op but the event still fires (clears streaming)', () => {
    const s = new TestClaudeSession()
    s.recordAssistantFrame(WIRE_UUID, 'msg_keep')

    s.handleSystemMessage({
      type: 'system',
      subtype: 'model_refusal_fallback',
      retracted_message_uuids: ['99999999-8888-7777-6666-555555555555'],
    })

    expect(s.messageHistory).toEqual([{ id: 'msg_keep' }])
    const retraction = s.sent.find((e) => e.channel === 'session:messages-retracted')
    expect(retraction?.args[0]).toEqual({ messageIds: [] })
  })

  it('dedupes multiple uuids resolving to the same message (partial frames)', () => {
    const s = new TestClaudeSession()
    s.recordAssistantFrame(WIRE_UUID, 'msg_refused')
    s.recordAssistantFrame('ab0d7e37-f0cb-4d75-b0d0-ce157ad0e1bb', 'msg_refused')

    s.handleSystemMessage({
      type: 'system',
      subtype: 'model_refusal_fallback',
      retracted_message_uuids: [WIRE_UUID, 'ab0d7e37-f0cb-4d75-b0d0-ce157ad0e1bb'],
    })

    const retraction = s.sent.find((e) => e.channel === 'session:messages-retracted')
    expect(retraction?.args[0]).toEqual({ messageIds: ['msg_refused'] })
  })

  it('model_fallback (availability) does not emit a retraction event', () => {
    const s = new TestClaudeSession()
    s.handleSystemMessage({
      type: 'system',
      subtype: 'model_fallback',
      trigger: 'overloaded',
    })

    expect(s.sent.some((e) => e.channel === 'session:messages-retracted')).toBe(false)
  })
})
