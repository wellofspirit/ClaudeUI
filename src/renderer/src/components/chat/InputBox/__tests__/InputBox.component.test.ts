/**
 * Layer 2: Component tests for InputBox store integration patterns.
 *
 * resolveSendAction unit tests live in utils.test.ts. This file covers
 * the store-side behaviors that InputBox depends on:
 *
 *   - createNewSession + markSdkActive lifecycle
 *   - setQueuedText accumulation and consumeQueuedText flush
 *   - setDraftText / clearance semantics
 *   - appendVoiceTranscript (final vs interim)
 *   - setBtwQuestion / setBtwResponse BTW side-question flow
 *
 * No React rendering — we drive the Zustand store directly, matching the
 * same patterns InputBox would execute at runtime.
 */

import { describe, it, expect, beforeEach } from 'vitest'
import { useSessionStore } from '../../../../stores/session-store'
import { resetFactoryCounter } from '@test/factories/messages'

const ROUTE = 'r-input-1'

function setupSession(routingId = ROUTE, cwd = '/test'): void {
  useSessionStore.getState().createNewSession(routingId, cwd)
  useSessionStore.setState({ activeSessionId: routingId })
}

beforeEach(() => {
  resetFactoryCounter()
  ;(globalThis as any).window = globalThis.window || {}
  ;(globalThis as any).window.api = {
    saveSessionConfig: () => {},
    saveSettings: () => {},
    logError: () => {},
  } as any

  useSessionStore.setState({
    activeSessionId: null,
    sessions: {},
    recentSessionIds: [],
  })
})

// ---------------------------------------------------------------------------
// Session lifecycle — what InputBox does for 'send-prompt' when sdkActive=false
// ---------------------------------------------------------------------------

describe('session lifecycle — createNewSession + markSdkActive', () => {
  it('createNewSession initialises sdkActive as false', () => {
    setupSession()
    const session = useSessionStore.getState().sessions[ROUTE]
    expect(session).toBeDefined()
    expect(session.sdkActive).toBe(false)
  })

  it('markSdkActive sets sdkActive to true', () => {
    setupSession()
    useSessionStore.getState().markSdkActive(ROUTE)
    expect(useSessionStore.getState().sessions[ROUTE].sdkActive).toBe(true)
  })

  it('markSdkInactive sets sdkActive back to false', () => {
    setupSession()
    useSessionStore.getState().markSdkActive(ROUTE)
    useSessionStore.getState().markSdkInactive(ROUTE)
    expect(useSessionStore.getState().sessions[ROUTE].sdkActive).toBe(false)
  })

  it('showWelcome clears the activeSessionId', () => {
    setupSession()
    useSessionStore.getState().showWelcome()
    expect(useSessionStore.getState().activeSessionId).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// Queue text — what InputBox does for 'queue-prompt'
// ---------------------------------------------------------------------------

describe('setQueuedText — queue-prompt accumulation', () => {
  it('sets queued text for an idle session', () => {
    setupSession()
    useSessionStore.getState().setQueuedText(ROUTE, 'first message')
    expect(useSessionStore.getState().sessions[ROUTE].queuedText).toBe('first message')
  })

  it('appends with newline separator when called a second time', () => {
    setupSession()
    useSessionStore.getState().setQueuedText(ROUTE, 'first')
    useSessionStore.getState().setQueuedText(ROUTE, 'second')
    expect(useSessionStore.getState().sessions[ROUTE].queuedText).toBe('first\nsecond')
  })

  it('appends further messages correctly', () => {
    setupSession()
    useSessionStore.getState().setQueuedText(ROUTE, 'a')
    useSessionStore.getState().setQueuedText(ROUTE, 'b')
    useSessionStore.getState().setQueuedText(ROUTE, 'c')
    expect(useSessionStore.getState().sessions[ROUTE].queuedText).toBe('a\nb\nc')
  })

  it('does nothing when the routingId session does not exist', () => {
    // No session created — should not throw
    useSessionStore.getState().setQueuedText('nonexistent', 'oops')
    expect(useSessionStore.getState().sessions['nonexistent']).toBeUndefined()
  })
})

describe('consumeQueuedText — flush to messages on turn end', () => {
  it('adds a user message with queued text and clears queuedText', () => {
    setupSession()
    useSessionStore.getState().setQueuedText(ROUTE, 'queued prompt')
    useSessionStore.getState().consumeQueuedText(ROUTE)

    const session = useSessionStore.getState().sessions[ROUTE]
    expect(session.queuedText).toBe('')
    const lastMsg = session.messages[session.messages.length - 1]
    expect(lastMsg.role).toBe('user')
    expect(lastMsg.content[0]).toMatchObject({ type: 'text', text: 'queued prompt' })
  })

  it('does nothing when queuedText is empty', () => {
    setupSession()
    const before = useSessionStore.getState().sessions[ROUTE].messages.length
    useSessionStore.getState().consumeQueuedText(ROUTE)
    const after = useSessionStore.getState().sessions[ROUTE].messages.length
    expect(after).toBe(before)
  })

  it('clears queuedText even when multiple entries were accumulated', () => {
    setupSession()
    useSessionStore.getState().setQueuedText(ROUTE, 'first')
    useSessionStore.getState().setQueuedText(ROUTE, 'second')
    useSessionStore.getState().consumeQueuedText(ROUTE)

    const session = useSessionStore.getState().sessions[ROUTE]
    expect(session.queuedText).toBe('')
    const lastMsg = session.messages[session.messages.length - 1]
    expect(lastMsg.content[0]).toMatchObject({ type: 'text', text: 'first\nsecond' })
  })
})

// ---------------------------------------------------------------------------
// Draft text — InputBox reads/writes draftText for textarea content
// ---------------------------------------------------------------------------

describe('setDraftText — draft text management', () => {
  it('stores draft text on the active session', () => {
    setupSession()
    useSessionStore.getState().setDraftText('work in progress')
    expect(useSessionStore.getState().sessions[ROUTE].draftText).toBe('work in progress')
  })

  it('overwrites previous draft text', () => {
    setupSession()
    useSessionStore.getState().setDraftText('old draft')
    useSessionStore.getState().setDraftText('new draft')
    expect(useSessionStore.getState().sessions[ROUTE].draftText).toBe('new draft')
  })

  it('does nothing when there is no active session', () => {
    // No session active — should not throw
    useSessionStore.getState().setDraftText('orphan text')
    // No session was created so nothing to assert on
    expect(useSessionStore.getState().activeSessionId).toBeNull()
  })

  it('clears draft by setting empty string', () => {
    setupSession()
    useSessionStore.getState().setDraftText('something')
    useSessionStore.getState().setDraftText('')
    expect(useSessionStore.getState().sessions[ROUTE].draftText).toBe('')
  })
})

// ---------------------------------------------------------------------------
// Voice transcript — appendVoiceTranscript (isFinal=true/false)
// ---------------------------------------------------------------------------

describe('appendVoiceTranscript — voice input integration', () => {
  it('isFinal=true appends to draftText and clears voiceInterimTranscript', () => {
    setupSession()
    useSessionStore.getState().setDraftText('hello ')
    useSessionStore.getState().appendVoiceTranscript(ROUTE, 'world', true)

    const session = useSessionStore.getState().sessions[ROUTE]
    expect(session.draftText).toBe('hello world')
    expect(session.voiceInterimTranscript).toBe('')
  })

  it('isFinal=true inserts a space separator when draft does not end with space', () => {
    setupSession()
    useSessionStore.getState().setDraftText('hello')
    useSessionStore.getState().appendVoiceTranscript(ROUTE, 'world', true)

    expect(useSessionStore.getState().sessions[ROUTE].draftText).toBe('hello world')
  })

  it('isFinal=true does not double-space when draft already ends with space', () => {
    setupSession()
    useSessionStore.getState().setDraftText('hello ')
    useSessionStore.getState().appendVoiceTranscript(ROUTE, 'world', true)

    expect(useSessionStore.getState().sessions[ROUTE].draftText).toBe('hello world')
  })

  it('isFinal=true with empty draft just sets the transcript text', () => {
    setupSession()
    useSessionStore.getState().appendVoiceTranscript(ROUTE, 'first words', true)

    expect(useSessionStore.getState().sessions[ROUTE].draftText).toBe('first words')
  })

  it('isFinal=false updates voiceInterimTranscript only, draft unchanged', () => {
    setupSession()
    useSessionStore.getState().setDraftText('existing draft')
    useSessionStore.getState().appendVoiceTranscript(ROUTE, 'partial words...', false)

    const session = useSessionStore.getState().sessions[ROUTE]
    expect(session.draftText).toBe('existing draft')
    expect(session.voiceInterimTranscript).toBe('partial words...')
  })

  it('subsequent interim updates replace previous interim text', () => {
    setupSession()
    useSessionStore.getState().appendVoiceTranscript(ROUTE, 'first partial', false)
    useSessionStore.getState().appendVoiceTranscript(ROUTE, 'second partial', false)

    expect(useSessionStore.getState().sessions[ROUTE].voiceInterimTranscript).toBe('second partial')
  })
})

// ---------------------------------------------------------------------------
// BTW side question — setBtwQuestion / setBtwResponse
// ---------------------------------------------------------------------------

describe('setBtwQuestion + setBtwResponse — BTW side-question flow', () => {
  it('setBtwQuestion stores the question and sets btwLoading=true', () => {
    setupSession()
    useSessionStore.getState().setBtwQuestion(ROUTE, 'What does this function do?')

    const session = useSessionStore.getState().sessions[ROUTE]
    expect(session.btwQuestion).toBe('What does this function do?')
    expect(session.btwLoading).toBe(true)
    expect(session.btwResponse).toBeNull()
  })

  it('setBtwQuestion clears any prior response', () => {
    setupSession()
    useSessionStore.getState().setBtwQuestion(ROUTE, 'first question')
    useSessionStore.getState().setBtwResponse(ROUTE, 'first answer')
    useSessionStore.getState().setBtwQuestion(ROUTE, 'second question')

    const session = useSessionStore.getState().sessions[ROUTE]
    expect(session.btwResponse).toBeNull()
    expect(session.btwLoading).toBe(true)
  })

  it('setBtwResponse stores the response and clears btwLoading', () => {
    setupSession()
    useSessionStore.getState().setBtwQuestion(ROUTE, 'What is 2+2?')
    useSessionStore.getState().setBtwResponse(ROUTE, '4')

    const session = useSessionStore.getState().sessions[ROUTE]
    expect(session.btwResponse).toBe('4')
    expect(session.btwLoading).toBe(false)
  })

  it('setBtwResponse(null) clears response and sets btwLoading=false', () => {
    setupSession()
    useSessionStore.getState().setBtwQuestion(ROUTE, 'something')
    useSessionStore.getState().setBtwResponse(ROUTE, null)

    const session = useSessionStore.getState().sessions[ROUTE]
    expect(session.btwResponse).toBeNull()
    expect(session.btwLoading).toBe(false)
  })

  it('initial BTW state is clean', () => {
    setupSession()
    const session = useSessionStore.getState().sessions[ROUTE]
    expect(session.btwQuestion).toBeNull()
    expect(session.btwResponse).toBeNull()
    expect(session.btwLoading).toBe(false)
  })
})
