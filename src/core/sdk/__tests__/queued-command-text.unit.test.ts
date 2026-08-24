/**
 * @vitest-environment node
 *
 * cli.js's canonical queued-command text (F8).
 *
 * Every case here mirrors a branch that exists in the bundle, so the helper can
 * be checked against the protocol rather than against itself:
 *
 *   ZPe(e) = typeof e==="string" ? e
 *          : Array.isArray(e) ? e.filter(t => t.type==="text" && typeof t.text==="string")
 *                                .map(t => t.text).join("\n")
 *          : ""
 *
 * and the identical shape behind `dequeue_message`'s matcher:
 *   VV_(e) = typeof e==="string" ? e : Lu(e,"\n")
 *   Lu(e,t) = e.filter(r => r.type==="text").map(r => r.text).join(t)
 */
import { describe, it, expect } from 'vitest'
import { queuedCommandText } from '../queued-command-text'

describe('queuedCommandText', () => {
  it('returns a plain string prompt unchanged (the text-only queue path)', () => {
    expect(queuedCommandText('fix the auth bug')).toBe('fix the auth bug')
  })

  it('extracts the text block from an attachment-carrying prompt', () => {
    // Exactly what `ClaudeSession.run` pushes for `enqueuePrompt(text, [image])`:
    // attachments first, text last.
    expect(
      queuedCommandText([
        { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA' } },
        { type: 'text', text: 'look at this' }
      ])
    ).toBe('look at this')
  })

  it('joins multiple text blocks with a newline, in order', () => {
    expect(
      queuedCommandText([
        { type: 'text', text: 'first' },
        { type: 'image', source: {} },
        { type: 'text', text: 'second' }
      ])
    ).toBe('first\nsecond')
  })

  it('is empty for an attachments-only prompt — and that is a real queue item', () => {
    // `enqueuePrompt('', [image])` stores `text: ''`, so '' has to be the answer
    // here or the two sides could never correlate.
    expect(queuedCommandText([{ type: 'document', source: {} }])).toBe('')
  })

  it('degrades to empty for anything else, rather than stringifying it', () => {
    // A JSON-ish stringification would silently produce a value that matches
    // nothing while LOOKING like text in a log.
    expect(queuedCommandText(undefined)).toBe('')
    expect(queuedCommandText(null)).toBe('')
    expect(queuedCommandText({ type: 'text', text: 'not an array' })).toBe('')
  })

  it('ignores malformed blocks instead of throwing', () => {
    expect(queuedCommandText([null, 'raw', { type: 'text' }, { type: 'text', text: 'kept' }])).toBe(
      'kept'
    )
  })
})
