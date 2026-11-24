/**
 * @vitest-environment node
 *
 * A media job's completion notice (origin `dispatch-result`, sender `media-job:<id>`): never prefixed as an
 * X-Agent, framed by its own trailer and envelope name on every engine's wrapper, and a note titled
 * "Image job finished" / "Video job failed" live and read back.
 */
import { describe, expect, it } from 'vitest'
import {
  MEDIA_JOB_FRAGMENT_LABEL,
  peerRowParts,
  sessionMessageNote,
  wrappedUserRowAsNote
} from '../agent-note'
import {
  MEDIA_JOB_TRAILER,
  X_AGENT_RESULT_TRAILER,
  buildCrossSessionEnvelope,
  buildSessionMessageWrapper,
  envelopeName,
  parseSessionMessageWrapper,
  wrapperSender
} from '../../../shared/session-message-wrapper'
import type { ChatMessage } from '../../../shared/types'

const MEDIA = { key: 'media-job:0123456789ab', title: 'Image job finished' }

function noteOf(message: ChatMessage | null): { title: string; label: string | undefined } {
  const block = message?.content[0]
  if (!block || block.type !== 'context_note') throw new Error('not a note')
  return { title: block.title, label: block.fragments[0].label }
}

describe('the media job sender', () => {
  it('keeps its own key on a dispatch-result, where an X-Agent’s gets the x-agent: prefix', () => {
    expect(wrapperSender({ origin: 'dispatch-result', from: MEDIA })).toEqual(MEDIA)
    expect(
      wrapperSender({ origin: 'dispatch-result', from: { key: 's-abc234', title: 'a' } }).key
    ).toBe('x-agent:s-abc234')
  })

  it('opencode’s wrapper carries the media trailer, not the X-Agent one or the generic one', () => {
    const text = buildSessionMessageWrapper(MEDIA, 'saved at /w/a.png')
    expect(text.endsWith(MEDIA_JOB_TRAILER)).toBe(true)
    expect(text).not.toContain(X_AGENT_RESULT_TRAILER)
    expect(parseSessionMessageWrapper(text)).toMatchObject({
      fromKey: MEDIA.key,
      fromTitle: MEDIA.title
    })
  })

  it('Claude’s envelope names the sender by the job title, never "X-Agent …", and keeps the key', () => {
    expect(envelopeName(MEDIA)).toBe('Image job finished')
    const envelope = buildCrossSessionEnvelope(MEDIA, 'saved at /w/a.png')
    expect(envelope).toContain('from="media-job:0123456789ab"')
    expect(envelope).toContain('from-name="Image job finished"')
    expect(envelope).not.toContain('X-Agent')
  })
})

describe('the note row', () => {
  it.each([
    ['Image job finished', 'Image job finished'],
    ['Video job failed', 'Video job failed']
  ])('titles %s as the job says, labelled as a media job', (fromTitle, expected) => {
    const note = noteOf(
      sessionMessageNote({
        id: 'n1',
        fromTitle,
        fromKey: 'media-job:0123456789ab',
        text: 'body',
        timestamp: 1
      })
    )
    expect(note).toEqual({ title: expected, label: MEDIA_JOB_FRAGMENT_LABEL })
  })

  it('reads back from either wrapper after a reload', () => {
    const opencode = wrappedUserRowAsNote({
      id: 'u1',
      role: 'user',
      timestamp: 1,
      content: [{ type: 'text', text: buildSessionMessageWrapper(MEDIA, 'saved') }]
    } as ChatMessage)
    expect(noteOf(opencode).title).toBe('Image job finished')
    const claude = peerRowParts({ turnOrigin: 'peer' }, buildCrossSessionEnvelope(MEDIA, 'saved'))
    expect(claude).toMatchObject({ fromKey: MEDIA.key })
  })
})
