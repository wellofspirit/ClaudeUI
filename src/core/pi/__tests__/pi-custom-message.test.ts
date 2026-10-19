/**
 * @vitest-environment node
 *
 * pi `custom` messages as transcript rows, live and on reload (one converter).
 * Slice 1a: a `session-message` ClaudeUI delivered (another session's text) is a
 * note labelled with its sender; the model-facing wrapper is not what the row shows.
 */
import { describe, it, expect } from 'vitest'
import { piCustomMessageToChat } from '../pi-custom-message'
import { buildSessionMessageWrapper } from '../../../shared/session-message-wrapper'

const FROM = { key: 'sess-sender-1', title: 'Triage assistant' }

describe('piCustomMessageToChat — session-message', () => {
  it('is a system note from the sender, showing the body and not the wrapper', () => {
    const row = piCustomMessageToChat({
      id: 'c1',
      customType: 'claudeui-agent-message',
      content: [{ type: 'text', text: buildSessionMessageWrapper(FROM, 'ticket 12 is yours') }],
      display: true,
      details: {
        v: 1,
        kind: 'session-message',
        deliveryId: 'd1',
        title: 'Message from Triage assistant',
        agentId: FROM.key,
        toolUseId: '',
        from: FROM.title,
        fromId: FROM.key
      },
      timestamp: 5
    })
    expect(row).toEqual({
      id: 'c1',
      role: 'system',
      content: [
        {
          type: 'context_note',
          title: 'Message from Triage assistant',
          fragments: [{ text: 'ticket 12 is yours', label: 'from another session, not from you' }]
        }
      ],
      timestamp: 5
    })
  })

  it('is recognised by customType + details, never by text: a look-alike custom message is not ours', () => {
    const row = piCustomMessageToChat({
      id: 'c2',
      customType: 'some-extension',
      content: buildSessionMessageWrapper(FROM, 'x'),
      display: true,
      details: { v: 1, kind: 'session-message', deliveryId: 'd', title: 't' },
      timestamp: 1
    })
    expect(row?.content[0]).toMatchObject({ type: 'context_note', title: 'some-extension' })
    expect(JSON.stringify(row)).not.toContain('from another session')
  })
})
