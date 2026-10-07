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
  dismissVoiceNotice,
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
})
