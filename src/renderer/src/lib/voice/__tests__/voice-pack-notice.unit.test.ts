/**
 * Layer 1: what the notice pill shows for the speech-model offer (ADR-101 §6) —
 * a pure function of the notice and the pack's live status. Nothing here reads
 * the notice's wording: the action is data (ADR-070), and a plain notice whose
 * text merely says the same thing gets no button.
 */

import { describe, it, expect } from 'vitest'
import {
  outcomeOf,
  packProgressPercent,
  SPEECH_MODEL_CANCELLED_TEXT,
  SPEECH_MODEL_READY_TEXT,
  VOICE_NOTICE_ACTION_LINGER_MS,
  voiceNoticeView,
  type PackForNotice
} from '../voice-pack-notice'
import type { VoiceNotice } from '../voice-notice'
import type { VoicePackState, VoicePackStatus } from '../../../../../shared/voice-pack'

const OFFER_TEXT = 'Voice input for this engine needs the on-device speech model (~700 MB)'

const offer = (over: Partial<VoiceNotice> = {}): VoiceNotice => ({
  id: 7,
  text: OFFER_TEXT,
  tone: 'warn',
  action: 'install-voice-pack',
  ...over
})

const pressed = (over: Partial<VoiceNotice> = {}): VoiceNotice =>
  offer({ following: true, ...over })

const status = (state: VoicePackState, over: Partial<VoicePackStatus> = {}): VoicePackStatus => ({
  state,
  packId: 'parakeet-tdt-0.6b-v2-int8',
  label: 'Parakeet TDT 0.6B v2 (English)',
  approxBytes: 700_000_000,
  ...over
})

const downloading = (receivedBytes: number, totalBytes: number): PackForNotice => ({
  status: status('installing', { progress: { receivedBytes, totalBytes } }),
  installPending: false
})

const idle: PackForNotice = { status: status('missing'), installPending: false }

describe('voiceNoticeView — a notice without an action', () => {
  it('is itself, whatever the pack says', () => {
    const plain: VoiceNotice = { id: 1, text: OFFER_TEXT, tone: 'warn' }
    expect(voiceNoticeView(plain, { status: status('installing'), installPending: true })).toEqual({
      id: 1,
      text: OFFER_TEXT,
      tone: 'warn'
    })
  })
})

describe('voiceNoticeView — the offer', () => {
  it('offers the download: the notice text, a Download button, and no fade on release', () => {
    for (const pack of [idle, { status: null, installPending: false }]) {
      expect(voiceNoticeView(offer(), pack)).toEqual({
        id: 7,
        text: OFFER_TEXT,
        tone: 'warn',
        button: 'download',
        phase: 'offer',
        lingerMs: VOICE_NOTICE_ACTION_LINGER_MS,
        dismissible: true
      })
    }
    expect(VOICE_NOTICE_ACTION_LINGER_MS).toBe(30_000)
  })

  it('still offers it when the status holds an old failure or a stale ready: only a pressed pill shows outcomes', () => {
    for (const state of ['failed', 'ready', 'missing'] as const) {
      const view = voiceNoticeView(offer(), {
        status: status(state, { error: 'old failure' }),
        installPending: false
      })
      expect(view).toMatchObject({ button: 'download', phase: 'offer', text: OFFER_TEXT })
    }
  })

  it('shows an install that someone else started, with its progress and a Cancel', () => {
    expect(voiceNoticeView(offer(), downloading(294_000_000, 700_000_000))).toEqual({
      id: 7,
      text: 'Downloading speech model… 42%',
      tone: 'info',
      button: 'cancel',
      phase: 'installing',
      lingerMs: null,
      dismissible: true,
      // A percentage that changes four times a second is not read out.
      liveText: 'Downloading speech model…'
    })
  })
})

describe('voiceNoticeView — after Download was pressed', () => {
  it('shows the download at once, before the host has said anything (no percentage yet)', () => {
    expect(
      voiceNoticeView(pressed(), { status: status('missing'), installPending: true })
    ).toMatchObject({ text: 'Downloading speech model…', button: 'cancel', lingerMs: null })
    // A stale failure from last time must not show while the new install is starting.
    expect(
      voiceNoticeView(pressed(), {
        status: status('failed', { error: 'old' }),
        installPending: true
      })
    ).toMatchObject({ text: 'Downloading speech model…', phase: 'installing' })
  })

  it('a download of unknown size shows no percentage; a finished one never passes 100', () => {
    expect(voiceNoticeView(pressed(), downloading(5, 0)).text).toBe('Downloading speech model…')
    expect(voiceNoticeView(pressed(), downloading(701, 700)).text).toBe(
      'Downloading speech model… 100%'
    )
    expect(voiceNoticeView(pressed(), downloading(1, 700)).text).toBe(
      'Downloading speech model… 0%'
    )
  })

  it('ready is an info outcome that fades like any other, even while the install call is still returning', () => {
    for (const installPending of [false, true]) {
      expect(voiceNoticeView(pressed(), { status: status('ready'), installPending })).toEqual({
        id: 7,
        text: SPEECH_MODEL_READY_TEXT,
        tone: 'info',
        phase: 'ready'
      })
    }
    expect(SPEECH_MODEL_READY_TEXT).toBe('Speech model ready — hold the mic to talk')
  })

  it('failed shows the host’s own error in warn', () => {
    expect(
      voiceNoticeView(pressed(), {
        status: status('failed', { error: 'Hugging Face answered 503' }),
        installPending: false
      })
    ).toEqual({ id: 7, text: 'Hugging Face answered 503', tone: 'warn', phase: 'failed' })
    // A failure with no text still says something.
    expect(
      voiceNoticeView(pressed(), { status: status('failed'), installPending: false }).text
    ).toBe('Downloading the speech model failed')
  })

  it('a cancelled download (status back to missing, nothing pending) says so, in info', () => {
    expect(voiceNoticeView(pressed(), idle)).toEqual({
      id: 7,
      text: SPEECH_MODEL_CANCELLED_TEXT,
      tone: 'info',
      phase: 'cancelled'
    })
  })

  it('a host without a runtime says so', () => {
    expect(
      voiceNoticeView(pressed(), { status: status('unsupported'), installPending: false })
    ).toMatchObject({ tone: 'warn', phase: 'unsupported' })
  })

  it('with no status read yet it keeps the offer rather than guess an outcome', () => {
    expect(voiceNoticeView(pressed(), { status: null, installPending: false })).toMatchObject({
      button: 'download',
      phase: 'offer'
    })
  })
})

describe('voiceNoticeView — a command that did not run', () => {
  it('never presents the status as the outcome of a refused press: the offer stays until the reason replaces it', () => {
    // The status is stale (nothing ran): without the flag this reads "cancelled", or
    // an old failure.
    for (const state of ['missing', 'failed', 'ready'] as const) {
      const view = voiceNoticeView(pressed(), {
        status: status(state, { error: 'old' }),
        installPending: false,
        commandFailed: true
      })
      expect(view).toMatchObject({ phase: 'offer', button: 'download', text: OFFER_TEXT })
      expect(outcomeOf(view)).toBeNull()
    }
  })

  it('an install someone else is running still shows as running', () => {
    expect(voiceNoticeView(pressed(), { ...downloading(1, 2), commandFailed: true })).toMatchObject(
      { phase: 'installing' }
    )
  })
})

describe('voiceNoticeView — a latched outcome (N7)', () => {
  it('is over once over: later status changes do not rewrite what the speaker was shown', () => {
    const ready = voiceNoticeView(pressed(), { status: status('ready'), installPending: false })
    const outcome = outcomeOf(ready)!
    expect(outcome).toEqual({ text: SPEECH_MODEL_READY_TEXT, tone: 'info', phase: 'ready' })

    // The pack is removed in Settings during the linger: the status is `missing` now.
    const latched = pressed({ outcome })
    expect(voiceNoticeView(latched, idle)).toEqual({ id: 7, ...outcome })
    expect(voiceNoticeView(latched, downloading(1, 2))).toEqual({ id: 7, ...outcome })
  })

  it('only an end is an outcome: the offer and a running download are not', () => {
    expect(outcomeOf(voiceNoticeView(offer(), idle))).toBeNull()
    expect(outcomeOf(voiceNoticeView(pressed(), downloading(1, 2)))).toBeNull()
    for (const state of ['failed', 'missing', 'unsupported'] as const) {
      expect(
        outcomeOf(voiceNoticeView(pressed(), { status: status(state), installPending: false }))
      ).not.toBeNull()
    }
  })
})

describe('packProgressPercent', () => {
  it('floors, caps at 100 and is null without a total', () => {
    const at = (receivedBytes: number, totalBytes: number): number | null =>
      packProgressPercent(downloading(receivedBytes, totalBytes).status)
    expect(at(419, 1000)).toBe(41)
    expect(at(2000, 1000)).toBe(100)
    expect(at(10, 0)).toBeNull()
    expect(packProgressPercent(status('missing'))).toBeNull()
    expect(packProgressPercent(null)).toBeNull()
  })
})
