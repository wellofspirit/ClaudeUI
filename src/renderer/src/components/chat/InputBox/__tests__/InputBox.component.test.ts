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
 * The second half (describe 'InputBox FC — rendered') renders <InputBox />
 * with a View mock to capture prop callbacks and assert IPC + store effects.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render } from '@testing-library/react'
import { createElement } from 'react'
import { useSessionStore } from '../../../../stores/session-store'
import { resetFactoryCounter } from '@test/factories/messages'
import type { InputBoxViewProps } from '../View'
import { InputBox } from '../InputBox'

// ---------------------------------------------------------------------------
// View mock — captures whatever props the FC passes to InputBoxView
// ---------------------------------------------------------------------------

let viewProps: InputBoxViewProps

vi.mock('../View', () => ({
  InputBoxView: (props: InputBoxViewProps) => {
    viewProps = props
    return null
  }
}))

// ---------------------------------------------------------------------------
// Hook mocks — avoid useSlashMenu/useFileMention/useIsMobile IPC deps
// ---------------------------------------------------------------------------

vi.mock('../../../../hooks/useSlashMenu', () => ({
  useSlashMenu: () => ({
    slashMenuOpen: false,
    slashMenuIndex: 0,
    slashFilter: '',
    filteredCommands: [],
    handleInputChange: () => {},
    handleKeyDown: () => false,
    handleSelect: () => {}
  })
}))

vi.mock('../../../../hooks/useFileMention', () => ({
  useFileMention: () => ({
    fileMentionOpen: false,
    fileMentionIndex: 0,
    filteredEntries: [],
    handleInputChange: () => {},
    handleKeyDown: () => false,
    handleConfirm: () => {}
  })
}))

vi.mock('../../../../hooks/useIsMobile', () => ({
  useIsMobile: () => false
}))

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
    logError: () => {}
  } as any

  useSessionStore.setState({
    activeSessionId: null,
    sessions: {},
    recentSessionIds: []
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

// ---------------------------------------------------------------------------
// InputBox FC — rendered
//
// Renders <InputBox />, captures View props, and asserts IPC + store effects.
// ---------------------------------------------------------------------------

describe('InputBox FC — rendered', () => {
  const FC_ROUTE = 'fc-route-1'

  // Track IPC calls
  const ipcCalls: Record<string, unknown[][]> = {}

  let app: Awaited<ReturnType<typeof import('@test/helpers/boot-test-app').bootTestApp>>

  beforeEach(async () => {
    const { bootTestApp } = await import('@test/helpers/boot-test-app')
    app = await bootTestApp()

    // Reset call tracking
    for (const key of Object.keys(ipcCalls)) delete ipcCalls[key]

    function record(channel: string, ...args: unknown[]): void {
      if (!ipcCalls[channel]) ipcCalls[channel] = []
      ipcCalls[channel].push(args)
    }

    // Register IPC handlers for channels the FC exercises
    app.bridge.ipcMain.handle('session:create', (_e: unknown, ...args: unknown[]) => {
      record('session:create', ...args)
      return null
    })
    app.bridge.ipcMain.handle('session:send', (_e: unknown, ...args: unknown[]) => {
      record('session:send', ...args)
      return null
    })
    app.bridge.ipcMain.handle('session:interrupt', (_e: unknown, ...args: unknown[]) => {
      record('session:interrupt', ...args)
      return null
    })
    app.bridge.ipcMain.handle('session:ask-side-question', (_e: unknown, ...args: unknown[]) => {
      record('session:ask-side-question', ...args)
      return 'side-answer'
    })
    app.bridge.ipcMain.handle('session:set-model', (_e: unknown, ...args: unknown[]) => {
      record('session:set-model', ...args)
      return null
    })
    app.bridge.ipcMain.handle('session:set-effort', (_e: unknown, ...args: unknown[]) => {
      record('session:set-effort', ...args)
      return null
    })
    app.bridge.ipcMain.handle('session:set-thinking-mode', (_e: unknown, ...args: unknown[]) => {
      record('session:set-thinking-mode', ...args)
      return null
    })
    app.bridge.ipcMain.handle(
      'session:set-reasoning-variant',
      (_e: unknown, ...args: unknown[]) => {
        record('session:set-reasoning-variant', ...args)
        return null
      }
    )
    app.bridge.ipcMain.handle('session:cancel', (_e: unknown, ...args: unknown[]) => {
      record('session:cancel', ...args)
      return null
    })
    app.bridge.ipcMain.handle('session:get-models', () => [])
    app.bridge.ipcMain.handle('session:get-engine-models', () => [
      { engineId: 'claude', vendorId: 'anthropic', vendorName: 'Anthropic', models: [] }
    ])
    app.bridge.ipcMain.handle('voice:start-recording', (_e: unknown, ...args: unknown[]) => {
      record('voice:start-recording', ...args)
      return null
    })
    app.bridge.ipcMain.handle('voice:stop-recording', (_e: unknown, ...args: unknown[]) => {
      record('voice:stop-recording', ...args)
      return null
    })
    app.bridge.ipcMain.handle('file:list-dir', () => [])

    // Prepare store: create a session and make it active
    useSessionStore.setState({
      activeSessionId: null,
      sessions: {},
      recentSessionIds: []
    })
    useSessionStore.getState().createNewSession(FC_ROUTE, '/test/cwd')
    useSessionStore.setState({ activeSessionId: FC_ROUTE })
  })

  afterEach(() => {
    app.teardown()
    vi.clearAllMocks()
  })

  function renderFC(): void {
    render(createElement(InputBox))
  }

  it('renders and passes props to View', () => {
    renderFC()
    expect(viewProps).toBeDefined()
    expect(typeof viewProps.onSend).toBe('function')
    expect(typeof viewProps.onCancel).toBe('function')
  })

  it('onSend with draft text: calls createSession + sendPrompt IPC, sets sdkActive in store', async () => {
    // Set draft text before rendering so the FC reads it on mount
    useSessionStore.getState().setDraftText('hello world')

    renderFC()

    // Verify the FC read the draft text
    expect(viewProps.text).toBe('hello world')

    // Trigger send
    await viewProps.onSend()

    // createSession called because sdkActive=false on a new session
    expect(ipcCalls['session:create']).toHaveLength(1)
    expect(ipcCalls['session:create'][0][0]).toBe(FC_ROUTE)

    // sendPrompt called with routingId + prompt
    expect(ipcCalls['session:send']).toHaveLength(1)
    expect(ipcCalls['session:send'][0][0]).toBe(FC_ROUTE)
    expect(ipcCalls['session:send'][0][1]).toBe('hello world')

    // markSdkActive called — sdkActive is now true in store
    expect(useSessionStore.getState().sessions[FC_ROUTE].sdkActive).toBe(true)
  })

  it('onSend with /btw prefix: calls askSideQuestion IPC and setBtwQuestion in store', async () => {
    useSessionStore.getState().setDraftText('/btw What does this function do?')

    renderFC()

    await viewProps.onSend()

    expect(ipcCalls['session:ask-side-question']).toHaveLength(1)
    expect(ipcCalls['session:ask-side-question'][0][0]).toBe(FC_ROUTE)
    expect(ipcCalls['session:ask-side-question'][0][1]).toBe('What does this function do?')

    // createSession / sendPrompt should NOT be called for a side question
    expect(ipcCalls['session:create']).toBeUndefined()
    expect(ipcCalls['session:send']).toBeUndefined()

    // Store has btwQuestion set (the stub returns 'side-answer' synchronously,
    // so by the time we assert, setBtwResponse has already resolved the promise)
    const session = useSessionStore.getState().sessions[FC_ROUTE]
    expect(session.btwQuestion).toBe('What does this function do?')
    // The stub resolves synchronously so btwResponse is already populated
    expect(session.btwResponse).toBe('side-answer')
    expect(session.btwLoading).toBe(false)
  })

  it('onSend with /clear: calls createNewSession in store and does not call sendPrompt', async () => {
    useSessionStore.getState().setDraftText('/clear')

    renderFC()

    const sessionsBefore = Object.keys(useSessionStore.getState().sessions)

    await viewProps.onSend()

    // A new session should have been created (uuid-based key, different from FC_ROUTE)
    const sessionsAfter = Object.keys(useSessionStore.getState().sessions)
    expect(sessionsAfter.length).toBeGreaterThan(sessionsBefore.length)

    // No IPC send should happen
    expect(ipcCalls['session:send']).toBeUndefined()
  })

  it('onCancel: calls interruptSession IPC with active session id', async () => {
    renderFC()

    await viewProps.onCancel()

    expect(ipcCalls['session:interrupt']).toHaveLength(1)
    expect(ipcCalls['session:interrupt'][0][0]).toBe(FC_ROUTE)
  })

  it('onSelectModel (started same-engine session): calls setModel IPC and updates store', async () => {
    renderFC()
    // A live model switch only goes to the backend when the session has STARTED
    // (has a backend sessionId) and the picked engine matches the running engine.
    useSessionStore.setState((state) => ({
      sessions: {
        ...state.sessions,
        [FC_ROUTE]: {
          ...state.sessions[FC_ROUTE],
          status: { ...state.sessions[FC_ROUTE].status, sessionId: 'ses_started' }
        }
      }
    }))

    viewProps.onSelectModel('claude-opus-4-5')

    expect(ipcCalls['session:set-model']).toHaveLength(1)
    expect(ipcCalls['session:set-model'][0][0]).toBe(FC_ROUTE)
    expect(ipcCalls['session:set-model'][0][1]).toBe('claude-opus-4-5')

    // Store updated
    expect(useSessionStore.getState().sessions[FC_ROUTE].selectedModel).toBe('claude-opus-4-5')
  })

  it('onSelectModel (not-yet-started session): updates store but does NOT call setModel IPC', async () => {
    renderFC()
    // Fresh FC session has no backend sessionId — a model pick must only update
    // the store (takes effect on spawn), never send to a not-started backend.
    viewProps.onSelectModel('claude-opus-4-5')

    expect(ipcCalls['session:set-model']).toBeUndefined()
    expect(useSessionStore.getState().sessions[FC_ROUTE].selectedModel).toBe('claude-opus-4-5')
  })

  it('fresh model list is scoped to the selected engine', async () => {
    useSessionStore.setState((state) => ({
      sessions: {
        ...state.sessions,
        [FC_ROUTE]: {
          ...state.sessions[FC_ROUTE],
          selectedEngineId: 'pi',
          selectedModel: 'openai/foo'
        }
      },
      availableModels: [
        {
          value: 'openai/foo',
          displayName: 'OpenCode Foo',
          description: '',
          engineId: 'opencode',
          vendorId: 'openai'
        },
        {
          value: 'openai/foo',
          displayName: 'Pi Foo',
          description: '',
          engineId: 'pi',
          vendorId: 'openai'
        }
      ]
    }))
    renderFC()
    expect(viewProps.models).toEqual([
      expect.objectContaining({ engineId: 'pi', value: 'openai/foo' })
    ])
    expect(viewProps.selectedModel).toEqual(
      expect.objectContaining({ displayName: 'Pi Foo', engineId: 'pi' })
    )
  })

  it('locks engine selection as soon as backend initialization starts', () => {
    useSessionStore.setState((state) => ({
      sessions: {
        ...state.sessions,
        [FC_ROUTE]: { ...state.sessions[FC_ROUTE], sdkActive: true }
      }
    }))
    renderFC()
    expect(viewProps.engineLocked).toBe(true)
  })

  it('locks engine selection until a project session exists', () => {
    useSessionStore.setState({ activeSessionId: null })
    renderFC()
    expect(viewProps.engineLocked).toBe(true)
  })

  it('opencode session with an unavailable model falls back to an opencode model, not Claude', async () => {
    // Regression: when the session's selectedModel isn't in availableModels (e.g.
    // its provider was disabled), the displayed model must fall back to a model of
    // the SESSION's engine — never the global models[0] (a Claude entry), which
    // is how an opencode session used to surface a Claude model in the picker.
    useSessionStore.setState((state) => ({
      sessions: {
        ...state.sessions,
        [FC_ROUTE]: {
          ...state.sessions[FC_ROUTE],
          selectedEngineId: 'opencode',
          isHistorical: true, // engine-locked → picker filters to opencode
          selectedModel: 'opencode/mimo-v2.5-free' // provider disabled → absent below
        }
      },
      availableModels: [
        { value: 'default', displayName: 'Default', description: '', engineId: 'claude' },
        {
          value: 'qwen-sandbox/qwen3.6:27b',
          displayName: 'Qwen 3.6',
          description: '',
          engineId: 'opencode',
          vendorId: 'qwen-sandbox'
        }
      ]
    }))

    renderFC()

    expect(viewProps.selectedModel.value).toBe('qwen-sandbox/qwen3.6:27b')
    expect(viewProps.selectedModel.engineId).toBe('opencode')
  })

  it('onVoiceStop: calls voiceStopRecording IPC with active session id', async () => {
    renderFC()

    await viewProps.onVoiceStop()

    expect(ipcCalls['voice:stop-recording']).toHaveLength(1)
    expect(ipcCalls['voice:stop-recording'][0][0]).toBe(FC_ROUTE)
  })

  it('onSend does nothing when text is empty (noop)', async () => {
    // draftText defaults to '' for a fresh session
    renderFC()

    expect(viewProps.text).toBe('')

    await viewProps.onSend()

    expect(ipcCalls['session:create']).toBeUndefined()
    expect(ipcCalls['session:send']).toBeUndefined()
  })

  it('clears draft text from store after a successful send', async () => {
    useSessionStore.getState().setDraftText('some prompt')

    renderFC()
    await viewProps.onSend()

    // The FC calls setText('') after routing — draftText should be cleared
    expect(useSessionStore.getState().sessions[FC_ROUTE].draftText).toBe('')
  })

  // -------------------------------------------------------------------------
  // Thinking mode + effort: capability props derived from selectedModel,
  // pickers update store, and changing them mid-session restarts the SDK.
  // -------------------------------------------------------------------------

  it('derives capability props from SDK-supplied fields on the "default" alias', () => {
    // Real shape from supportedModels() for a Max-plan user: value is the
    // alias "default", capability flags are set directly on the ModelInfo.
    useSessionStore.setState((state) => ({
      sessions: {
        ...state.sessions,
        [FC_ROUTE]: { ...state.sessions[FC_ROUTE], selectedModel: 'default' }
      },
      availableModels: [
        {
          value: 'default',
          displayName: 'Default (recommended)',
          description: 'Opus 4.7 with 1M context · Most capable for complex work',
          supportsEffort: true,
          supportedEffortLevels: ['low', 'medium', 'high', 'xhigh', 'max'],
          supportsAdaptiveThinking: true
        }
      ]
    }))

    renderFC()

    expect(viewProps.adaptiveSupported).toBe(true)
    expect(viewProps.effortSupported).toBe(true)
    expect(viewProps.allowedEffortLevels).toEqual(['low', 'medium', 'high', 'xhigh', 'max'])
  })

  it('null store effort/thinkingMode → View receives model defaults', () => {
    // Fresh session: store has effort=null, thinkingMode=null (never user-set).
    // FC must resolve these to the current model's defaults. The `default`
    // alias resolves to Opus 4.8, whose cli.js default effort (YK6) is 'high'
    // even though it supports xhigh — so xhigh being in supportedEffortLevels
    // must NOT make it the default.
    useSessionStore.setState((state) => ({
      sessions: {
        ...state.sessions,
        [FC_ROUTE]: {
          ...state.sessions[FC_ROUTE],
          selectedModel: 'default',
          effort: null,
          thinkingMode: null
        }
      },
      availableModels: [
        {
          value: 'default',
          displayName: 'Default',
          description: 'Opus 4.8',
          supportsEffort: true,
          supportedEffortLevels: ['low', 'medium', 'high', 'xhigh', 'max'],
          supportsAdaptiveThinking: true
        }
      ]
    }))

    renderFC()

    expect(viewProps.effort).toBe('high') // Opus 4.8 default (not xhigh)
    expect(viewProps.thinkingMode).toBe('adaptive') // adaptive when supported
  })

  it('null store effort on explicit opus-4-7 → xhigh default', () => {
    // Opus 4.7 (selected by canonical id, not the alias) still defaults to xhigh.
    useSessionStore.setState((state) => ({
      sessions: {
        ...state.sessions,
        [FC_ROUTE]: {
          ...state.sessions[FC_ROUTE],
          selectedModel: 'claude-opus-4-7',
          effort: null,
          thinkingMode: null
        }
      },
      availableModels: [
        {
          value: 'claude-opus-4-7',
          displayName: 'Opus 4.7',
          description: 'Opus 4.7',
          supportsEffort: true,
          supportedEffortLevels: ['low', 'medium', 'high', 'xhigh', 'max'],
          supportsAdaptiveThinking: true
        }
      ]
    }))

    renderFC()

    expect(viewProps.effort).toBe('xhigh') // Opus 4.7 default
    expect(viewProps.thinkingMode).toBe('adaptive')
  })

  it('explicit user pick takes precedence over model default', () => {
    useSessionStore.setState((state) => ({
      sessions: {
        ...state.sessions,
        [FC_ROUTE]: {
          ...state.sessions[FC_ROUTE],
          selectedModel: 'default',
          effort: 'medium', // user explicitly chose medium
          thinkingMode: 'disabled' // user explicitly chose disabled
        }
      },
      availableModels: [
        {
          value: 'default',
          displayName: 'Default',
          description: 'Opus 4.7',
          supportsEffort: true,
          supportedEffortLevels: ['low', 'medium', 'high', 'xhigh', 'max'],
          supportsAdaptiveThinking: true
        }
      ]
    }))

    renderFC()

    expect(viewProps.effort).toBe('medium')
    expect(viewProps.thinkingMode).toBe('disabled')
  })

  it('derives capability props from selectedModel: opus-4-7 → adaptive + xhigh + max', () => {
    useSessionStore.setState((state) => ({
      sessions: {
        ...state.sessions,
        [FC_ROUTE]: { ...state.sessions[FC_ROUTE], selectedModel: 'claude-opus-4-7' }
      },
      availableModels: [
        { value: 'claude-opus-4-7', displayName: 'Opus 4.7', description: 'Opus 4.7' }
      ]
    }))

    renderFC()

    expect(viewProps.adaptiveSupported).toBe(true)
    expect(viewProps.effortSupported).toBe(true)
    expect(viewProps.allowedEffortLevels).toEqual(['low', 'medium', 'high', 'xhigh', 'max'])
  })

  it('derives capability props from selectedModel: sonnet-4-5 → no adaptive, no effort', () => {
    useSessionStore.setState((state) => ({
      sessions: {
        ...state.sessions,
        [FC_ROUTE]: { ...state.sessions[FC_ROUTE], selectedModel: 'claude-sonnet-4-5' }
      },
      availableModels: [
        { value: 'claude-sonnet-4-5', displayName: 'Sonnet 4.5', description: 'Sonnet 4.5' }
      ]
    }))

    renderFC()

    expect(viewProps.adaptiveSupported).toBe(false)
    expect(viewProps.effortSupported).toBe(false)
    expect(viewProps.allowedEffortLevels).toEqual([])
  })

  it('derives capability props from selectedModel: sonnet-4-6 → adaptive + max but no xhigh', () => {
    useSessionStore.setState((state) => ({
      sessions: {
        ...state.sessions,
        [FC_ROUTE]: { ...state.sessions[FC_ROUTE], selectedModel: 'claude-sonnet-4-6' }
      },
      availableModels: [
        { value: 'claude-sonnet-4-6', displayName: 'Sonnet 4.6', description: 'Sonnet 4.6' }
      ]
    }))

    renderFC()

    expect(viewProps.adaptiveSupported).toBe(true)
    expect(viewProps.effortSupported).toBe(true)
    expect(viewProps.allowedEffortLevels).toEqual(['low', 'medium', 'high', 'max'])
  })

  it('onSelectThinking: updates store; no IPC restart when sdkActive=false', async () => {
    renderFC()

    await viewProps.onSelectThinking('disabled')

    expect(useSessionStore.getState().sessions[FC_ROUTE].thinkingMode).toBe('disabled')
    // No active SDK → no cancel/recreate
    expect(ipcCalls['session:cancel']).toBeUndefined()
    expect(ipcCalls['session:create']).toBeUndefined()
  })

  it('onSelectThinking: when sdkActive, cancels + recreates session with new thinkingMode', async () => {
    useSessionStore.getState().markSdkActive(FC_ROUTE)
    renderFC()

    await viewProps.onSelectThinking('enabled')

    expect(useSessionStore.getState().sessions[FC_ROUTE].thinkingMode).toBe('enabled')
    expect(ipcCalls['session:cancel']).toHaveLength(1)
    expect(ipcCalls['session:cancel'][0][0]).toBe(FC_ROUTE)
    expect(ipcCalls['session:create']).toHaveLength(1)
    // createSession args: routingId, cwd, effort, resumeId, permissionMode, model, thinkingMode
    const createArgs = ipcCalls['session:create'][0]
    expect(createArgs[0]).toBe(FC_ROUTE)
    expect(createArgs[6]).toBe('enabled')
  })

  it('onSelectEffort: updates store; no IPC restart when sdkActive=false', async () => {
    renderFC()

    await viewProps.onSelectEffort('high')

    expect(useSessionStore.getState().sessions[FC_ROUTE].effort).toBe('high')
    expect(ipcCalls['session:cancel']).toBeUndefined()
    expect(ipcCalls['session:create']).toBeUndefined()
  })

  it('onSelectEffort: when sdkActive, cancels + recreates session with new effort', async () => {
    useSessionStore.getState().markSdkActive(FC_ROUTE)
    renderFC()

    await viewProps.onSelectEffort('xhigh')

    expect(useSessionStore.getState().sessions[FC_ROUTE].effort).toBe('xhigh')
    expect(ipcCalls['session:cancel']).toHaveLength(1)
    expect(ipcCalls['session:create']).toHaveLength(1)
    const createArgs = ipcCalls['session:create'][0]
    expect(createArgs[2]).toBe('xhigh') // effort
  })

  it('onSelectModel: switching to a model without effort clears the explicit effort pick', () => {
    // Start with explicit picks on a full-featured model. The SDK-provided
    // capability fields are the source of truth.
    useSessionStore.setState((state) => ({
      sessions: {
        ...state.sessions,
        [FC_ROUTE]: {
          ...state.sessions[FC_ROUTE],
          selectedModel: 'default',
          thinkingMode: 'adaptive',
          effort: 'xhigh'
        }
      },
      availableModels: [
        {
          value: 'default',
          displayName: 'Default',
          description: 'Opus 4.7',
          supportsEffort: true,
          supportedEffortLevels: ['low', 'medium', 'high', 'xhigh', 'max'],
          supportsAdaptiveThinking: true
        },
        {
          value: 'haiku',
          displayName: 'Haiku',
          description: 'Haiku 4.5'
          // No capability fields — haiku has neither effort nor adaptive.
        }
      ]
    }))

    renderFC()

    viewProps.onSelectModel('haiku')

    const session = useSessionStore.getState().sessions[FC_ROUTE]
    expect(session.selectedModel).toBe('haiku')
    expect(session.thinkingMode).toBe('enabled') // adaptive coerced (id fallback: haiku)
    expect(session.effort).toBeNull() // effort unsupported → explicit pick cleared
  })

  it('onSelectModel: switching to a model with adaptive but no xhigh coerces xhigh → high', () => {
    useSessionStore.setState((state) => ({
      sessions: {
        ...state.sessions,
        [FC_ROUTE]: {
          ...state.sessions[FC_ROUTE],
          selectedModel: 'default',
          thinkingMode: 'adaptive',
          effort: 'xhigh'
        }
      },
      availableModels: [
        {
          value: 'default',
          displayName: 'Default',
          description: 'Opus 4.7',
          supportsEffort: true,
          supportedEffortLevels: ['low', 'medium', 'high', 'xhigh', 'max'],
          supportsAdaptiveThinking: true
        },
        {
          value: 'sonnet',
          displayName: 'Sonnet',
          description: 'Sonnet 4.6',
          supportsEffort: true,
          supportedEffortLevels: ['low', 'medium', 'high', 'max'],
          supportsAdaptiveThinking: true
        }
      ]
    }))

    renderFC()

    viewProps.onSelectModel('sonnet')

    const session = useSessionStore.getState().sessions[FC_ROUTE]
    expect(session.thinkingMode).toBe('adaptive') // both support adaptive
    expect(session.effort).toBe('high') // xhigh coerced to model's default
  })
})

// ---------------------------------------------------------------------------
// billingType cost gating — ROADMAP #3 (followup-opencode-statusline)
//
// showCostInStatusLine is true for all billingTypes EXCEPT 'free'.
// Claude is never free, so this change is behavior-preserving for it.
// ---------------------------------------------------------------------------

describe('InputBox FC — billingType cost gating (ROADMAP #3)', () => {
  const BT_ROUTE = 'bt-route-1'

  let app: Awaited<ReturnType<typeof import('@test/helpers/boot-test-app').bootTestApp>>

  function renderFC(): void {
    render(createElement(InputBox))
  }

  beforeEach(async () => {
    const { bootTestApp } = await import('@test/helpers/boot-test-app')
    app = await bootTestApp()

    app.bridge.ipcMain.handle('session:get-models', () => [])
    app.bridge.ipcMain.handle('session:get-engine-models', () => [
      {
        engineId: 'claude',
        vendorId: 'anthropic',
        vendorName: 'Anthropic',
        models: []
      }
    ])
    app.bridge.ipcMain.handle('session:scan-custom-commands', () => [])
    app.bridge.ipcMain.handle('file:list-dir', () => [])

    useSessionStore.setState({
      activeSessionId: null,
      sessions: {},
      recentSessionIds: []
    })
    useSessionStore.getState().createNewSession(BT_ROUTE, '/tmp/bt')
    useSessionStore.setState({ activeSessionId: BT_ROUTE })
  })

  afterEach(() => {
    app.teardown()
    vi.clearAllMocks()
  })

  /** Helper: set the active session's status.account.billingType. */
  function setBillingType(billingType: string | undefined): void {
    const state = useSessionStore.getState()
    const session = state.sessions[BT_ROUTE]
    useSessionStore.setState({
      sessions: {
        ...state.sessions,
        [BT_ROUTE]: {
          ...session,
          status: {
            ...session.status,
            account:
              billingType !== undefined
                ? {
                    engineId: 'opencode' as const,
                    vendorId: 'opencode',
                    billingType:
                      billingType as import('../../../../../../shared/types').BillingType,
                    authState: 'authenticated' as const
                  }
                : null
          }
        }
      }
    })
  }

  it('billingType undefined (no account) → showCostInStatusLine=true (Claude-safe default)', () => {
    setBillingType(undefined)
    renderFC()
    expect(viewProps.showCostInStatusLine).toBe(true)
  })

  it("billingType 'unknown' → showCostInStatusLine=true (Claude-safe default)", () => {
    setBillingType('unknown')
    renderFC()
    expect(viewProps.showCostInStatusLine).toBe(true)
  })

  it("billingType 'subscription' → showCostInStatusLine=true (Claude subscription unchanged)", () => {
    setBillingType('subscription')
    renderFC()
    expect(viewProps.showCostInStatusLine).toBe(true)
  })

  it("billingType 'apiKey' → showCostInStatusLine=true (API key users see cost)", () => {
    setBillingType('apiKey')
    renderFC()
    expect(viewProps.showCostInStatusLine).toBe(true)
  })

  it("billingType 'free' → showCostInStatusLine=false (opencode free models hide the $)", () => {
    setBillingType('free')
    renderFC()
    expect(viewProps.showCostInStatusLine).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// ReasoningPicker — opencode per-model reasoning variant support
// ---------------------------------------------------------------------------

describe('InputBox FC — ReasoningPicker (opencode reasoning variants)', () => {
  const RV_ROUTE = 'rv-route-1'

  const ipcCalls: Record<string, unknown[][]> = {}
  let app: Awaited<ReturnType<typeof import('@test/helpers/boot-test-app').bootTestApp>>

  function renderFC(): void {
    render(createElement(InputBox))
  }

  beforeEach(async () => {
    const { bootTestApp } = await import('@test/helpers/boot-test-app')
    app = await bootTestApp()

    for (const key of Object.keys(ipcCalls)) delete ipcCalls[key]
    function record(channel: string, ...args: unknown[]): void {
      if (!ipcCalls[channel]) ipcCalls[channel] = []
      ipcCalls[channel].push(args)
    }

    app.bridge.ipcMain.handle('session:get-models', () => [])
    app.bridge.ipcMain.handle('session:get-engine-models', () => [
      {
        engineId: 'opencode',
        vendorId: 'minimax',
        vendorName: 'MiniMax',
        models: [
          {
            value: 'minimax/minimax-01',
            displayName: 'MiniMax-01',
            description: 'MiniMax · MiniMax-01',
            engineId: 'opencode',
            vendorId: 'minimax',
            supportsEffort: false,
            supportsAdaptiveThinking: false,
            reasoningVariants: ['none', 'thinking']
          }
        ]
      }
    ])
    app.bridge.ipcMain.handle(
      'session:set-reasoning-variant',
      (_e: unknown, ...args: unknown[]) => {
        record('session:set-reasoning-variant', ...args)
        return null
      }
    )
    app.bridge.ipcMain.handle('session:set-model', (_e: unknown, ...args: unknown[]) => {
      record('session:set-model', ...args)
      return null
    })
    app.bridge.ipcMain.handle('session:create', (_e: unknown, ...args: unknown[]) => {
      record('session:create', ...args)
      return null
    })
    app.bridge.ipcMain.handle('file:list-dir', () => [])

    useSessionStore.setState({
      activeSessionId: null,
      sessions: {},
      recentSessionIds: []
    })
    useSessionStore.getState().createNewSession(RV_ROUTE, '/test/cwd')
    useSessionStore.setState({ activeSessionId: RV_ROUTE })
  })

  afterEach(() => {
    app.teardown()
    vi.clearAllMocks()
  })

  const MINIMAX_MODEL = {
    value: 'minimax/minimax-01',
    displayName: 'MiniMax-01',
    description: 'MiniMax · MiniMax-01',
    engineId: 'opencode' as const,
    vendorId: 'minimax',
    supportsEffort: false,
    supportsAdaptiveThinking: false,
    reasoningVariants: ['none', 'thinking'] as string[]
  }

  it('passes reasoningVariants from the selected opencode model to View', async () => {
    // Pre-populate availableModels so the FC can resolve the selected model synchronously.
    useSessionStore.setState((state) => ({
      sessions: {
        ...state.sessions,
        [RV_ROUTE]: {
          ...state.sessions[RV_ROUTE],
          selectedModel: 'minimax/minimax-01',
          selectedEngineId: 'opencode' as const
        }
      },
      availableModels: [MINIMAX_MODEL]
    }))

    renderFC()

    expect(viewProps.reasoningVariants).toEqual(['none', 'thinking'])
  })

  it('passes reasoningVariant (null = Default) to View initially', () => {
    useSessionStore.setState((state) => ({
      sessions: {
        ...state.sessions,
        [RV_ROUTE]: {
          ...state.sessions[RV_ROUTE],
          selectedModel: 'minimax/minimax-01',
          selectedEngineId: 'opencode' as const
        }
      },
      availableModels: [MINIMAX_MODEL]
    }))

    renderFC()

    expect(viewProps.reasoningVariant).toBeNull()
  })

  it('onSelectReasoningVariant: updates store + calls set-reasoning-variant IPC', async () => {
    useSessionStore.setState((state) => ({
      sessions: {
        ...state.sessions,
        [RV_ROUTE]: {
          ...state.sessions[RV_ROUTE],
          selectedModel: 'minimax/minimax-01',
          selectedEngineId: 'opencode' as const
        }
      },
      availableModels: [MINIMAX_MODEL]
    }))

    renderFC()

    viewProps.onSelectReasoningVariant?.('thinking')

    expect(useSessionStore.getState().sessions[RV_ROUTE].reasoningVariant).toBe('thinking')
    expect(ipcCalls['session:set-reasoning-variant']).toHaveLength(1)
    expect(ipcCalls['session:set-reasoning-variant'][0][0]).toBe(RV_ROUTE)
    expect(ipcCalls['session:set-reasoning-variant'][0][1]).toBe('thinking')
  })

  it('onSelectReasoningVariant with null: resets store + IPC to null', async () => {
    useSessionStore.setState((state) => ({
      sessions: {
        ...state.sessions,
        [RV_ROUTE]: {
          ...state.sessions[RV_ROUTE],
          selectedModel: 'minimax/minimax-01',
          selectedEngineId: 'opencode' as const,
          reasoningVariant: 'none'
        }
      },
      availableModels: [MINIMAX_MODEL]
    }))

    renderFC()

    viewProps.onSelectReasoningVariant?.(null)

    expect(useSessionStore.getState().sessions[RV_ROUTE].reasoningVariant).toBeNull()
    expect(ipcCalls['session:set-reasoning-variant'][0][1]).toBeNull()
  })

  it('Claude model with no reasoningVariants → reasoningVariants is empty array', () => {
    // Default session: claude model, no reasoningVariants
    useSessionStore.setState((state) => ({
      sessions: {
        ...state.sessions,
        [RV_ROUTE]: {
          ...state.sessions[RV_ROUTE],
          selectedModel: 'default',
          selectedEngineId: 'claude' as const
        }
      },
      availableModels: [
        {
          value: 'default',
          displayName: 'Default',
          description: 'Claude Default',
          supportsEffort: true,
          supportedEffortLevels: ['low', 'medium', 'high', 'xhigh', 'max'] as const,
          supportsAdaptiveThinking: true
          // no reasoningVariants
        }
      ]
    }))

    renderFC()

    // No reasoningVariants on Claude model → empty or absent
    expect(viewProps.reasoningVariants ?? []).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// pi model fallback (C1 fix) — InputBox's selectedModel memo must never leak
// Claude's Adaptive-thinking / 5-tier effort pickers onto a pi session via the
// synthetic last-resort ModelInfo. An empty catalog (no auth / discovery
// failure) is pi's normal cold-start state — before the fix, the synthetic
// fallback carried no capability flags, so claudeModelCapabilities()'s
// unknown-family heuristic assumed a modern Claude model and turned both
// pickers on.
// ---------------------------------------------------------------------------

describe('InputBox FC — pi model fallback (C1 fix)', () => {
  const PI_ROUTE = 'pi-route-1'

  let app: Awaited<ReturnType<typeof import('@test/helpers/boot-test-app').bootTestApp>>

  function renderFC(): void {
    render(createElement(InputBox))
  }

  beforeEach(async () => {
    const { bootTestApp } = await import('@test/helpers/boot-test-app')
    app = await bootTestApp()

    app.bridge.ipcMain.handle('session:get-models', () => [])
    app.bridge.ipcMain.handle('session:get-engine-models', () => [])
    app.bridge.ipcMain.handle('session:scan-custom-commands', () => [])
    app.bridge.ipcMain.handle('file:list-dir', () => [])

    useSessionStore.setState({
      activeSessionId: null,
      sessions: {},
      recentSessionIds: []
    })
    useSessionStore.getState().createNewSession(PI_ROUTE, '/test/cwd')
    useSessionStore.setState({ activeSessionId: PI_ROUTE })
  })

  afterEach(() => {
    app.teardown()
    vi.clearAllMocks()
  })

  it('empty catalog: fallback ModelInfo has no adaptive/effort picker (regression guard)', () => {
    useSessionStore.setState((state) => ({
      sessions: {
        ...state.sessions,
        [PI_ROUTE]: {
          ...state.sessions[PI_ROUTE],
          selectedEngineId: 'pi',
          selectedModel: 'openai-codex/gpt-5.6-luna'
        }
      },
      availableModels: []
    }))

    renderFC()

    expect(viewProps.adaptiveSupported).toBe(false)
    expect(viewProps.effortSupported).toBe(false)
    expect(viewProps.allowedEffortLevels).toEqual([])
    expect(viewProps.selectedModel.displayName).toBe('Select a model')
  })

  it('discovered pi model with supportsEffort: effort picker shows exactly low/medium/high, no adaptive', () => {
    useSessionStore.setState((state) => ({
      sessions: {
        ...state.sessions,
        [PI_ROUTE]: {
          ...state.sessions[PI_ROUTE],
          selectedEngineId: 'pi',
          selectedModel: 'openai-codex/gpt-5.6-luna'
        }
      },
      availableModels: [
        {
          value: 'openai-codex/gpt-5.6-luna',
          displayName: 'GPT-5.6 Luna',
          description: '200k ctx',
          engineId: 'pi',
          vendorId: 'openai-codex',
          supportsEffort: true,
          supportedEffortLevels: ['low', 'medium', 'high'],
          supportsAdaptiveThinking: false
        }
      ]
    }))

    renderFC()

    expect(viewProps.adaptiveSupported).toBe(false)
    expect(viewProps.effortSupported).toBe(true)
    expect(viewProps.allowedEffortLevels).toEqual(['low', 'medium', 'high'])
  })

  it('unavailable selectedModel falls back to the configured piDefaultModel, not the first pi model', () => {
    useSessionStore.setState((state) => ({
      sessions: {
        ...state.sessions,
        [PI_ROUTE]: {
          ...state.sessions[PI_ROUTE],
          selectedEngineId: 'pi',
          selectedModel: 'openai-codex/stale-model' // not in availableModels below
        }
      },
      piDefaultModel: 'anthropic/claude-sonnet-5',
      availableModels: [
        {
          value: 'openai-codex/gpt-5.6-luna',
          displayName: 'GPT-5.6 Luna (first in list)',
          description: '',
          engineId: 'pi',
          vendorId: 'openai-codex'
        },
        {
          value: 'anthropic/claude-sonnet-5',
          displayName: 'Claude Sonnet 5 (configured default)',
          description: '',
          engineId: 'pi',
          vendorId: 'anthropic'
        }
      ]
    }))

    renderFC()

    expect(viewProps.selectedModel.value).toBe('anthropic/claude-sonnet-5')
    expect(viewProps.selectedModel.displayName).toBe('Claude Sonnet 5 (configured default)')
  })

  it('claude session with empty catalog keeps the "Default" wording (unchanged behavior)', () => {
    useSessionStore.setState((state) => ({
      sessions: {
        ...state.sessions,
        [PI_ROUTE]: {
          ...state.sessions[PI_ROUTE],
          selectedEngineId: 'claude',
          selectedModel: 'default'
        }
      },
      availableModels: []
    }))

    renderFC()

    expect(viewProps.selectedModel.displayName).toBe('Default')
  })
})
