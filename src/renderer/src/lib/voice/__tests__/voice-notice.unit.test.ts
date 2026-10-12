/**
 * Layer 1 tests for the voice notice store — one message per session, a newer
 * one replacing the older, and removals that only ever take their own notice.
 * The rekey map is stubbed: the replica's own suite pins how rekeys are recorded.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest'

const rekeys = vi.hoisted(() => new Map<string, string>())
vi.mock('../../../stores/replica', () => ({
  resolveRekeyed: (id: string) => rekeys.get(id) ?? id
}))

import {
  dismissStaleVoiceOffer,
  dismissVoiceNotice,
  followVoiceNotice,
  latchVoiceNoticeOutcome,
  resetVoiceNoticesForTests,
  showVoiceNotice,
  useVoiceNoticeStore,
  voiceNoticeFor
} from '../voice-notice'

const noticeOf = (routingId: string): ReturnType<typeof voiceNoticeFor> =>
  voiceNoticeFor(useVoiceNoticeStore.getState().notices, routingId)

beforeEach(() => {
  rekeys.clear()
  resetVoiceNoticesForTests()
})

describe('voice notices', () => {
  it('shows one notice per session; a newer one REPLACES the older', () => {
    showVoiceNotice('a', 'first', 'warn')
    showVoiceNotice('a', 'No speech detected', 'info')
    expect(noticeOf('a')).toMatchObject({ text: 'No speech detected', tone: 'info' })
    expect(Object.keys(useVoiceNoticeStore.getState().notices)).toEqual(['a'])
  })

  it('keeps sessions apart', () => {
    showVoiceNotice('a', 'for a')
    showVoiceNotice('b', 'for b', 'info')
    expect(noticeOf('a')).toMatchObject({ text: 'for a', tone: 'warn' })
    expect(noticeOf('b')).toMatchObject({ text: 'for b', tone: 'info' })
    dismissVoiceNotice('a')
    expect(noticeOf('a')).toBeNull()
    expect(noticeOf('b')).not.toBeNull()
  })

  it('defaults the tone to warn', () => {
    showVoiceNotice('a', 'something to fix')
    expect(noticeOf('a')?.tone).toBe('warn')
  })

  it('a dismissal by id only removes THAT notice — never a newer one that replaced it', () => {
    const old = showVoiceNotice('a', 'old')
    const fresh = showVoiceNotice('a', 'fresh')
    expect(fresh).not.toBe(old)
    dismissVoiceNotice('a', old)
    expect(noticeOf('a')).toMatchObject({ text: 'fresh' })
    dismissVoiceNotice('a', fresh)
    expect(noticeOf('a')).toBeNull()
  })

  it('a dismissal with nothing to remove leaves the state object alone', () => {
    const before = useVoiceNoticeStore.getState().notices
    dismissVoiceNotice('nobody', 3)
    expect(useVoiceNoticeStore.getState().notices).toBe(before)
  })

  it('follows a rekey — a notice raised under the old id is the new id’s', () => {
    // A first press spawns cli.js, which rekeys the brand-new session mid-capture.
    showVoiceNotice('pending-1', 'No signal from the microphone — lid closed or muted?')
    rekeys.set('pending-1', 'sdk-1')
    expect(noticeOf('sdk-1')).toMatchObject({ text: expect.stringMatching(/^No signal/) })

    // And a newer notice under the new id replaces it rather than sitting beside it.
    showVoiceNotice('sdk-1', 'No speech detected', 'info')
    expect(Object.keys(useVoiceNoticeStore.getState().notices)).toEqual(['sdk-1'])
    expect(noticeOf('pending-1')).toMatchObject({ text: 'No speech detected' })
  })

  it('carries an action as data, and a plain notice has none', () => {
    showVoiceNotice('a', 'needs the model', 'warn', 'install-voice-pack')
    expect(noticeOf('a')).toMatchObject({ action: 'install-voice-pack' })
    showVoiceNotice('a', 'No speech detected', 'info')
    expect(noticeOf('a')).not.toHaveProperty('action')
    expect(noticeOf('a')).not.toHaveProperty('following')
  })

  it('following marks only the notice that was acted on, never a newer one', () => {
    const offer = showVoiceNotice('a', 'needs the model', 'warn', 'install-voice-pack')
    expect(noticeOf('a')?.following).toBeUndefined()
    followVoiceNotice('a', offer)
    expect(noticeOf('a')).toMatchObject({ id: offer, following: true })

    // A press on a button that has since been replaced by a plain notice and a
    // fresh offer is not this offer's press.
    showVoiceNotice('a', 'No speech detected', 'info')
    const newer = showVoiceNotice('a', 'needs the model', 'warn', 'install-voice-pack')
    followVoiceNotice('a', offer)
    expect(noticeOf('a')).toMatchObject({ id: newer })
    expect(noticeOf('a')?.following).toBeUndefined()
  })

  it('following survives a rekey, and is a no-op for a notice that is gone', () => {
    const offer = showVoiceNotice('pending-1', 'needs the model', 'warn', 'install-voice-pack')
    rekeys.set('pending-1', 'sdk-1')
    followVoiceNotice('sdk-1', offer)
    expect(noticeOf('pending-1')).toMatchObject({ following: true })

    const before = useVoiceNoticeStore.getState().notices
    followVoiceNotice('nobody', 9)
    expect(useVoiceNoticeStore.getState().notices).toBe(before)
  })

  it('a fresh press drops an offer nobody took up, but not a download in progress or an outcome', () => {
    showVoiceNotice('a', 'needs the model', 'warn', 'install-voice-pack')
    dismissStaleVoiceOffer('a')
    expect(noticeOf('a')).toBeNull()

    const pressed = showVoiceNotice('a', 'needs the model', 'warn', 'install-voice-pack')
    followVoiceNotice('a', pressed)
    dismissStaleVoiceOffer('a')
    expect(noticeOf('a')).toMatchObject({ id: pressed })

    showVoiceNotice('a', 'No speech detected', 'info')
    dismissStaleVoiceOffer('a')
    expect(noticeOf('a')).toMatchObject({ text: 'No speech detected' })

    expect(() => dismissStaleVoiceOffer('nobody')).not.toThrow()
  })

  describe('a repeated offer (M1)', () => {
    const OFFER = 'needs the model'

    it('keeps following: the replacement of an action notice by the same action is the same download', () => {
      const first = showVoiceNotice('a', OFFER, 'warn', 'install-voice-pack')
      followVoiceNotice('a', first)
      const again = showVoiceNotice('a', OFFER, 'warn', 'install-voice-pack')
      expect(again).not.toBe(first)
      expect(noticeOf('a')).toMatchObject({ id: again, following: true })
    })

    it('an un-pressed offer stays un-pressed', () => {
      showVoiceNotice('a', OFFER, 'warn', 'install-voice-pack')
      showVoiceNotice('a', OFFER, 'warn', 'install-voice-pack')
      expect(noticeOf('a')?.following).toBeUndefined()
    })

    it('does not carry over from a different notice, or into a plain one', () => {
      const first = showVoiceNotice('a', OFFER, 'warn', 'install-voice-pack')
      followVoiceNotice('a', first)
      showVoiceNotice('a', 'No speech detected', 'info')
      expect(noticeOf('a')?.following).toBeUndefined()

      showVoiceNotice('a', OFFER, 'warn', 'install-voice-pack')
      expect(noticeOf('a')?.following).toBeUndefined()
    })

    it('does not carry over an ENDED download: after "cancelled" the repeat is a new offer', () => {
      const first = showVoiceNotice('a', OFFER, 'warn', 'install-voice-pack')
      followVoiceNotice('a', first)
      latchVoiceNoticeOutcome('a', first, {
        text: 'Speech model download cancelled',
        tone: 'info',
        phase: 'cancelled'
      })
      showVoiceNotice('a', OFFER, 'warn', 'install-voice-pack')
      expect(noticeOf('a')).not.toHaveProperty('following')
      expect(noticeOf('a')).not.toHaveProperty('outcome')
    })

    it('follows a rekey', () => {
      const first = showVoiceNotice('pending-1', OFFER, 'warn', 'install-voice-pack')
      followVoiceNotice('pending-1', first)
      rekeys.set('pending-1', 'sdk-1')
      showVoiceNotice('sdk-1', OFFER, 'warn', 'install-voice-pack')
      expect(noticeOf('sdk-1')).toMatchObject({ following: true })
    })
  })

  it('latches an outcome once, only for the notice shown', () => {
    const id = showVoiceNotice('a', 'x', 'warn', 'install-voice-pack')
    const ready = { text: 'ready', tone: 'info' as const, phase: 'ready' }
    latchVoiceNoticeOutcome('a', id + 1, ready)
    expect(noticeOf('a')?.outcome).toBeUndefined()
    latchVoiceNoticeOutcome('a', id, ready)
    latchVoiceNoticeOutcome('a', id, { text: 'cancelled', tone: 'info', phase: 'cancelled' })
    expect(noticeOf('a')?.outcome).toEqual(ready)
  })
})
