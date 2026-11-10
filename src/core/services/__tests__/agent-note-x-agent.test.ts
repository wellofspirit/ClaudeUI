/**
 * @vitest-environment node
 *
 * The note row of an X-Agent's result delivered into its parent (ADR-105 §3): "Report from
 * X-Agent <name>", on every engine, live and read back. Never the generic "Message from".
 */
import { describe, it, expect } from 'vitest'
import {
  X_AGENT_RESULT_FRAGMENT_LABEL,
  SESSION_MESSAGE_FRAGMENT_LABEL,
  peerRowParts,
  sessionMessageNote,
  wrappedUserRowAsNote
} from '../agent-note'
import { piCustomMessageToChat } from '../../pi/pi-custom-message'
import {
  buildCrossSessionEnvelope,
  buildSessionMessageWrapper,
  wrapperSender
} from '../../../shared/session-message-wrapper'
import type { ChatMessage } from '../../../shared/types'

const FROM = wrapperSender({
  origin: 'dispatch-result',
  from: { key: 's-abc234', title: 'impl-e1' }
})

function noteOf(message: ChatMessage | null): { title: string; label: string | undefined } {
  const block = message?.content[0]
  if (!block || block.type !== 'context_note') throw new Error('not a note')
  return { title: block.title, label: block.fragments[0].label }
}

describe('sessionMessageNote', () => {
  it('titles an X-Agent result "Report from X-Agent <name>" and labels it as the parent’s own X-Agent', () => {
    const note = sessionMessageNote({
      id: 'n1',
      fromTitle: 'impl-e1',
      fromKey: FROM.key,
      text: 'body',
      timestamp: 1
    })
    expect(noteOf(note)).toEqual({
      title: 'Report from X-Agent impl-e1',
      label: X_AGENT_RESULT_FRAGMENT_LABEL
    })
  })

  it('takes the "X-Agent " lead of the Claude envelope name off the title', () => {
    expect(
      noteOf(
        sessionMessageNote({
          id: 'n2',
          fromTitle: 'X-Agent impl-e1',
          fromKey: FROM.key,
          text: 'b',
          timestamp: 1
        })
      ).title
    ).toBe('Report from X-Agent impl-e1')
  })

  it('a session message keeps its generic title and label', () => {
    expect(
      noteOf(
        sessionMessageNote({
          id: 'n3',
          fromTitle: 'Triage',
          fromKey: 's-zzzzzz',
          text: 'b',
          timestamp: 1
        })
      )
    ).toEqual({ title: 'Message from Triage', label: SESSION_MESSAGE_FRAGMENT_LABEL })
  })

  it('a native peer cannot pass for an X-Agent by naming itself that way', () => {
    expect(
      noteOf(
        sessionMessageNote({
          id: 'n4',
          fromTitle: 'evil',
          fromKey: 'x-agent:s-abc234',
          native: true,
          text: 'b',
          timestamp: 1
        })
      ).title
    ).toBe('evil · another Claude session')
  })
})

describe('read back: every engine shows the same row', () => {
  it('Claude: the peer row cli.js stored (hostInjected) is a result note', () => {
    const content = buildCrossSessionEnvelope(FROM, 'the report')
    const parts = peerRowParts(
      { origin: { kind: 'peer', from: FROM.key, name: 'X-Agent impl-e1', hostInjected: true } },
      content
    )
    expect(parts).toMatchObject({ fromKey: 'x-agent:s-abc234', native: false })
    expect(
      noteOf(
        sessionMessageNote({
          id: 'c',
          fromTitle: parts!.fromTitle,
          fromKey: parts!.fromKey,
          native: parts!.native,
          text: parts!.body,
          timestamp: 1
        })
      ).title
    ).toBe('Report from X-Agent impl-e1')
  })

  it('opencode: the user row of the wrapper becomes the result note', () => {
    const message: ChatMessage = {
      id: 'u1',
      role: 'user',
      content: [{ type: 'text', text: buildSessionMessageWrapper(FROM, 'the report') }],
      timestamp: 1
    }
    expect(noteOf(wrappedUserRowAsNote(message))).toEqual({
      title: 'Report from X-Agent impl-e1',
      label: X_AGENT_RESULT_FRAGMENT_LABEL
    })
  })

  it('pi: the custom message of kind session-message becomes the result note', () => {
    const text = buildSessionMessageWrapper(FROM, 'the report')
    const message = piCustomMessageToChat({
      id: 'p1',
      customType: 'claudeui-agent-message',
      content: text,
      display: true,
      timestamp: 1,
      details: {
        v: 1,
        kind: 'session-message',
        deliveryId: 'd1',
        title: 'x',
        agentId: FROM.key,
        toolUseId: '',
        from: 'impl-e1',
        fromId: FROM.key
      }
    })
    expect(noteOf(message).title).toBe('Report from X-Agent impl-e1')
  })
})

// ADR-105 §4: a message an X-Agent sent its parent while it ran is not its report. It travels under
// a key of its own, so the row, the trailer and the envelope name tell the two apart on every engine.
describe('a message from an X-Agent (not its report)', () => {
  const MESSAGE_FROM = { key: 'x-agent-message:s-abc234', title: 'impl-e1' }

  it('is titled "Message from X-Agent <name>" with the X-Agent label, never "Report from"', () => {
    expect(
      noteOf(
        sessionMessageNote({
          id: 'm1',
          fromTitle: 'impl-e1',
          fromKey: MESSAGE_FROM.key,
          text: 'a question',
          timestamp: 1
        })
      )
    ).toEqual({ title: 'Message from X-Agent impl-e1', label: X_AGENT_RESULT_FRAGMENT_LABEL })
    expect(
      noteOf(
        sessionMessageNote({
          id: 'm2',
          fromTitle: 'X-Agent impl-e1',
          fromKey: MESSAGE_FROM.key,
          text: 'a question',
          timestamp: 1
        })
      ).title
    ).toBe('Message from X-Agent impl-e1')
  })

  it('a native peer cannot pass for one by naming itself that way', () => {
    expect(
      noteOf(
        sessionMessageNote({
          id: 'm3',
          fromTitle: 'evil',
          fromKey: MESSAGE_FROM.key,
          native: true,
          text: 'b',
          timestamp: 1
        })
      ).title
    ).toBe('evil · another Claude session')
  })

  it('the wrapper says it is a message from the X-Agent, not a result and not a session', () => {
    const wrapped = buildSessionMessageWrapper(MESSAGE_FROM, 'a question')
    expect(wrapped).toContain('from="x-agent-message:s-abc234"')
    expect(
      wrapped.endsWith(
        'This is a message from an X-Agent you launched with dispatch_agent, not from the user.'
      )
    ).toBe(true)
    expect(wrapped).not.toContain('This is the result of an X-Agent')
  })

  it('Claude’s envelope names the sender "X-Agent <name>" and keeps the key through the round trip', () => {
    const envelope = buildCrossSessionEnvelope(MESSAGE_FROM, 'a question')
    expect(envelope).toContain('from="x-agent-message:s-abc234"')
    expect(envelope).toContain('from-name="X-Agent impl-e1"')
    const parts = peerRowParts(
      {
        origin: {
          kind: 'peer',
          from: MESSAGE_FROM.key,
          name: 'X-Agent impl-e1',
          hostInjected: true
        }
      },
      envelope
    )
    expect(
      noteOf(
        sessionMessageNote({
          id: 'c',
          fromTitle: parts!.fromTitle,
          fromKey: parts!.fromKey,
          native: parts!.native,
          text: parts!.body,
          timestamp: 1
        })
      ).title
    ).toBe('Message from X-Agent impl-e1')
  })

  it('opencode: the wrapper’s user row reads back as the message note', () => {
    const message: ChatMessage = {
      id: 'u1',
      role: 'user',
      content: [{ type: 'text', text: buildSessionMessageWrapper(MESSAGE_FROM, 'a question') }],
      timestamp: 1
    }
    expect(noteOf(wrappedUserRowAsNote(message)).title).toBe('Message from X-Agent impl-e1')
  })

  it('pi: the custom message becomes the message note', () => {
    const message = piCustomMessageToChat({
      id: 'p1',
      customType: 'claudeui-agent-message',
      content: buildSessionMessageWrapper(MESSAGE_FROM, 'a question'),
      display: true,
      timestamp: 1,
      details: {
        v: 1,
        kind: 'session-message',
        deliveryId: 'd1',
        title: 'x',
        agentId: MESSAGE_FROM.key,
        toolUseId: '',
        from: 'impl-e1',
        fromId: MESSAGE_FROM.key
      }
    })
    expect(noteOf(message).title).toBe('Message from X-Agent impl-e1')
  })
})
