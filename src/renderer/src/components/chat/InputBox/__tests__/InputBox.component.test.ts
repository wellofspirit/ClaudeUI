/**
 * Layer 2: Component tests for InputBox store integration patterns.
 *
 * resolveSendAction unit tests live in utils.test.ts. This file covers
 * the store-side behaviors that InputBox depends on:
 *
 *   - createNewSession + markSdkActive lifecycle
 *   - setQueueState accumulation and consumed-item flush (ADR-053)
 *   - setDraftText / clearance semantics
 *   - appendVoiceTranscript (final vs interim)
 *   - setBtwQuestion / setBtwResponse BTW side-question flow
 *
 * The second half (describe 'InputBox FC — rendered') renders <InputBox />
 * with a View mock to capture prop callbacks and assert IPC + store effects.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { act, cleanup, render } from '@testing-library/react'
import { createElement } from 'react'
import { markViewEvicted, useSessionStore } from '../../../../stores/session-store'
import {
  reloadActiveTranscript,
  resetHistoryLoadForTests
} from '../../../../lib/session-history-load'
import { resetFactoryCounter } from '@test/factories/messages'
import type { InputBoxViewProps } from '../View'
import type { ModelInfo, QueuedItem } from '../../../../../../shared/types'
import { InputBox } from '../InputBox'
import {
  resetVoiceNoticesForTests,
  showVoiceNotice,
  useVoiceNoticeStore,
  voiceNoticeFor
} from '../../../../lib/voice/voice-notice'
import {
  applyVoicePackStatus,
  resetVoicePackStoreForTests,
  useVoicePackStore
} from '../../../../lib/voice/voice-pack-store'
import type { VoicePackState, VoicePackStatus } from '../../../../../../shared/voice-pack'
import { type EffortLevel } from '../../../../../../shared/model-capabilities'
import {
  seed,
  emitSync,
  mirrorStoreIntoReplica,
  resetReplicaSeam
} from '@test/helpers/replica-seed'

// ---------------------------------------------------------------------------
// View mock — captures whatever props the FC passes to InputBoxView
// ---------------------------------------------------------------------------

let viewProps: InputBoxViewProps
/** Every pill the view was rendered with, in order (to prove what was NEVER shown). */
const viewLog: Array<InputBoxViewProps['voiceNotice']> = []

vi.mock('../View', () => ({
  InputBoxView: (props: InputBoxViewProps) => {
    viewProps = props
    viewLog.push(props.voiceNotice ?? null)
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

// The voice controller with its microphone taken out: jsdom has no audio, so the
// real capture would refuse before the TRANSPORT is ever reached. What these
// tests pin is InputBox's sequencing (held/press refs around `ensureSession()`)
// as it reaches the transport — `window.api.voiceStart` / `voiceStop`, i.e. the
// `voice:start-recording` / `voice:stop-recording` invokes recorded below. The
// controller's own capture-vs-transport order is voice-controller.unit.test.ts's.
const voiceFaults = vi.hoisted(() => new Set<(message: string) => void>())
const voiceSwitches = vi.hoisted(() => new Set<(label: string) => void>())
const voiceSilences = vi.hoisted(
  () => new Set<(silence: { silent: boolean; trackLabel: string | null }) => void>()
)
vi.mock('../../../../lib/voice/voice-controller', () => ({
  voiceController: () => ({
    start: (routingId: string, language: string) => window.api.voiceStart(routingId, language),
    stop: (routingId: string) => window.api.voiceStop(routingId),
    isActive: () => false,
    onFault: (listener: (message: string) => void) => {
      voiceFaults.add(listener)
      return () => voiceFaults.delete(listener)
    },
    onLevel: () => () => {},
    onSwitch: (listener: (label: string) => void) => {
      voiceSwitches.add(listener)
      return () => voiceSwitches.delete(listener)
    },
    onSilence: (listener: (silence: { silent: boolean; trackLabel: string | null }) => void) => {
      voiceSilences.add(listener)
      return () => voiceSilences.delete(listener)
    }
  })
}))

const ROUTE = 'r-input-1'

function setupSession(routingId = ROUTE, cwd = '/test'): void {
  useSessionStore.getState().createNewSession(routingId, cwd)
  useSessionStore.setState({ activeSessionId: routingId })
}

// The store as it was built, before any test touched it.
const INITIAL_STATE = useSessionStore.getState()

beforeEach(() => {
  // Tests write the remembered engine / model / effort picks into the store AND
  // localStorage (the store mirrors them there and reads them back). Restore the
  // whole store, not a list of fields, so no pick outlives the test that made it.
  localStorage.clear()
  useSessionStore.setState(INITIAL_STATE, true)
  // The replica is a module singleton: without this the previous test's folded
  // transcript (steer- messages included) carries into this one (SyncCore 4c).
  resetReplicaSeam()
  resetFactoryCounter()
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
  mirrorStoreIntoReplica()
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
// Queue of record (ADR-053) — what InputBox displays for 'queue-prompt'
// ---------------------------------------------------------------------------

const queued = (itemId: string, text: string): QueuedItem => ({ itemId, text, state: 'queued' })

describe('setQueueState — queued-item accumulation', () => {
  it('holds a single queued item for an idle session', () => {
    setupSession()
    seed.queue(ROUTE, [queued('i1', 'first message')])
    expect(useSessionStore.getState().sessions[ROUTE].queuedItems.map((i) => i.text)).toEqual([
      'first message'
    ])
  })

  it('keeps items separate and in order (the client joins them, storage never does)', () => {
    setupSession()
    seed.queue(ROUTE, [queued('i1', 'first'), queued('i2', 'second')])
    const items = useSessionStore.getState().sessions[ROUTE].queuedItems
    expect(items.map((i) => i.text)).toEqual(['first', 'second'])
    expect(items.map((i) => i.text).join('\n')).toBe('first\nsecond')
  })

  it('replaces the list wholesale — the broadcast is the full queue', () => {
    setupSession()
    seed.queue(ROUTE, [queued('i1', 'a'), queued('i2', 'b'), queued('i3', 'c')])
    seed.queue(ROUTE, [queued('i3', 'c')])
    expect(useSessionStore.getState().sessions[ROUTE].queuedItems.map((i) => i.text)).toEqual(['c'])
  })

  it('does nothing when the routingId session does not exist', () => {
    // No session created — should not throw
    seed.queue('nonexistent', [queued('i1', 'oops')])
    expect(useSessionStore.getState().sessions['nonexistent']).toBeUndefined()
  })
})

describe('setQueueState — consumed items flush to messages', () => {
  it('appends a user message for a consumed item and drops it from the card', () => {
    setupSession()
    seed.queue(ROUTE, [queued('i1', 'queued prompt')])
    seed.queue(ROUTE, [{ itemId: 'i1', text: 'queued prompt', state: 'consumed' }])

    const session = useSessionStore.getState().sessions[ROUTE]
    expect(session.queuedItems).toEqual([])
    const lastMsg = session.messages[session.messages.length - 1]
    expect(lastMsg.id).toBe('steer-i1')
    expect(lastMsg.role).toBe('user')
    expect(lastMsg.content[0]).toMatchObject({ type: 'text', text: 'queued prompt' })
  })

  it('does nothing when the payload holds no consumed items', () => {
    setupSession()
    const before = useSessionStore.getState().sessions[ROUTE].messages.length
    seed.queue(ROUTE, [])
    const after = useSessionStore.getState().sessions[ROUTE].messages.length
    expect(after).toBe(before)
  })

  it('flushes multiple accumulated items as SEPARATE messages, not one blob', () => {
    setupSession()
    seed.queue(ROUTE, [queued('i1', 'first'), queued('i2', 'second')])
    seed.queue(ROUTE, [
      { itemId: 'i1', text: 'first', state: 'consumed' },
      { itemId: 'i2', text: 'second', state: 'consumed' }
    ])

    const session = useSessionStore.getState().sessions[ROUTE]
    expect(session.queuedItems).toEqual([])
    const texts = session.messages.slice(-2).map((m) => m.content[0])
    expect(texts).toEqual([
      { type: 'text', text: 'first' },
      { type: 'text', text: 'second' }
    ])
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
  /** What `session:get-engine-models` answers — the FC's mount fetch REPLACES
   *  `availableModels` with it, so a test that needs Claude rows sets both. */
  let fcClaudeModels: ModelInfo[] = []

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
    // ADR-068 §2 — the ChatGPT account list.
    app.bridge.ipcMain.handle('provider-account:list', (_e: unknown, ...args: unknown[]) => {
      record('provider-account:list', ...args)
      return { ok: true, data: useSessionStore.getState().providerAccounts }
    })
    app.bridge.ipcMain.handle('session:get-models', () => [])
    fcClaudeModels = []
    app.bridge.ipcMain.handle('session:get-engine-models', () => [
      { engineId: 'claude', vendorId: 'anthropic', vendorName: 'Anthropic', models: fcClaudeModels }
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
    useSessionStore.setState((state) => ({
      activeSessionId: null,
      sessions: {},
      recentSessionIds: [],
      lastSelectedEngineId: 'claude',
      availableModels: [],
      // The Claude-defaults tests below write these; none may leak forward.
      claudeDefaultModel: '',
      claudeDefaultModelConfigured: false,
      opencodeDefaultModel: '',
      opencodeDefaultModelConfigured: false,
      piDefaultModel: '',
      piDefaultModelConfigured: false,
      settings: {
        ...state.settings,
        modelEffortDefaults: {},
        engineEffortDefaults: {},
        newSessionModel: undefined
      }
    }))
    mirrorStoreIntoReplica()
    useSessionStore.getState().createNewSession(FC_ROUTE, '/test/cwd')
    useSessionStore.setState({ activeSessionId: FC_ROUTE })
  })

  afterEach(() => {
    app.teardown()
    resetHistoryLoadForTests()
    vi.clearAllMocks()
  })

  function renderFC(): void {
    render(createElement(InputBox))
  }

  it('keeps the "Name · detail" shortName split for every engine', () => {
    useSessionStore.setState((state) => ({
      sessions: {
        ...state.sessions,
        [FC_ROUTE]: { ...state.sessions[FC_ROUTE], selectedModel: 'default' }
      },
      availableModels: [
        {
          value: 'default',
          displayName: 'Default (recommended)',
          description: 'Opus 4.7 with 1M context · Most capable for complex work'
        }
      ]
    }))
    mirrorStoreIntoReplica()
    renderFC()
    expect(viewProps.selectedModel.shortName).toBe('Opus 4.7 with 1M context')
  })

  // ── Claude defaults (ADR-074 §8) ──────────────────────────────────────

  const claudeRow = (value: string, resolvedModel: string, displayName = value): ModelInfo => ({
    value,
    resolvedModel,
    displayName,
    description: '',
    engineId: 'claude',
    supportsEffort: true,
    supportedEffortLevels: ['low', 'medium', 'high', 'xhigh', 'max']
  })

  async function sendDraft(): Promise<void> {
    await act(async () => {
      useSessionStore.getState().setDraftText('go')
    })
    await act(async () => {
      await viewProps.onSend()
    })
  }

  it('reads the effort saved for the alias, and `default` reads the alias it lands on', async () => {
    // The Default models table keys `opus` by name, so the setting follows the
    // alias to a new model; `default` shares the row of the alias that
    // resolves where it does.
    fcClaudeModels = [
      claudeRow('default', 'claude-opus-5-5'),
      claudeRow('opus', 'claude-opus-5-5'),
      claudeRow('claude-opus-5', 'claude-opus-5')
    ]
    useSessionStore.setState((state) => ({
      settings: {
        ...state.settings,
        modelEffortDefaults: { opus: 'low', 'claude-opus-5-5': 'max', 'claude-opus-5': 'xhigh' }
      },
      availableModels: fcClaudeModels,
      sessions: {
        ...state.sessions,
        [FC_ROUTE]: { ...state.sessions[FC_ROUTE], selectedModel: 'default' }
      }
    }))
    mirrorStoreIntoReplica()
    renderFC()
    await sendDraft()
    expect(ipcCalls['session:create'][0][5]).toBe('default')
    expect(ipcCalls['session:create'][0][2]).toBe('low')
  })

  it('still reads a v3.5 effort saved under the model the alias RESOLVES to', async () => {
    // v3.5 keyed `opus` by what cli.js said it resolved to (`claude-opus-5`).
    // Until the row is edited that value still applies.
    fcClaudeModels = [claudeRow('opus', 'claude-opus-5[1m]')]
    useSessionStore.setState((state) => ({
      settings: { ...state.settings, modelEffortDefaults: { 'claude-opus-5': 'low' } },
      availableModels: fcClaudeModels,
      sessions: {
        ...state.sessions,
        [FC_ROUTE]: { ...state.sessions[FC_ROUTE], selectedModel: 'opus' }
      }
    }))
    mirrorStoreIntoReplica()
    renderFC()
    await sendDraft()
    expect(ipcCalls['session:create'][0][5]).toBe('opus')
    expect(ipcCalls['session:create'][0][2]).toBe('low')
  })

  it('a session saved on a concrete Claude model shows its alias, and spawns its own value', async () => {
    // ADR-100: the catalog lists aliases only. Display (and the effort read)
    // goes through the alias that runs the model; the session is not rewritten.
    fcClaudeModels = [
      claudeRow('default', 'claude-opus-5-5[1m]', 'Default (recommended)'),
      claudeRow('sonnet', 'claude-sonnet-5-5', 'Sonnet 5.5')
    ]
    useSessionStore.setState((state) => ({
      settings: { ...state.settings, modelEffortDefaults: { sonnet: 'low' } },
      availableModels: fcClaudeModels,
      sessions: {
        ...state.sessions,
        [FC_ROUTE]: { ...state.sessions[FC_ROUTE], selectedModel: 'claude-sonnet-5-5' }
      }
    }))
    mirrorStoreIntoReplica()
    renderFC()
    expect(viewProps.selectedModel.value).toBe('sonnet')
    await sendDraft()
    expect(ipcCalls['session:create'][0][5]).toBe('claude-sonnet-5-5')
    expect(ipcCalls['session:create'][0][2]).toBe('low')
  })

  it('an UNCONFIGURED Claude default still spawns an empty model exactly as before', async () => {
    useSessionStore.setState((state) => ({
      claudeDefaultModel: '',
      claudeDefaultModelConfigured: false,
      sessions: {
        ...state.sessions,
        [FC_ROUTE]: { ...state.sessions[FC_ROUTE], selectedModel: '' }
      }
    }))
    mirrorStoreIntoReplica()
    renderFC()
    await sendDraft()
    expect(ipcCalls['session:create']).toHaveLength(1)
  })

  it('refuses to spawn Claude on the empty model an orphaned CONFIGURED default seeds', async () => {
    // cli.js would otherwise start on its own default — the silent substitute
    // ADR-059 forbids.
    fcClaudeModels = [claudeRow('default', 'claude-opus-5[1m]')]
    useSessionStore.setState((state) => ({
      claudeDefaultModel: 'claude-opus-4-7',
      claudeDefaultModelConfigured: true,
      availableModels: fcClaudeModels,
      sessions: {
        ...state.sessions,
        [FC_ROUTE]: { ...state.sessions[FC_ROUTE], selectedModel: '' }
      }
    }))
    mirrorStoreIntoReplica()
    renderFC()
    expect(viewProps.selectedModel.shortName).toBe('Select model')
    await sendDraft()
    expect(ipcCalls['session:create']).toBeUndefined()
    expect(useSessionStore.getState().sessions[FC_ROUTE].errors.join(' ')).toMatch(
      /No model selected/
    )
  })

  it('previews the CONFIGURED Claude default on the welcome screen, and the first row when unset', async () => {
    const models = [
      claudeRow('default', 'claude-opus-5[1m]', 'Default (recommended)'),
      claudeRow('sonnet', 'claude-sonnet-5', 'Sonnet 5')
    ]
    fcClaudeModels = models
    useSessionStore.setState({ activeSessionId: null, availableModels: models })
    mirrorStoreIntoReplica()
    renderFC()
    await act(async () => {})
    expect(viewProps.selectedModel.value).toBe('default')
    cleanup()

    useSessionStore.setState({
      claudeDefaultModel: 'sonnet',
      claudeDefaultModelConfigured: true
    })
    mirrorStoreIntoReplica()
    renderFC()
    await act(async () => {})
    expect(viewProps.selectedModel.value).toBe('sonnet')
  })

  it('the welcome pill previews what "New sessions start on" will seed (slice 9)', async () => {
    const models = [
      claudeRow('default', 'claude-opus-5[1m]', 'Default (recommended)'),
      claudeRow('sonnet', 'claude-sonnet-5', 'Sonnet 5'),
      claudeRow('haiku', 'claude-haiku-4-5', 'Haiku 4.5')
    ]
    fcClaudeModels = models
    const withMode = (mode: 'last-picked' | 'configured-default'): void => {
      useSessionStore.setState((state) => ({
        activeSessionId: null,
        availableModels: models,
        lastSelectedModelByEngine: { claude: 'haiku' },
        claudeDefaultModel: 'sonnet',
        claudeDefaultModelConfigured: true,
        settings: { ...state.settings, newSessionModel: mode }
      }))
      mirrorStoreIntoReplica()
    }
    // Last pick wins: the pill names the sticky model.
    withMode('last-picked')
    renderFC()
    await act(async () => {})
    expect(viewProps.selectedModel.value).toBe('haiku')
    cleanup()

    // Configured default wins: the pill names it, sticky or not.
    withMode('configured-default')
    renderFC()
    await act(async () => {})
    expect(viewProps.selectedModel.value).toBe('sonnet')
    useSessionStore.setState((state) => ({
      settings: { ...state.settings, newSessionModel: undefined }
    }))
  })

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

  // ADR-087 §2: a snapshot that did not carry this transcript leaves an EMPTY,
  // evicted entry that is still an existing conversation. The resume decision used
  // to be `messages.length > 0`, so a prompt sent before the disk reload landed (or
  // after it failed) spawned a brand-new conversation under the same row.
  describe('a send on an evicted, empty session resumes it by id', () => {
    const resumeIdOfSpawn = (): unknown => ipcCalls['session:create'][0][3]

    it('control: a never-spawned empty session starts fresh (no resume id)', async () => {
      useSessionStore.getState().setDraftText('hello')
      renderFC()
      await viewProps.onSend()
      expect(resumeIdOfSpawn()).toBeUndefined()
    })

    it('send', async () => {
      markViewEvicted([FC_ROUTE])
      useSessionStore.getState().setDraftText('hello')
      renderFC()
      await viewProps.onSend()
      expect(resumeIdOfSpawn()).toBe(FC_ROUTE)
    })

    it('waits for the transcript reload in flight, then resumes, with history already in place', async () => {
      // The host seeds its own transcript the moment the engine spawns. A client
      // read still open at that point loses the race and the sender is left with
      // only the new turn, so the spawn must not start until the read settles.
      markViewEvicted([FC_ROUTE])
      useSessionStore.setState({
        directories: [
          {
            cwd: '/test/cwd',
            projectKey: '-test-cwd',
            folderName: 'cwd',
            sessions: [
              {
                sessionId: FC_ROUTE,
                cwd: '/test/cwd',
                projectKey: '-test-cwd',
                title: 'Existing',
                timestamp: 1,
                lastActivityAt: 1
              }
            ]
          }
        ]
      })
      let release!: (value: unknown) => void
      Object.assign(window.api, {
        loadSessionHistory: vi.fn(() => new Promise((resolve) => (release = resolve)))
      })
      const reload = reloadActiveTranscript(FC_ROUTE)
      useSessionStore.getState().setDraftText('hello')
      renderFC()

      const sent = viewProps.onSend()
      await act(async () => new Promise((resolve) => setTimeout(resolve, 20)))
      // Held behind the reload: no spawn yet.
      expect(ipcCalls['session:create']).toBeUndefined()

      release({
        messages: [
          { id: 'h1', role: 'assistant', content: [{ type: 'text', text: 'h1' }], timestamp: 1 }
        ],
        taskNotifications: [],
        customTitle: null,
        agentIdToToolUseId: {},
        statusLine: null,
        warnings: []
      })
      await act(async () => {
        await reload
        await sent
      })

      expect(ipcCalls['session:create']).toHaveLength(1)
      expect(ipcCalls['session:create'][0][3]).toBe(FC_ROUTE)
      expect(useSessionStore.getState().sessions[FC_ROUTE].messages.map((m) => m.id)).toEqual([
        'h1'
      ])
    })

    it('push-to-talk spawn (ensureSession)', async () => {
      markViewEvicted([FC_ROUTE])
      renderFC()
      await act(async () => {
        await viewProps.onVoiceStart()
      })
      expect(resumeIdOfSpawn()).toBe(FC_ROUTE)
    })
  })

  // The pre-spawn mode pick has no event to carry it: `changePermissionMode`
  // writes it into this client's replica and the spawn reads it back off the
  // session. Pin the whole path — pick, then send — so a regression that drops
  // the local write shows up as a session spawned in the wrong mode, which is
  // the part that actually matters.
  it('onSend carries a pre-spawn permission-mode pick into createSession', async () => {
    useSessionStore.getState().changePermissionMode(FC_ROUTE, 'plan')
    useSessionStore.getState().setDraftText('hello world')

    renderFC()

    await viewProps.onSend()

    expect(ipcCalls['session:create']).toHaveLength(1)
    // args: routingId, cwd, effort, resumeId, permissionMode, model, thinkingMode
    expect(ipcCalls['session:create'][0][4]).toBe('plan')
  })

  it('onSend clears the draft when the engine rekeys the session mid-send', async () => {
    // An engine can report its stable session id while
    // `sendPrompt` is still awaiting — so the rekey retires
    // FC_ROUTE before handleSend's continuation runs. Guarding on the captured
    // (now dead) id left the sent prompt sitting in the textarea.
    const REKEYED = 'stable-1'
    app.bridge.ipcMain.handle('session:send', (_e: unknown, ...args: unknown[]) => {
      if (!ipcCalls['session:send']) ipcCalls['session:send'] = []
      ipcCalls['session:send'].push(args)
      seed.rekey(FC_ROUTE, REKEYED)
      return null
    })

    useSessionStore.getState().setDraftText('hello world')
    useSessionStore.getState().addDraftAttachments(FC_ROUTE, [
      {
        id: 'att-1',
        fileName: 'shot.png',
        fileType: 'image',
        mediaType: 'image/png',
        base64Data: 'AAAA',
        previewUrl: 'blob:shot'
      }
    ])

    renderFC()
    await act(async () => {
      await viewProps.onSend()
    })

    // The rekey landed, and the send targeted the id that was live when it was issued.
    expect(useSessionStore.getState().activeSessionId).toBe(REKEYED)
    expect(ipcCalls['session:send'][0][0]).toBe(FC_ROUTE)
    expect(useSessionStore.getState().sessions[FC_ROUTE]).toBeUndefined()

    const settled = useSessionStore.getState().sessions[REKEYED]
    expect(settled.draftText).toBe('')
    expect(settled.draftAttachments).toEqual([])
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
    mirrorStoreIntoReplica()

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
    mirrorStoreIntoReplica()
    renderFC()
    expect(viewProps.models).toEqual([
      expect.objectContaining({ engineId: 'pi', value: 'openai/foo' })
    ])
    expect(viewProps.selectedModel).toEqual(
      expect.objectContaining({ displayName: 'Pi Foo', engineId: 'pi' })
    )
  })

  // R1b — a reopened opencode/pi session whose model the discovered catalog
  // does not (yet) hold used to read as the CONFIGURED default: a model the
  // session never ran and the resume will not spawn.
  it.each(['claude', 'opencode', 'pi'] as const)(
    '%s: changing defaults and curation preserves the live model and capabilities until an explicit pick',
    async (engine) => {
      const oldValue = engine === 'claude' ? 'old-model' : 'provider/old-model'
      const nextValue = engine === 'claude' ? 'new-model' : 'provider/new-model'
      const oldModel: ModelInfo = {
        value: oldValue,
        displayName: 'Old model',
        description: '',
        engineId: engine,
        vision: false,
        supportsEffort: true,
        supportedEffortLevels: ['low', 'high'],
        supportsAdaptiveThinking: false
      }
      const nextModel: ModelInfo = {
        value: nextValue,
        displayName: 'New model',
        description: '',
        engineId: engine,
        vision: true,
        supportsEffort: false,
        supportsAdaptiveThinking: false
      }
      useSessionStore.setState((state) => ({
        availableModels: [oldModel, nextModel],
        sessions: {
          ...state.sessions,
          [FC_ROUTE]: {
            ...state.sessions[FC_ROUTE],
            selectedEngineId: engine,
            selectedModel: oldValue,
            sdkActive: true,
            status: {
              ...state.sessions[FC_ROUTE].status,
              engineId: engine,
              sessionId: 'live-session',
              model: { engineId: engine, vendorId: 'provider', modelId: 'old-model' },
              capabilities: {
                ...state.sessions[FC_ROUTE].status.capabilities,
                vision: false,
                reasoning: {
                  effort: { levels: ['low', 'high'] },
                  ...(engine === 'claude' ? { thinking: { modes: ['adaptive'] as const } } : {})
                }
              }
            }
          }
        }
      }))
      mirrorStoreIntoReplica()
      fcClaudeModels = [oldModel, nextModel]
      await act(async () => {
        renderFC()
      })
      expect(viewProps.selectedModel.value).toBe(oldValue)

      await act(async () => {
        useSessionStore.setState({
          availableModels: [nextModel],
          [`${engine}DefaultModel`]: nextValue,
          [`${engine}DefaultModelConfigured`]: true
        })
      })
      expect(viewProps.selectedModel.value).toBe(oldValue)
      expect(viewProps.selectedModel.shortName).toBe(oldValue)
      expect(viewProps.models.map((model) => model.value)).toEqual([nextValue])
      expect(viewProps.visionEnabled).toBe(false)
      expect(viewProps.effortSupported).toBe(true)
      expect(viewProps.allowedEffortLevels).toEqual(['low', 'high'])
      expect(viewProps.showThinkingPicker).toBe(engine === 'claude')
      if (engine === 'claude') expect(viewProps.thinkingMode).toBe('adaptive')
      expect(ipcCalls['session:set-model']).toBeUndefined()
      expect(useSessionStore.getState().sessions[FC_ROUTE].selectedModel).toBe(oldValue)

      await act(async () => {
        viewProps.onSelectModel(nextValue)
      })
      expect(ipcCalls['session:set-model']).toEqual([[FC_ROUTE, nextValue]])
      expect(useSessionStore.getState().sessions[FC_ROUTE].selectedModel).toBe(nextValue)
      if (engine !== 'claude') expect(viewProps.selectedModel.value).toBe(oldValue)
      // Vision follows the backend acknowledgement, not the catalog/default edit.
      expect(viewProps.visionEnabled).toBe(false)
      await act(async () => {
        const status = useSessionStore.getState().sessions[FC_ROUTE].status
        seed.status(FC_ROUTE, {
          ...status,
          model: { engineId: engine, vendorId: 'provider', modelId: 'new-model' },
          capabilities: { ...status.capabilities, vision: true, reasoning: {} }
        })
      })
      expect(viewProps.selectedModel.value).toBe(nextValue)
      expect(viewProps.visionEnabled).toBe(true)
      expect(viewProps.effortSupported).toBe(false)
    }
  )

  const OPENCODE_CATALOG: ModelInfo[] = [
    {
      value: 'anthropic/claude-x',
      displayName: 'Claude X',
      description: '',
      engineId: 'opencode',
      vendorId: 'anthropic'
    }
  ]

  it.each(['opencode', 'pi'] as const)(
    '%s displays the live model even when a snapshot has a different listed selection',
    async (engine) => {
      const next: ModelInfo = {
        value: 'local/new-default',
        engineId: engine,
        displayName: 'New default',
        description: '',
        vision: true,
        supportsEffort: false,
        supportsAdaptiveThinking: false
      }
      useSessionStore.setState((state) => ({
        availableModels: [next],
        sessions: {
          ...state.sessions,
          [FC_ROUTE]: {
            ...state.sessions[FC_ROUTE],
            selectedEngineId: engine,
            selectedModel: next.value,
            sdkActive: true,
            status: {
              ...state.sessions[FC_ROUTE].status,
              engineId: engine,
              sessionId: 'live',
              model: { engineId: engine, vendorId: 'local', modelId: 'old-model' },
              capabilities: {
                ...state.sessions[FC_ROUTE].status.capabilities,
                vision: false,
                reasoning: {}
              }
            }
          }
        }
      }))
      mirrorStoreIntoReplica()
      fcClaudeModels = [next]
      await act(async () => {
        renderFC()
      })
      expect(viewProps.selectedModel.value).toBe('local/old-model')
      expect(viewProps.selectedModel.shortName).toBe('local/old-model')
      expect(viewProps.visionEnabled).toBe(false)
      expect(viewProps.effortSupported).toBe(false)
      expect(ipcCalls['session:set-model']).toBeUndefined()
    }
  )

  it('an active opencode session names an absent model as unavailable, not as the default', () => {
    useSessionStore.setState((state) => ({
      opencodeDefaultModel: 'anthropic/claude-x',
      opencodeDefaultModelConfigured: true,
      sessions: {
        ...state.sessions,
        [FC_ROUTE]: {
          ...state.sessions[FC_ROUTE],
          selectedEngineId: 'opencode',
          selectedModel: 'alicloud/qwen-x'
        }
      },
      availableModels: OPENCODE_CATALOG
    }))
    mirrorStoreIntoReplica()
    renderFC()

    expect(viewProps.selectedModel.shortName).toBe('alicloud/qwen-x')
    expect(viewProps.selectedModel.displayName).not.toBe('Claude X')
  })

  it('the welcome screen with the same catalog still names the configured default', () => {
    useSessionStore.setState({
      activeSessionId: null,
      lastSelectedEngineId: 'opencode',
      opencodeDefaultModel: 'anthropic/claude-x',
      opencodeDefaultModelConfigured: true,
      availableModels: OPENCODE_CATALOG
    })
    mirrorStoreIntoReplica()
    renderFC()

    expect(viewProps.selectedModel.displayName).toBe('Claude X')
  })

  it('hides engine selection as soon as backend initialization starts', () => {
    useSessionStore.setState((state) => ({
      sessions: {
        ...state.sessions,
        [FC_ROUTE]: { ...state.sessions[FC_ROUTE], sdkActive: true }
      }
    }))
    mirrorStoreIntoReplica()
    renderFC()
    expect(viewProps.engineLocked).toBe(true)
    expect(viewProps.showEnginePicker).toBe(false)
  })

  it('uses an unlocked pending engine on welcome and applies it to the next project session', () => {
    useSessionStore.setState({
      activeSessionId: null,
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
    })
    renderFC()

    expect(viewProps.engineLocked).toBe(false)
    expect(viewProps.showEnginePicker).toBe(true)
    expect(viewProps.selectedEngineId).toBe('claude')

    act(() => {
      viewProps.onSelectEngine('pi')
    })

    expect(useSessionStore.getState().lastSelectedEngineId).toBe('pi')
    expect(localStorage.getItem('lastSelectedEngineId')).toBe('pi')
    expect(viewProps.selectedEngineId).toBe('pi')
    expect(viewProps.models).toEqual([
      expect.objectContaining({ engineId: 'pi', value: 'openai/foo', displayName: 'Pi Foo' })
    ])
    expect(viewProps.selectedModel).toEqual(
      expect.objectContaining({ engineId: 'pi', value: 'openai/foo', displayName: 'Pi Foo' })
    )

    act(() => {
      useSessionStore.getState().createNewSession('welcome-pi', '/project')
    })
    expect(useSessionStore.getState().sessions['welcome-pi'].selectedEngineId).toBe('pi')
  })

  it.each([
    [
      'started',
      (state: ReturnType<typeof useSessionStore.getState>) => ({
        status: { ...state.sessions[FC_ROUTE].status, sessionId: 'started' }
      })
    ],
    ['historical', () => ({ isHistorical: true })]
  ])('hides engine selection for a %s session', (_state, change) => {
    useSessionStore.setState((state) => ({
      sessions: {
        ...state.sessions,
        [FC_ROUTE]: { ...state.sessions[FC_ROUTE], ...change(state) }
      }
    }))
    mirrorStoreIntoReplica()
    renderFC()
    expect(viewProps.engineLocked).toBe(true)
    expect(viewProps.showEnginePicker).toBe(false)
  })

  it('opencode session with an unavailable model says so, and never names a Claude one', async () => {
    // Regression: when the session's selectedModel isn't in availableModels (e.g.
    // its provider was disabled), the pill must never fall through to the global
    // models[0] (a Claude entry), which is how an opencode session used to
    // surface a Claude model in the picker. On an ACTIVE session it now names no
    // substitute at all (R1b) — the row says the catalog cannot place it.
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
    mirrorStoreIntoReplica()

    renderFC()

    expect(viewProps.selectedModel.displayName).toBe('opencode/mimo-v2.5-free')
    expect(viewProps.selectedModel.engineId).toBe('opencode')
  })

  // S2 item 6 made every voice failure visible; S3a moved them off the session's
  // error stack. A start/stop the renderer saw fail, a microphone fault and the
  // live silence warning all land in the mic's notice pill — never `addError`.
  describe('voice messages are notices, never session errors', () => {
    function liveSession(): void {
      useSessionStore.setState((state) => ({
        sessions: {
          ...state.sessions,
          [FC_ROUTE]: { ...state.sessions[FC_ROUTE], sdkActive: true }
        }
      }))
      mirrorStoreIntoReplica()
    }
    const notice = (): ReturnType<typeof voiceNoticeFor> =>
      voiceNoticeFor(useVoiceNoticeStore.getState().notices, FC_ROUTE)
    const errors = (): string[] => useSessionStore.getState().sessions[FC_ROUTE].errors

    beforeEach(() => resetVoiceNoticesForTests())

    it('a refused start is a warn notice (and still logged), not a session error', async () => {
      liveSession()
      app.bridge.ipcMain.handle('voice:start-recording', () => ({
        ok: false,
        error: 'Microphone access denied — allow it for this site'
      }))
      renderFC()

      await act(async () => {
        await viewProps.onVoiceStart()
      })

      expect(notice()).toMatchObject({
        text: 'Microphone access denied — allow it for this site',
        tone: 'warn'
      })
      expect(viewProps.voiceNotice).toMatchObject({ text: notice()!.text })
      expect(errors()).toEqual([])
    })

    it('a failed stop is a warn notice too', async () => {
      app.bridge.ipcMain.handle('voice:stop-recording', () => ({
        ok: false,
        error: 'stop went wrong'
      }))
      renderFC()

      await act(async () => {
        await viewProps.onVoiceStop()
      })

      expect(notice()).toMatchObject({ text: 'stop went wrong', tone: 'warn' })
      expect(errors()).toEqual([])
    })

    it('a microphone fault is a warn notice for the active session', async () => {
      renderFC()
      expect(voiceFaults.size).toBe(1)

      act(() => {
        for (const listener of voiceFaults) listener('Microphone disconnected — kept what you said')
      })

      expect(notice()).toMatchObject({
        text: 'Microphone disconnected — kept what you said',
        tone: 'warn'
      })
      expect(errors()).toEqual([])
    })

    it('the live silence warning names the track, and is taken down when sound returns', () => {
      renderFC()
      expect(voiceSilences.size).toBe(1)

      act(() => {
        for (const listener of voiceSilences)
          listener({ silent: true, trackLabel: 'MacBook Pro Microphone' })
      })
      expect(notice()).toMatchObject({
        text: 'No signal from MacBook Pro Microphone — lid closed or muted?',
        tone: 'warn'
      })

      act(() => {
        for (const listener of voiceSilences) listener({ silent: false, trackLabel: null })
      })
      expect(notice()).toBeNull()
      expect(errors()).toEqual([])
    })

    it('a rekey mid-silence: the warning is still taken down when sound returns', () => {
      // A first press spawns cli.js, which rekeys the brand-new session while
      // the microphone is open; InputBox resubscribes under the new id.
      renderFC()
      act(() => {
        for (const listener of voiceSilences) listener({ silent: true, trackLabel: null })
      })
      expect(notice()).not.toBeNull()

      act(() => seed.rekey(FC_ROUTE, 'sdk-voice-1'))
      expect(useSessionStore.getState().activeSessionId).toBe('sdk-voice-1')
      expect(voiceSilences.size).toBe(1)
      expect(voiceNoticeFor(useVoiceNoticeStore.getState().notices, 'sdk-voice-1')).toMatchObject({
        text: expect.stringMatching(/^No signal from/)
      })

      act(() => {
        for (const listener of voiceSilences) listener({ silent: false, trackLabel: null })
      })
      expect(voiceNoticeFor(useVoiceNoticeStore.getState().notices, 'sdk-voice-1')).toBeNull()
    })

    it('a mid-press microphone switch is a grey (info) notice', () => {
      renderFC()
      expect(voiceSwitches.size).toBe(1)
      act(() => {
        for (const listener of voiceSwitches) listener('AirPods Pro')
      })
      expect(notice()).toMatchObject({ text: 'Switched to AirPods Pro', tone: 'info' })
      expect(errors()).toEqual([])
    })

    it('a cleared silence warning never removes a NEWER notice that replaced it', () => {
      renderFC()
      act(() => {
        for (const listener of voiceSilences) listener({ silent: true, trackLabel: null })
      })
      act(() => {
        for (const listener of voiceFaults) listener('The microphone was muted by the system')
      })
      act(() => {
        for (const listener of voiceSilences) listener({ silent: false, trackLabel: null })
      })
      expect(notice()).toMatchObject({ text: 'The microphone was muted by the system' })
    })

    it('the push-to-talk is HELD from press to release — the pill stays while it is', async () => {
      liveSession()
      renderFC()
      expect(viewProps.voiceHeld).toBe(false)

      await act(async () => {
        await viewProps.onVoiceStart()
      })
      expect(viewProps.voiceHeld).toBe(true)

      await act(async () => {
        await viewProps.onVoiceStop()
      })
      expect(viewProps.voiceHeld).toBe(false)
    })
  })

  // ADR-101 §6: a start without the speech model ends with a notice that carries
  // an action. The pill offers the download, follows it through the pack store,
  // and a refused or broken COMMAND (not a failed install) replaces it.
  describe('the speech model offer', () => {
    const OFFER_TEXT = 'Voice input for this engine needs the on-device speech model (~700 MB)'
    const packStatus = (
      state: VoicePackState,
      over: Partial<VoicePackStatus> = {}
    ): VoicePackStatus => ({
      state,
      packId: 'parakeet-tdt-0.6b-v2-int8',
      label: 'Parakeet TDT 0.6B v2 (English)',
      approxBytes: 700_000_000,
      ...over
    })
    const notice = (): ReturnType<typeof voiceNoticeFor> =>
      voiceNoticeFor(useVoiceNoticeStore.getState().notices, FC_ROUTE)

    /** What `voice:pack-status` answers: the host's truth, which the post-install re-read asks for. */
    let hostStatus: VoicePackStatus
    /** The install call, held open until the test lets it end. */
    let finishInstall: (value: unknown) => void
    let failInstall: (error: Error) => void

    beforeEach(() => {
      viewLog.length = 0
      resetVoiceNoticesForTests()
      resetVoicePackStoreForTests()
      hostStatus = packStatus('missing')
      app.bridge.ipcMain.handle('voice:pack-status', (_e: unknown, ...args: unknown[]) => {
        ipcCalls['voice:pack-status'] = [...(ipcCalls['voice:pack-status'] ?? []), args]
        return hostStatus
      })
      app.bridge.ipcMain.handle(
        'voice:pack-install',
        (_e: unknown, ...args: unknown[]) =>
          new Promise((resolve, reject) => {
            ipcCalls['voice:pack-install'] = [...(ipcCalls['voice:pack-install'] ?? []), args]
            finishInstall = resolve
            failInstall = reject
          })
      )
      app.bridge.ipcMain.handle('voice:pack-install-cancel', (_e: unknown, ...args: unknown[]) => {
        ipcCalls['voice:pack-install-cancel'] = [
          ...(ipcCalls['voice:pack-install-cancel'] ?? []),
          args
        ]
        return { status: 'cancelled' }
      })
    })

    function offer(): void {
      act(() => {
        showVoiceNotice(FC_ROUTE, OFFER_TEXT, 'warn', 'install-voice-pack')
      })
    }

    it('the pill gets a Download offer, and the pack status is read when it appears', async () => {
      renderFC()
      offer()
      expect(viewProps.voiceNotice).toMatchObject({
        text: OFFER_TEXT,
        tone: 'warn',
        button: 'download',
        phase: 'offer'
      })
      await vi.waitFor(() => expect(ipcCalls['voice:pack-status']).toHaveLength(1))
    })

    it('Download installs, then the pill follows the pack: progress, then ready', async () => {
      renderFC()
      offer()

      let pressed!: Promise<void>
      await act(async () => {
        pressed = viewProps.onVoiceNoticeAction!() as unknown as Promise<void>
      })
      expect(ipcCalls['voice:pack-install']).toHaveLength(1)
      // Before the host has said anything: already downloading, with a Cancel.
      expect(viewProps.voiceNotice).toMatchObject({
        text: 'Downloading speech model…',
        button: 'cancel',
        lingerMs: null
      })
      expect(notice()).toMatchObject({ following: true, action: 'install-voice-pack' })

      act(() => {
        applyVoicePackStatus(
          packStatus('installing', {
            progress: { receivedBytes: 294_000_000, totalBytes: 700_000_000 }
          })
        )
      })
      expect(viewProps.voiceNotice).toMatchObject({ text: 'Downloading speech model… 42%' })

      hostStatus = packStatus('ready')
      act(() => applyVoicePackStatus(hostStatus))
      await act(async () => {
        finishInstall({ status: 'installed' })
        await pressed
      })
      expect(viewProps.voiceNotice).toEqual({
        id: notice()!.id,
        text: 'Speech model ready — hold the mic to talk',
        tone: 'info',
        phase: 'ready'
      })
    })

    it('a failed install shows the host error in warn, in place', async () => {
      renderFC()
      offer()
      let pressed!: Promise<void>
      await act(async () => {
        pressed = viewProps.onVoiceNoticeAction!() as unknown as Promise<void>
      })
      hostStatus = packStatus('failed', { error: 'sha256 mismatch' })
      act(() => applyVoicePackStatus(hostStatus))
      await act(async () => {
        finishInstall({ status: 'failed', message: 'sha256 mismatch' })
        await pressed
      })
      expect(viewProps.voiceNotice).toMatchObject({ text: 'sha256 mismatch', tone: 'warn' })
      expect(viewProps.voiceNotice?.button).toBeUndefined()
    })

    it('Cancel goes to voice:pack-install-cancel', async () => {
      renderFC()
      offer()
      await act(async () => {
        void viewProps.onVoiceNoticeAction!()
      })
      await act(async () => {
        await viewProps.onVoiceNoticeCancel!()
      })
      expect(ipcCalls['voice:pack-install-cancel']).toHaveLength(1)
    })

    it('a refused Download never flashes an outcome (cancelled, an old failure) before the reason', async () => {
      // The stale status says `failed`: it must not be shown as this press's outcome.
      hostStatus = packStatus('failed', { error: 'an old failure' })
      act(() => applyVoicePackStatus(hostStatus))
      renderFC()
      offer()
      viewLog.length = 0
      let pressed!: Promise<void>
      await act(async () => {
        pressed = viewProps.onVoiceNoticeAction!() as unknown as Promise<void>
      })
      await act(async () => {
        failInstall(
          new Error('Permission denied: "voice:pack-install" requires the "admin" capability')
        )
        await pressed
      })
      const phases = viewLog.map((view) => view?.phase)
      expect(phases).not.toContain('cancelled')
      expect(phases).not.toContain('failed')
      expect(phases).not.toContain('ready')
      expect(viewLog.map((view) => view?.text)).not.toContain('an old failure')
      expect(viewProps.voiceNotice).toMatchObject({
        text: 'Installing the speech model needs admin access on this host',
        tone: 'warn'
      })
    })

    it('a refused Cancel reads the managing sentence', async () => {
      app.bridge.ipcMain.handle('voice:pack-install-cancel', () => {
        throw new Error(
          'Permission denied: "voice:pack-install-cancel" requires the "admin" capability'
        )
      })
      renderFC()
      offer()
      act(() => applyVoicePackStatus(packStatus('installing')))
      await act(async () => {
        await viewProps.onVoiceNoticeCancel!()
      })
      expect(notice()).toMatchObject({
        text: 'Managing the speech model needs admin access on this host',
        tone: 'warn'
      })
    })

    it('M1: a second press of the mic re-offers while the download runs — the pill still follows it to ready', async () => {
      renderFC()
      offer()
      await act(async () => {
        void viewProps.onVoiceNoticeAction!()
      })
      act(() => applyVoicePackStatus(packStatus('installing')))
      expect(notice()).toMatchObject({ following: true })

      // "Is it ready?" — main refuses again with a fresh action notice.
      offer()
      expect(notice()).toMatchObject({ following: true, action: 'install-voice-pack' })
      expect(viewProps.voiceNotice).toMatchObject({ phase: 'installing' })

      hostStatus = packStatus('ready')
      act(() => applyVoicePackStatus(hostStatus))
      expect(viewProps.voiceNotice).toMatchObject({
        text: 'Speech model ready — hold the mic to talk',
        phase: 'ready'
      })
      expect(viewProps.voiceNotice?.button).toBeUndefined()
    })

    it('M1: a repeat offer before the host has said anything keeps the pressed download in view', async () => {
      renderFC()
      offer()
      await act(async () => {
        void viewProps.onVoiceNoticeAction!()
      })
      // No `voice:pack-changed` yet: only this client's press is pending.
      offer()
      expect(notice()).toMatchObject({ following: true })
      expect(viewProps.voiceNotice).toMatchObject({
        text: 'Downloading speech model…',
        phase: 'installing'
      })
    })

    it('M1: an offer that only WATCHED another client’s install shows how it ended, not the offer again', async () => {
      renderFC()
      offer()
      expect(viewProps.voiceNotice).toMatchObject({ phase: 'offer' })

      act(() =>
        applyVoicePackStatus(
          packStatus('installing', { progress: { receivedBytes: 1, totalBytes: 2 } })
        )
      )
      expect(viewProps.voiceNotice).toMatchObject({ phase: 'installing', button: 'cancel' })
      // Seeing it run is what follows it.
      expect(notice()).toMatchObject({ following: true })

      act(() => applyVoicePackStatus(packStatus('failed', { error: 'sha256 mismatch' })))
      expect(viewProps.voiceNotice).toMatchObject({ text: 'sha256 mismatch', tone: 'warn' })
    })

    it('M1: an offer that arrives while another session’s download is already running follows it at once', () => {
      renderFC()
      act(() =>
        applyVoicePackStatus(
          packStatus('installing', { progress: { receivedBytes: 1, totalBytes: 2 } })
        )
      )
      offer()
      expect(notice()).toMatchObject({ following: true })
      act(() => applyVoicePackStatus(packStatus('ready')))
      expect(viewProps.voiceNotice).toMatchObject({ phase: 'ready' })
    })

    it('N7: once ready, a Remove in Settings during the linger does not turn it into “cancelled”', async () => {
      renderFC()
      offer()
      await act(async () => {
        void viewProps.onVoiceNoticeAction!()
      })
      hostStatus = packStatus('ready')
      act(() => applyVoicePackStatus(hostStatus))
      expect(viewProps.voiceNotice).toMatchObject({ phase: 'ready' })
      expect(notice()?.outcome).toMatchObject({ phase: 'ready' })

      hostStatus = packStatus('missing')
      act(() => applyVoicePackStatus(hostStatus))
      expect(viewProps.voiceNotice).toMatchObject({
        text: 'Speech model ready — hold the mic to talk',
        phase: 'ready'
      })
    })

    it('a dismissed notice that was following a download only hides the pill; the install carries on', async () => {
      renderFC()
      offer()
      await act(async () => {
        void viewProps.onVoiceNoticeAction!()
      })
      act(() => applyVoicePackStatus(packStatus('installing')))
      act(() => viewProps.onVoiceNoticeExpire!(viewProps.voiceNotice!.id))
      expect(viewProps.voiceNotice).toBeNull()
      expect(ipcCalls['voice:pack-install-cancel']).toBeUndefined()
      expect(useVoicePackStore.getState().status?.state).toBe('installing')
    })

    it('a remote client without admin: the pill becomes the plain admin sentence (warn, no button)', async () => {
      renderFC()
      offer()
      let pressed!: Promise<void>
      await act(async () => {
        pressed = viewProps.onVoiceNoticeAction!() as unknown as Promise<void>
      })
      await act(async () => {
        failInstall(
          new Error('Permission denied: "voice:pack-install" requires the "admin" capability')
        )
        await pressed
      })
      expect(notice()).toMatchObject({
        text: 'Installing the speech model needs admin access on this host',
        tone: 'warn'
      })
      expect(notice()).not.toHaveProperty('action')
      expect(viewProps.voiceNotice?.button).toBeUndefined()
    })

    it('an invoke timeout is an install still running on the host, not a failure', async () => {
      hostStatus = packStatus('installing', { progress: { receivedBytes: 10, totalBytes: 100 } })
      renderFC()
      offer()
      let pressed!: Promise<void>
      await act(async () => {
        pressed = viewProps.onVoiceNoticeAction!() as unknown as Promise<void>
      })
      await act(async () => {
        failInstall(new Error('Timeout: voice:pack-install'))
        await pressed
      })
      // Still the same followed notice, still downloading, nothing replaced it.
      expect(notice()).toMatchObject({ following: true, action: 'install-voice-pack' })
      expect(viewProps.voiceNotice).toMatchObject({
        text: 'Downloading speech model… 10%',
        button: 'cancel'
      })
    })

    it('a fresh press drops an offer nobody took up; a download in progress stays', async () => {
      useSessionStore.setState((state) => ({
        sessions: {
          ...state.sessions,
          [FC_ROUTE]: { ...state.sessions[FC_ROUTE], sdkActive: true }
        }
      }))
      mirrorStoreIntoReplica()
      renderFC()

      offer()
      await act(async () => {
        await viewProps.onVoiceStart()
      })
      expect(notice()).toBeNull()

      offer()
      await act(async () => {
        void viewProps.onVoiceNoticeAction!()
      })
      expect(notice()).toMatchObject({ following: true })
      await act(async () => {
        await viewProps.onVoiceStart()
      })
      expect(notice()).toMatchObject({ following: true, action: 'install-voice-pack' })
    })

    it('a plain notice that merely says the same thing gets no button (nothing keys on wording)', () => {
      renderFC()
      act(() => {
        showVoiceNotice(FC_ROUTE, OFFER_TEXT, 'warn')
      })
      expect(viewProps.voiceNotice).toEqual({ id: notice()!.id, text: OFFER_TEXT, tone: 'warn' })
    })
  })

  it('onVoiceStop: sends voice:stop-recording with the active session id', async () => {
    renderFC()

    await viewProps.onVoiceStop()

    expect(ipcCalls['voice:stop-recording']).toHaveLength(1)
    expect(ipcCalls['voice:stop-recording'][0][0]).toBe(FC_ROUTE)
  })

  // Voice needs the user's setting AND the session's capability. The capability
  // is false on engines without voice and on a Claude Code binary that lacks the
  // voice-server patch (ClaudeSession.capabilities), and every way into a
  // capture must honour it, not just the button.
  describe('voice gate', () => {
    function setVoice(setting: boolean, capability: boolean): void {
      useSessionStore.setState((state) => ({
        settings: { ...state.settings, voiceEnabled: setting },
        sessions: {
          ...state.sessions,
          [FC_ROUTE]: {
            ...state.sessions[FC_ROUTE],
            // Live session: the Tab path must not have to spawn one first.
            sdkActive: true,
            status: {
              ...state.sessions[FC_ROUTE].status,
              capabilities: { ...state.sessions[FC_ROUTE].status.capabilities, voice: capability }
            }
          }
        }
      }))
      mirrorStoreIntoReplica()
    }

    function pressTab(): void {
      viewProps.onKeyDown({
        key: 'Tab',
        shiftKey: false,
        ctrlKey: false,
        altKey: false,
        metaKey: false,
        preventDefault: vi.fn()
      } as unknown as Parameters<InputBoxViewProps['onKeyDown']>[0])
    }

    it.each([
      [true, true, true],
      [true, false, false],
      [false, true, false]
    ])('setting=%s capability=%s → mic shown=%s', (setting, capability, shown) => {
      setVoice(setting, capability)
      renderFC()
      expect(viewProps.voiceEnabled).toBe(shown)
    })

    it('Tab starts a capture when the session can take voice', async () => {
      setVoice(true, true)
      renderFC()
      await act(async () => pressTab())
      await vi.waitFor(() => expect(ipcCalls['voice:start-recording']).toHaveLength(1))
    })

    it('Tab starts nothing on a session that cannot, even with the setting on', async () => {
      setVoice(true, false)
      renderFC()
      await act(async () => pressTab())
      // Let any fire-and-forget start settle before asserting its absence.
      await act(async () => new Promise((resolve) => setTimeout(resolve, 20)))
      expect(ipcCalls['voice:start-recording']).toBeUndefined()
    })
  })

  /**
   * Push-to-talk released while `ensureSession()` is still spawning the engine.
   * The stop goes out first; a start sent after it would open a capture nobody
   * is holding. `session:create` is held open so the release lands inside it.
   */
  function holdSessionCreate(): () => void {
    let release!: () => void
    const created = new Promise<null>((resolve) => {
      release = () => resolve(null)
    })
    app.bridge.ipcMain.handle('session:create', () => created)
    return release
  }

  const tabEvent = (repeat = false): React.KeyboardEvent =>
    ({ key: 'Tab', repeat, preventDefault: () => {} }) as unknown as React.KeyboardEvent

  it('onVoiceStart: a release during the session spawn never sends the start', async () => {
    const releaseCreate = holdSessionCreate()
    renderFC()

    const startP = viewProps.onVoiceStart() as unknown as Promise<void>
    await viewProps.onVoiceStop()
    releaseCreate()
    await startP

    expect(ipcCalls['voice:stop-recording']).toHaveLength(1)
    expect(ipcCalls['voice:start-recording']).toBeUndefined()
  })

  it('release then re-press during ONE session spawn starts voice exactly once', async () => {
    const releaseCreate = holdSessionCreate()
    renderFC()

    const start1 = viewProps.onVoiceStart() as unknown as Promise<void>
    await viewProps.onVoiceStop()
    const start2 = viewProps.onVoiceStart() as unknown as Promise<void>
    releaseCreate()
    await Promise.all([start1, start2])

    expect(ipcCalls['voice:start-recording']).toHaveLength(1)
  })

  it('Tab released during the session spawn still stops, and never starts', async () => {
    useSessionStore.setState((state) => ({ settings: { ...state.settings, voiceEnabled: true } }))
    const releaseCreate = holdSessionCreate()
    renderFC()

    viewProps.onKeyDown(tabEvent())
    viewProps.onKeyUp(tabEvent())
    releaseCreate()
    await vi.waitFor(() => expect(ipcCalls['voice:stop-recording'] ?? []).toHaveLength(1))
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(ipcCalls['voice:start-recording']).toBeUndefined()
  })

  it('a held Tab auto-repeat does not start voice again', async () => {
    useSessionStore.setState((state) => ({ settings: { ...state.settings, voiceEnabled: true } }))
    renderFC()

    viewProps.onKeyDown(tabEvent())
    viewProps.onKeyDown(tabEvent(true))
    viewProps.onKeyDown(tabEvent(true))
    await vi.waitFor(() => expect(ipcCalls['voice:start-recording']).toHaveLength(1))
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(ipcCalls['voice:start-recording']).toHaveLength(1)
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
    mirrorStoreIntoReplica()

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
    mirrorStoreIntoReplica()

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
    mirrorStoreIntoReplica()

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
    mirrorStoreIntoReplica()

    renderFC()

    expect(viewProps.effort).toBe('medium')
    expect(viewProps.thinkingMode).toBe('disabled')
  })

  // ── Effort is remembered per model, and the pill tells the truth ────────
  //
  // The pill and every spawn read ONE resolver (`resolveSpawnEffort`):
  // explicit pick > the model's saved starting effort > cli.js's heuristic.

  const opusRow = (): ModelInfo => ({
    value: 'opus',
    resolvedModel: 'claude-opus-5-5', // cli.js defaults Opus 5.5 to 'medium'
    displayName: 'Opus 5.5',
    description: '',
    engineId: 'claude',
    supportsEffort: true,
    supportedEffortLevels: ['low', 'medium', 'high', 'xhigh', 'max'],
    supportsAdaptiveThinking: true
  })

  function opusSession(
    effort: string | null,
    modelEffortDefaults: Record<string, EffortLevel>
  ): void {
    fcClaudeModels = [opusRow()]
    useSessionStore.setState((state) => ({
      settings: { ...state.settings, modelEffortDefaults },
      availableModels: fcClaudeModels,
      sessions: {
        ...state.sessions,
        [FC_ROUTE]: { ...state.sessions[FC_ROUTE], selectedModel: 'opus', effort }
      }
    }))
    mirrorStoreIntoReplica()
  }

  it("the pill shows the model's saved starting effort when the session has no pick", async () => {
    opusSession(null, { opus: 'high' })
    renderFC()
    await act(async () => {})
    expect(viewProps.effort).toBe('high') // not Opus 5.5's built-in 'medium'
  })

  it('a session pick still outranks the saved starting effort in the pill', async () => {
    opusSession('low', { opus: 'high' })
    renderFC()
    await act(async () => {})
    expect(viewProps.effort).toBe('low')
  })

  it('the pill and the first spawn agree on the saved starting effort', async () => {
    opusSession(null, { opus: 'high' })
    renderFC()
    await act(async () => {})
    const shown = viewProps.effort
    await sendDraft()
    expect(ipcCalls['session:create'][0][2]).toBe(shown)
    // The starting effort freezes into the session, equal to what was sent.
    expect(ipcCalls['session:create'][0][10]).toEqual({ effort: shown, thinkingMode: null })
  })

  it('a started session keeps displaying what it runs when the per-model effort changes', async () => {
    opusSession(null, { opus: 'high' })
    renderFC()
    await act(async () => {})
    await sendDraft()
    const announce = ipcCalls['session:create'][0][10] as { effort: string | null }
    expect(announce.effort).toBe('high')

    // Core's birth event hands the announced effort to every replica.
    await act(async () => {
      emitSync('session:created', [FC_ROUTE, { cwd: '/test/cwd', effort: announce.effort }])
    })
    expect(useSessionStore.getState().sessions[FC_ROUTE].effort).toBe('high')

    // Another session's pick rewrites the per-model value.
    await act(async () => {
      useSessionStore.getState().updateSettings({ modelEffortDefaults: { opus: 'max' } })
    })
    // Pre-fix the session stayed `null` and this read the NEW map: 'max'.
    expect(viewProps.effort).toBe('high')
  })

  it('announces exactly the effort sent positionally on a respawn after a pick too', async () => {
    opusSession(null, { opus: 'high' })
    useSessionStore.getState().markSdkActive(FC_ROUTE)
    renderFC()
    await act(async () => {})
    await act(async () => {
      await viewProps.onSelectEffort('low')
    })
    const args = ipcCalls['session:create'][0]
    expect(args[2]).toBe('low')
    expect((args[10] as { effort: string }).effort).toBe(args[2])
  })

  describe('pi remembers effort in its own map', () => {
    // pi's `anthropic/claude-opus-5-5` canonicalises onto the key Claude's `opus`
    // row owns; the two maps must stay apart.
    const piRow = (): ModelInfo => ({
      ...opusRow(),
      value: 'anthropic/claude-opus-5-5',
      resolvedModel: undefined,
      engineId: 'pi',
      supportedEffortLevels: ['low', 'medium', 'high']
    })

    function piSession(settings: Record<string, unknown>, effort: string | null = null): void {
      fcClaudeModels = [opusRow()]
      app.bridge.ipcMain.handle('session:get-engine-models', () => [
        {
          engineId: 'claude',
          vendorId: 'anthropic',
          vendorName: 'Anthropic',
          models: fcClaudeModels
        },
        { engineId: 'pi', vendorId: 'pi', vendorName: 'pi', models: [piRow()] }
      ])
      useSessionStore.setState((state) => ({
        settings: { ...state.settings, ...settings },
        availableModels: [opusRow(), piRow()],
        sessions: {
          ...state.sessions,
          [FC_ROUTE]: {
            ...state.sessions[FC_ROUTE],
            selectedEngineId: 'pi',
            selectedModel: piRow().value,
            effort
          }
        }
      }))
      mirrorStoreIntoReplica()
    }

    it('a pi pick writes engineEffortDefaults.pi[<value>] and leaves modelEffortDefaults alone', async () => {
      piSession({ modelEffortDefaults: { opus: 'low' } })
      renderFC()
      await act(async () => {})
      await act(async () => {
        await viewProps.onSelectEffort('high')
      })
      const settings = useSessionStore.getState().settings
      expect(settings.modelEffortDefaults).toEqual({ opus: 'low' })
      expect(settings.engineEffortDefaults).toEqual({
        pi: { 'anthropic/claude-opus-5-5': 'high' }
      })
      // The session still carries its own pick.
      expect(useSessionStore.getState().sessions[FC_ROUTE].effort).toBe('high')
    })

    it('a new pi session on that model displays AND spawns the remembered effort', async () => {
      piSession({ engineEffortDefaults: { pi: { 'anthropic/claude-opus-5-5': 'low' } } })
      renderFC()
      await act(async () => {})
      expect(viewProps.effort).toBe('low')
      await sendDraft()
      expect(ipcCalls['session:create'][0][2]).toBe('low')
    })

    it('under configured-default a remembered pi effort is not applied: pill and spawn show the model default', async () => {
      piSession({
        newSessionModel: 'configured-default',
        engineEffortDefaults: { pi: { 'anthropic/claude-opus-5-5': 'low' } }
      })
      renderFC()
      await act(async () => {})
      expect(viewProps.effort).toBe('medium')
      await sendDraft()
      expect(ipcCalls['session:create'][0][2]).toBe('medium')
    })

    it('a remembered value the pi model does not offer is clamped, pill and spawn alike', async () => {
      piSession({ engineEffortDefaults: { pi: { 'anthropic/claude-opus-5-5': 'max' } } })
      renderFC()
      await act(async () => {})
      const shown = viewProps.effort
      expect(['low', 'medium', 'high']).toContain(shown)
      await sendDraft()
      expect(ipcCalls['session:create'][0][2]).toBe(shown)
    })

    it('a pi pick on a model not in the catalog writes nothing', async () => {
      piSession({})
      useSessionStore.setState((state) => ({
        sessions: {
          ...state.sessions,
          [FC_ROUTE]: { ...state.sessions[FC_ROUTE], selectedModel: 'ghost/model' }
        }
      }))
      mirrorStoreIntoReplica()
      renderFC()
      await act(async () => {})
      await act(async () => {
        await viewProps.onSelectEffort('high')
      })
      expect(useSessionStore.getState().settings.engineEffortDefaults).toEqual({})
      expect(useSessionStore.getState().settings.modelEffortDefaults).toEqual({})
    })
  })

  it('a model missing from the catalog: the pill shows exactly what spawn sends', async () => {
    // Pre-fix the pill resolved from the picker's synthetic "missing selection"
    // row (which keyed the saved 'low'), spawn from no model at all ('high').
    fcClaudeModels = [opusRow()]
    useSessionStore.setState((state) => ({
      settings: { ...state.settings, modelEffortDefaults: { 'claude-opus-4-7': 'low' } },
      availableModels: fcClaudeModels,
      sessions: {
        ...state.sessions,
        [FC_ROUTE]: { ...state.sessions[FC_ROUTE], selectedModel: 'claude-opus-4-7', effort: null }
      }
    }))
    mirrorStoreIntoReplica()
    renderFC()
    await act(async () => {})
    const shown = viewProps.effort
    await sendDraft()
    expect(ipcCalls['session:create'][0][2]).toBe(shown)
    // Unknown model: nothing is announced about effort.
    expect('effort' in (ipcCalls['session:create'][0][10] as object)).toBe(false)
  })

  it('an EMPTY catalog respawn keeps the session pick: no effort announced, still low after the fold (GUARD)', async () => {
    // The catalog is emptied on every cwd change until the fetch lands; pi has no
    // failure fallback. Announcing `null` there would wipe the pick on every
    // replica, this one included, and the next respawn would send the heuristic.
    fcClaudeModels = []
    useSessionStore.setState((state) => ({
      availableModels: [],
      sessions: {
        ...state.sessions,
        [FC_ROUTE]: { ...state.sessions[FC_ROUTE], selectedModel: 'opus', effort: 'low' }
      }
    }))
    mirrorStoreIntoReplica()
    useSessionStore.getState().markSdkActive(FC_ROUTE)
    renderFC()
    await act(async () => {})
    await act(async () => {
      await viewProps.onSelectThinking('disabled')
    })
    const args = ipcCalls['session:create'][0]
    expect(args[2]).toBe('low')
    const announce = args[10] as Record<string, unknown>
    expect('effort' in announce).toBe(false)
    expect(announce.thinkingMode).toBe('disabled')
    await act(async () => {
      emitSync('session:created', [FC_ROUTE, { cwd: '/test/cwd', ...announce }])
    })
    expect(useSessionStore.getState().sessions[FC_ROUTE].effort).toBe('low')
  })

  it('onSelectModel (spawned, thread id not reported yet): keeps the frozen effort, coerced', () => {
    opusSession('xhigh', {})
    fcClaudeModels = [
      opusRow(),
      {
        ...opusRow(),
        value: 'sonnet',
        resolvedModel: 'claude-sonnet-4-6',
        supportedEffortLevels: ['low', 'medium', 'high', 'max']
      }
    ]
    useSessionStore.setState({ availableModels: fcClaudeModels })
    useSessionStore.getState().markSdkActive(FC_ROUTE) // process running, no `sessionId` yet
    mirrorStoreIntoReplica()
    renderFC()

    viewProps.onSelectModel('sonnet')

    // Pre-fix `!started` alone cleared it though the process runs at 'xhigh'.
    expect(useSessionStore.getState().sessions[FC_ROUTE].effort).toBe('high')
  })

  it('announces no effort for a model that accepts none', async () => {
    fcClaudeModels = [
      {
        ...opusRow(),
        value: 'haiku',
        resolvedModel: 'claude-haiku-4-5',
        supportsEffort: false,
        supportedEffortLevels: []
      }
    ]
    useSessionStore.setState((state) => ({
      availableModels: fcClaudeModels,
      sessions: {
        ...state.sessions,
        [FC_ROUTE]: { ...state.sessions[FC_ROUTE], selectedModel: 'haiku', effort: 'high' }
      }
    }))
    mirrorStoreIntoReplica()
    renderFC()
    await act(async () => {})
    await sendDraft()
    expect((ipcCalls['session:create'][0][10] as { effort: unknown }).effort).toBeNull()
  })

  it.each(['claude', 'pi'] as const)(
    'newSessionModel "configured-default": a %s effort pick writes neither map, the session still gets it',
    async (engine) => {
      const piModel = {
        ...opusRow(),
        value: 'anthropic/claude-opus-5-5',
        resolvedModel: undefined,
        engineId: 'pi' as const
      }
      fcClaudeModels = [opusRow()]
      app.bridge.ipcMain.handle('session:get-engine-models', () => [
        { engineId: 'claude', vendorId: 'a', vendorName: 'A', models: fcClaudeModels },
        { engineId: 'pi', vendorId: 'p', vendorName: 'P', models: [piModel] }
      ])
      useSessionStore.setState((state) => ({
        settings: {
          ...state.settings,
          newSessionModel: 'configured-default',
          modelEffortDefaults: { opus: 'low' },
          engineEffortDefaults: {}
        },
        availableModels: [opusRow(), piModel],
        sessions: {
          ...state.sessions,
          [FC_ROUTE]: {
            ...state.sessions[FC_ROUTE],
            selectedEngineId: engine,
            selectedModel: engine === 'pi' ? piModel.value : 'opus',
            effort: null
          }
        }
      }))
      mirrorStoreIntoReplica()
      renderFC()
      await act(async () => {})
      await act(async () => {
        await viewProps.onSelectEffort('xhigh')
      })
      const settings = useSessionStore.getState().settings
      expect(settings.modelEffortDefaults).toEqual({ opus: 'low' })
      expect(settings.engineEffortDefaults).toEqual({})
      expect(useSessionStore.getState().sessions[FC_ROUTE].effort).toBe('xhigh')
    }
  )

  it("picking an effort remembers it as the model's starting effort and keeps the session pick", async () => {
    opusSession(null, {})
    renderFC()
    await act(async () => {})
    await act(async () => {
      await viewProps.onSelectEffort('xhigh')
    })
    expect(useSessionStore.getState().settings.modelEffortDefaults).toEqual({ opus: 'xhigh' })
    expect(useSessionStore.getState().sessions[FC_ROUTE].effort).toBe('xhigh')
  })

  it('picking moves a v3.5 legacy-keyed value to the new key instead of leaving both', async () => {
    fcClaudeModels = [opusRow()]
    useSessionStore.setState((state) => ({
      settings: { ...state.settings, modelEffortDefaults: { 'claude-opus-5-5': 'low' } },
      availableModels: fcClaudeModels,
      sessions: {
        ...state.sessions,
        [FC_ROUTE]: { ...state.sessions[FC_ROUTE], selectedModel: 'opus' }
      }
    }))
    mirrorStoreIntoReplica()
    renderFC()
    await act(async () => {})
    await act(async () => {
      await viewProps.onSelectEffort('max')
    })
    expect(useSessionStore.getState().settings.modelEffortDefaults).toEqual({ opus: 'max' })
  })

  it('a respawn after an effort pick announces the pick to createSession', async () => {
    opusSession(null, {})
    useSessionStore.getState().markSdkActive(FC_ROUTE)
    renderFC()
    await act(async () => {})
    await act(async () => {
      await viewProps.onSelectEffort('xhigh')
    })
    expect(ipcCalls['session:create']).toHaveLength(1)
    const args = ipcCalls['session:create'][0]
    expect(args[2]).toBe('xhigh')
    expect(args[10]).toEqual({ effort: 'xhigh', thinkingMode: null })
  })

  it('a thinking-mode pick is announced raw on the respawn too', async () => {
    opusSession(null, {})
    useSessionStore.getState().markSdkActive(FC_ROUTE)
    renderFC()
    await act(async () => {})
    await act(async () => {
      await viewProps.onSelectThinking('disabled')
    })
    // Effort is the resolved starting effort (Opus 5.5's built-in 'medium').
    expect(ipcCalls['session:create'][0][10]).toEqual({
      effort: 'medium',
      thinkingMode: 'disabled'
    })
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
    mirrorStoreIntoReplica()

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
    mirrorStoreIntoReplica()

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
    mirrorStoreIntoReplica()

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
    mirrorStoreIntoReplica()

    renderFC()

    viewProps.onSelectModel('haiku')

    const session = useSessionStore.getState().sessions[FC_ROUTE]
    expect(session.selectedModel).toBe('haiku')
    expect(session.thinkingMode).toBe('enabled') // adaptive coerced (id fallback: haiku)
    expect(session.effort).toBeNull() // effort unsupported → explicit pick cleared
  })

  it('onSelectModel (started): a model with adaptive but no xhigh coerces xhigh → high', () => {
    useSessionStore.setState((state) => ({
      sessions: {
        ...state.sessions,
        [FC_ROUTE]: {
          ...state.sessions[FC_ROUTE],
          // Started: the live process keeps its effort across `setModel`, so the
          // pick is coerced, not cleared.
          status: { ...state.sessions[FC_ROUTE].status, sessionId: 'started' },
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
          resolvedModel: 'claude-sonnet-4-6',
          displayName: 'Sonnet',
          description: 'Sonnet 4.6',
          supportsEffort: true,
          supportedEffortLevels: ['low', 'medium', 'high', 'max'],
          supportsAdaptiveThinking: true
        }
      ]
    }))
    mirrorStoreIntoReplica()

    renderFC()

    viewProps.onSelectModel('sonnet')

    const session = useSessionStore.getState().sessions[FC_ROUTE]
    expect(session.thinkingMode).toBe('adaptive') // both support adaptive
    expect(session.effort).toBe('high') // xhigh coerced to model's default
  })

  it('onSelectModel (not started): clears the effort so the new model remembered starting effort applies', () => {
    opusSession('low', { opus: 'high', sonnet: 'max' })
    fcClaudeModels = [
      opusRow(),
      { ...opusRow(), value: 'sonnet', resolvedModel: 'claude-sonnet-5-5' }
    ]
    useSessionStore.setState({ availableModels: fcClaudeModels })
    mirrorStoreIntoReplica()
    renderFC()

    viewProps.onSelectModel('sonnet')

    // Pre-fix `low` was kept (it is valid on the new model) and shown for it.
    expect(useSessionStore.getState().sessions[FC_ROUTE].effort).toBeNull()
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
    mirrorStoreIntoReplica()
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
    mirrorStoreIntoReplica()
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

  // S1e — an engine's context window need not reach the model catalog: it can arrive
  // on a usage frame, and on a cold reopen from `session_meta` through the
  // history status line. So the line is the meter's second source.
  /** A session whose engine publishes no context window. */
  function setWindowlessCapabilities(): void {
    const state = useSessionStore.getState()
    const session = state.sessions[BT_ROUTE]
    useSessionStore.setState({
      sessions: {
        ...state.sessions,
        [BT_ROUTE]: {
          ...session,
          status: {
            ...session.status,
            capabilities: { ...session.status.capabilities, contextWindow: 0 }
          }
        }
      }
    })
    mirrorStoreIntoReplica()
  }

  it('a status line that knows the window shows the meter even when capabilities say 0', () => {
    setWindowlessCapabilities()
    const state = useSessionStore.getState()
    const session = state.sessions[BT_ROUTE]
    useSessionStore.setState({
      sessions: {
        ...state.sessions,
        [BT_ROUTE]: {
          ...session,
          statusLine: {
            totalCostUsd: 1.5,
            totalDurationMs: 0,
            totalApiDurationMs: 0,
            totalInputTokens: 10,
            totalOutputTokens: 2,
            cachedTokens: 0,
            totalTokens: 12,
            contextWindow: { used: 4000, size: 272_000 },
            usedPercentage: 1.47,
            remainingPercentage: 98.53
          }
        }
      }
    })
    mirrorStoreIntoReplica()
    renderFC()
    expect(viewProps.showContextMeter).toBe(true)
  })

  it('no status line and no catalog window leaves the meter off', () => {
    setWindowlessCapabilities()
    renderFC()
    expect(viewProps.showContextMeter).toBe(false)
  })

  // ADR-102 Arc 2: the content-first load defers the status line.
  function setBackgroundLoad(statusPending: boolean, statusLine: unknown): void {
    const state = useSessionStore.getState()
    const session = state.sessions[BT_ROUTE]
    useSessionStore.setState({
      sessions: {
        ...state.sessions,
        [BT_ROUTE]: {
          ...session,
          statusLine: statusLine as never,
          backgroundLoad: { fraction: 0, label: 'Loading usage', statusPending, statusBytes: 1 }
        }
      }
    })
    mirrorStoreIntoReplica()
  }

  it('tells the footer the status line is pending only while there is none and one is on its way', () => {
    setBackgroundLoad(true, null)
    renderFC()
    expect(viewProps.statusLinePending).toBe(true)
  })

  it('a status line the entry already holds stays on screen while the fresh one loads (R3)', () => {
    setBackgroundLoad(true, {
      totalCostUsd: 1,
      totalDurationMs: 0,
      totalApiDurationMs: 0,
      totalInputTokens: 0,
      totalOutputTokens: 0,
      cachedTokens: 0,
      totalTokens: 0,
      contextWindow: { used: 0, size: 0 },
      usedPercentage: null,
      remainingPercentage: null
    })
    renderFC()
    expect(viewProps.statusLinePending).toBe(false)
  })

  it('is not pending once the load says the status line has landed', () => {
    setBackgroundLoad(false, null)
    renderFC()
    expect(viewProps.statusLinePending).toBe(false)
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
    mirrorStoreIntoReplica()
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
    mirrorStoreIntoReplica()

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
    mirrorStoreIntoReplica()

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
    mirrorStoreIntoReplica()

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
    mirrorStoreIntoReplica()

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
    mirrorStoreIntoReplica()

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
    mirrorStoreIntoReplica()
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
    mirrorStoreIntoReplica()

    renderFC()

    expect(viewProps.adaptiveSupported).toBe(false)
    expect(viewProps.effortSupported).toBe(false)
    expect(viewProps.allowedEffortLevels).toEqual([])
    // Nothing to place the session's model against, so the pill names the raw
    // value rather than a substitute (R1b).
    expect(viewProps.selectedModel.displayName).toBe('openai-codex/gpt-5.6-luna')
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
    mirrorStoreIntoReplica()

    renderFC()

    expect(viewProps.adaptiveSupported).toBe(false)
    expect(viewProps.effortSupported).toBe(true)
    expect(viewProps.allowedEffortLevels).toEqual(['low', 'medium', 'high'])
  })

  const PI_CATALOG: ModelInfo[] = [
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

  it('welcome screen: the configured piDefaultModel wins over the first pi model', () => {
    useSessionStore.setState({
      activeSessionId: null,
      lastSelectedEngineId: 'pi',
      piDefaultModel: 'anthropic/claude-sonnet-5',
      availableModels: PI_CATALOG
    })
    mirrorStoreIntoReplica()

    renderFC()

    expect(viewProps.selectedModel.value).toBe('anthropic/claude-sonnet-5')
    expect(viewProps.selectedModel.displayName).toBe('Claude Sonnet 5 (configured default)')
  })

  it('an ACTIVE session with an unavailable model names neither default nor first (R1b)', () => {
    // The default belongs to a session yet to be created. This one already has
    // a model — substituting would name something it never ran.
    useSessionStore.setState((state) => ({
      sessions: {
        ...state.sessions,
        [PI_ROUTE]: {
          ...state.sessions[PI_ROUTE],
          selectedEngineId: 'pi',
          selectedModel: 'openai-codex/stale-model' // not in PI_CATALOG
        }
      },
      piDefaultModel: 'anthropic/claude-sonnet-5',
      availableModels: PI_CATALOG
    }))
    mirrorStoreIntoReplica()

    renderFC()

    expect(viewProps.selectedModel.displayName).toBe('openai-codex/stale-model')
    expect(viewProps.selectedModel.engineId).toBe('pi')
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
    mirrorStoreIntoReplica()

    renderFC()

    expect(viewProps.selectedModel.displayName).toBe('Default')
  })
})
