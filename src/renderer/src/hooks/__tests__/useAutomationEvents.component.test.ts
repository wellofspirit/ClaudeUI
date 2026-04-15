/**
 * Layer 2: Component tests for useAutomationEvents hook.
 *
 * Tests the business logic layer: event → store state transitions.
 * Uses TestIpcBridge as Electron transport shim — no React rendering.
 * These tests verify that IPC events from the main process correctly
 * update the Zustand automation store.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { TestIpcBridge } from '@test/bridges/test-ipc-bridge'
import { useAutomationStore } from '../../stores/automation-store'
import { useSessionStore } from '../../stores/session-store'
import type { Automation, AutomationRun, ChatMessage } from '../../../../shared/types'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let bridge: TestIpcBridge
let cleanups: Array<() => void>

/**
 * Returns a factory for registering ipcRenderer.on listeners, matching
 * the preload's onEvent() shape:  channel callback receives args spread
 * (not the IpcRendererEvent first argument).
 */
function onEvent<T extends (...args: never[]) => void>(channel: string): (cb: T) => () => void {
  return (cb: T) => {
    const handler = (_: unknown, ...args: unknown[]): void => (cb as Function)(...args)
    bridge.ipcRenderer.on(channel, handler)
    const cleanup = (): void => { bridge.ipcRenderer.removeListener(channel, handler) }
    cleanups.push(cleanup)
    return cleanup
  }
}

/** Wire the same event handlers as useAutomationEvents, but without React. */
function wireEventHandlers(): void {
  onEvent<(data: { automationId: string; run: AutomationRun }) => void>('automation:run-update')(
    ({ automationId, run }) => {
      const store = useAutomationStore.getState()
      store.updateRun(automationId, run)
      if (run.status === 'success' || run.status === 'error') {
        store.incrementBadge()
        if (automationId === store.selectedAutomationId) {
          store.clearStreamingText()
          store.setIsRunProcessing(false)
        }
      }
    }
  )

  onEvent<(data: { automationId: string; isProcessing: boolean }) => void>('automation:processing')(
    ({ automationId, isProcessing }) => {
      const store = useAutomationStore.getState()
      if (automationId === store.selectedAutomationId) {
        store.setIsRunProcessing(isProcessing)
        if (!isProcessing) store.clearStreamingText()
      }
    }
  )

  onEvent<(automations: Automation[]) => void>('automation:changed')((automations) => {
    useAutomationStore.getState().setAutomations(automations)
  })

  onEvent<(data: { automationId: string; message: ChatMessage }) => void>('automation:run-message')(
    ({ automationId, message }) => {
      const store = useAutomationStore.getState()
      store.appendRunMessage(automationId, message)
      if (automationId === store.selectedAutomationId && message.role === 'assistant') {
        store.clearStreamingText()
      }
    }
  )

  onEvent<(data: { automationId: string; type: string; text: string }) => void>('automation:stream-event')(
    ({ automationId, type, text }) => {
      const store = useAutomationStore.getState()
      if (automationId === store.selectedAutomationId && type === 'text') {
        store.appendStreamingText(text)
      }
    }
  )
}

// ---------------------------------------------------------------------------
// Test data factories
// ---------------------------------------------------------------------------

function makeAutomation(overrides: Partial<Automation> = {}): Automation {
  return {
    id: 'auto-1',
    name: 'Test Automation',
    prompt: 'Do something',
    cwd: '/test',
    schedule: { type: 'interval', intervalMs: 60000 },
    permissions: { allow: [], deny: [] },
    enabled: true,
    lastRunAt: null,
    lastRunStatus: null,
    createdAt: Date.now(),
    ...overrides,
  }
}

function makeRun(overrides: Partial<AutomationRun> = {}): AutomationRun {
  return {
    id: 'run-1',
    automationId: 'auto-1',
    startedAt: Date.now(),
    finishedAt: null,
    status: 'running',
    totalCostUsd: 0,
    ...overrides,
  }
}

function makeChatMessage(overrides: Partial<ChatMessage> = {}): ChatMessage {
  return {
    id: `msg-${Date.now()}`,
    role: 'assistant' as const,
    content: [{ type: 'text' as const, text: 'hello' }],
    timestamp: Date.now(),
    ...overrides,
    // Ensure timestamp is never undefined even if overrides has timestamp: undefined
  } as ChatMessage
}

// ---------------------------------------------------------------------------
// Setup / Teardown
// ---------------------------------------------------------------------------

beforeEach(() => {
  bridge = new TestIpcBridge()
  cleanups = []

  // Provide a minimal window.api stub. The automation store doesn't call
  // window.api internally, but the session store may on initialisation.
  ;(globalThis as any).window = globalThis.window || {}
  ;(globalThis as any).window.api = {
    listAutomations: () => Promise.resolve([]),
    saveSessionConfig: () => {},
    saveSlashCommands: () => {},
    logError: () => {},
    fetchAccountUsage: () => Promise.resolve(null),
    fetchBlockUsage: () => Promise.resolve(null),
    getPluginViews: () => Promise.resolve([]),
    // Event registration stubs — unused here because we wire bridge directly.
    onAutomationRunUpdate: () => () => {},
    onAutomationProcessing: () => () => {},
    onAutomationsChanged: () => () => {},
    onAutomationRunMessage: () => () => {},
    onAutomationStreamEvent: () => () => {},
  } as any

  // Reset session store (may be relied upon by other store internals)
  useSessionStore.setState({
    activeSessionId: null,
    sessions: {},
    directories: [],
    recentSessionIds: [],
    pinnedSessionIds: [],
    customTitles: {},
  })

  // Reset automation store to a clean state before each test
  useAutomationStore.setState({
    automations: [],
    selectedAutomationId: null,
    selectedRunId: null,
    runs: {},
    runMessages: null,
    streamingText: '',
    isRunProcessing: false,
    notificationBadge: 0,
  })

  wireEventHandlers()
})

afterEach(() => {
  cleanups.forEach((fn) => fn())
  bridge.reset()
})

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('useAutomationEvents component tests', () => {
  // -------------------------------------------------------------------------
  // automation:changed
  // -------------------------------------------------------------------------
  describe('automation:changed', () => {
    it('replaces automations list when event arrives', () => {
      const automations = [makeAutomation({ id: 'a1' }), makeAutomation({ id: 'a2' })]

      bridge.webContents.send('automation:changed', automations)

      expect(useAutomationStore.getState().automations).toHaveLength(2)
      expect(useAutomationStore.getState().automations[0].id).toBe('a1')
      expect(useAutomationStore.getState().automations[1].id).toBe('a2')
    })

    it('replaces an existing list with a new one on subsequent events', () => {
      bridge.webContents.send('automation:changed', [makeAutomation({ id: 'old' })])
      bridge.webContents.send('automation:changed', [makeAutomation({ id: 'new-1' }), makeAutomation({ id: 'new-2' })])

      const { automations } = useAutomationStore.getState()
      expect(automations).toHaveLength(2)
      expect(automations.find((a) => a.id === 'old')).toBeUndefined()
    })

    it('accepts an empty array, clearing automations', () => {
      useAutomationStore.setState({ automations: [makeAutomation()] })

      bridge.webContents.send('automation:changed', [])

      expect(useAutomationStore.getState().automations).toHaveLength(0)
    })
  })

  // -------------------------------------------------------------------------
  // automation:run-update
  // -------------------------------------------------------------------------
  describe('automation:run-update', () => {
    it('adds a new run when it does not exist yet', () => {
      const run = makeRun({ automationId: 'auto-1', status: 'running' })

      bridge.webContents.send('automation:run-update', { automationId: 'auto-1', run })

      expect(useAutomationStore.getState().runs['auto-1']).toHaveLength(1)
      expect(useAutomationStore.getState().runs['auto-1'][0].id).toBe('run-1')
    })

    it('updates an existing run in place', () => {
      const initial = makeRun({ status: 'running' })
      useAutomationStore.setState({ runs: { 'auto-1': [initial] } })

      const updated = makeRun({ status: 'success', finishedAt: Date.now() })
      bridge.webContents.send('automation:run-update', { automationId: 'auto-1', run: updated })

      const runs = useAutomationStore.getState().runs['auto-1']
      expect(runs).toHaveLength(1)
      expect(runs[0].status).toBe('success')
    })

    it('does NOT increment badge when run status is running', () => {
      const run = makeRun({ status: 'running' })

      bridge.webContents.send('automation:run-update', { automationId: 'auto-1', run })

      expect(useAutomationStore.getState().notificationBadge).toBe(0)
    })

    it('increments badge when run status is success', () => {
      const run = makeRun({ status: 'success', finishedAt: Date.now() })

      bridge.webContents.send('automation:run-update', { automationId: 'auto-1', run })

      expect(useAutomationStore.getState().notificationBadge).toBe(1)
    })

    it('increments badge when run status is error', () => {
      const run = makeRun({ status: 'error', finishedAt: Date.now(), error: 'failed' })

      bridge.webContents.send('automation:run-update', { automationId: 'auto-1', run })

      expect(useAutomationStore.getState().notificationBadge).toBe(1)
    })

    it('badge increments for completions regardless of selected automation', () => {
      useAutomationStore.setState({ selectedAutomationId: 'other-auto' })
      const run = makeRun({ automationId: 'auto-1', status: 'success' })

      bridge.webContents.send('automation:run-update', { automationId: 'auto-1', run })

      // Badge increments for all completions
      expect(useAutomationStore.getState().notificationBadge).toBe(1)
    })

    it('clears streaming text and sets isRunProcessing false when selected automation completes', () => {
      useAutomationStore.setState({
        selectedAutomationId: 'auto-1',
        streamingText: 'partial output...',
        isRunProcessing: true,
      })
      const run = makeRun({ status: 'success', finishedAt: Date.now() })

      bridge.webContents.send('automation:run-update', { automationId: 'auto-1', run })

      expect(useAutomationStore.getState().streamingText).toBe('')
      expect(useAutomationStore.getState().isRunProcessing).toBe(false)
    })

    it('does NOT clear streaming text when a different (non-selected) automation completes', () => {
      useAutomationStore.setState({
        selectedAutomationId: 'other-auto',
        streamingText: 'my output',
        isRunProcessing: true,
      })
      const run = makeRun({ automationId: 'auto-1', status: 'success' })

      bridge.webContents.send('automation:run-update', { automationId: 'auto-1', run })

      // Badge still increments
      expect(useAutomationStore.getState().notificationBadge).toBe(1)
      // But streaming state for the selected automation is untouched
      expect(useAutomationStore.getState().streamingText).toBe('my output')
      expect(useAutomationStore.getState().isRunProcessing).toBe(true)
    })

    it('does NOT clear streaming text when run status is still running', () => {
      useAutomationStore.setState({
        selectedAutomationId: 'auto-1',
        streamingText: 'in progress...',
        isRunProcessing: true,
      })
      const run = makeRun({ status: 'running' })

      bridge.webContents.send('automation:run-update', { automationId: 'auto-1', run })

      expect(useAutomationStore.getState().streamingText).toBe('in progress...')
      expect(useAutomationStore.getState().isRunProcessing).toBe(true)
    })
  })

  // -------------------------------------------------------------------------
  // automation:processing
  // -------------------------------------------------------------------------
  describe('automation:processing', () => {
    it('sets isRunProcessing true for the selected automation', () => {
      useAutomationStore.setState({ selectedAutomationId: 'auto-1' })

      bridge.webContents.send('automation:processing', { automationId: 'auto-1', isProcessing: true })

      expect(useAutomationStore.getState().isRunProcessing).toBe(true)
    })

    it('sets isRunProcessing false and clears streaming text when processing ends', () => {
      useAutomationStore.setState({
        selectedAutomationId: 'auto-1',
        streamingText: 'streaming...',
        isRunProcessing: true,
      })

      bridge.webContents.send('automation:processing', { automationId: 'auto-1', isProcessing: false })

      expect(useAutomationStore.getState().isRunProcessing).toBe(false)
      expect(useAutomationStore.getState().streamingText).toBe('')
    })

    it('ignores event when automationId does not match selectedAutomationId', () => {
      useAutomationStore.setState({
        selectedAutomationId: 'other-auto',
        isRunProcessing: false,
      })

      bridge.webContents.send('automation:processing', { automationId: 'auto-1', isProcessing: true })

      expect(useAutomationStore.getState().isRunProcessing).toBe(false)
    })

    it('does not clear streaming text when isProcessing is true', () => {
      useAutomationStore.setState({
        selectedAutomationId: 'auto-1',
        streamingText: 'still streaming',
      })

      bridge.webContents.send('automation:processing', { automationId: 'auto-1', isProcessing: true })

      expect(useAutomationStore.getState().streamingText).toBe('still streaming')
    })

    it('ignores event when no automation is selected', () => {
      useAutomationStore.setState({ selectedAutomationId: null, isRunProcessing: false })

      bridge.webContents.send('automation:processing', { automationId: 'auto-1', isProcessing: true })

      expect(useAutomationStore.getState().isRunProcessing).toBe(false)
    })
  })

  // -------------------------------------------------------------------------
  // automation:run-message
  // -------------------------------------------------------------------------
  describe('automation:run-message', () => {
    it('appends a message when automationId matches selected automation', () => {
      useAutomationStore.setState({ selectedAutomationId: 'auto-1', runMessages: [] })

      const message = makeChatMessage({ role: 'assistant', content: [{ type: 'text', text: 'Done!' }] })
      bridge.webContents.send('automation:run-message', { automationId: 'auto-1', message })

      expect(useAutomationStore.getState().runMessages).toHaveLength(1)
      expect(useAutomationStore.getState().runMessages![0].content[0]).toEqual({ type: 'text', text: 'Done!' })
    })

    it('does not append message for non-selected automation (store guard)', () => {
      useAutomationStore.setState({ selectedAutomationId: 'other-auto', runMessages: [] })

      const message = makeChatMessage()
      bridge.webContents.send('automation:run-message', { automationId: 'auto-1', message })

      // The store's appendRunMessage has an internal guard on selectedAutomationId
      expect(useAutomationStore.getState().runMessages).toHaveLength(0)
    })

    it('clears streaming text when an assistant message arrives for the selected automation', () => {
      useAutomationStore.setState({
        selectedAutomationId: 'auto-1',
        runMessages: [],
        streamingText: 'streamed so far',
      })

      const message = makeChatMessage({ role: 'assistant' })
      bridge.webContents.send('automation:run-message', { automationId: 'auto-1', message })

      expect(useAutomationStore.getState().streamingText).toBe('')
    })

    it('does NOT clear streaming text for user messages', () => {
      useAutomationStore.setState({
        selectedAutomationId: 'auto-1',
        runMessages: [],
        streamingText: 'streamed so far',
      })

      const message = makeChatMessage({ role: 'user', content: [{ type: 'text', text: 'prompt' }] })
      bridge.webContents.send('automation:run-message', { automationId: 'auto-1', message })

      expect(useAutomationStore.getState().streamingText).toBe('streamed so far')
    })

    it('does NOT clear streaming text when assistant message is for a non-selected automation', () => {
      useAutomationStore.setState({
        selectedAutomationId: 'other-auto',
        streamingText: 'my stream',
        runMessages: [],
      })

      const message = makeChatMessage({ role: 'assistant' })
      bridge.webContents.send('automation:run-message', { automationId: 'auto-1', message })

      expect(useAutomationStore.getState().streamingText).toBe('my stream')
    })

    it('upserts message by id (partial assistant messages share same id)', () => {
      useAutomationStore.setState({ selectedAutomationId: 'auto-1', runMessages: [] })

      const partial = makeChatMessage({ id: 'msg-shared', role: 'assistant', content: [{ type: 'text', text: 'Hello' }] })
      const complete = makeChatMessage({ id: 'msg-shared', role: 'assistant', content: [{ type: 'text', text: 'Hello world' }] })

      bridge.webContents.send('automation:run-message', { automationId: 'auto-1', message: partial })
      bridge.webContents.send('automation:run-message', { automationId: 'auto-1', message: complete })

      // Should upsert, not duplicate
      expect(useAutomationStore.getState().runMessages).toHaveLength(1)
    })
  })

  // -------------------------------------------------------------------------
  // automation:stream-event
  // -------------------------------------------------------------------------
  describe('automation:stream-event', () => {
    it('appends streaming text for the selected automation', () => {
      useAutomationStore.setState({ selectedAutomationId: 'auto-1', streamingText: '' })

      bridge.webContents.send('automation:stream-event', { automationId: 'auto-1', type: 'text', text: 'chunk1 ' })
      bridge.webContents.send('automation:stream-event', { automationId: 'auto-1', type: 'text', text: 'chunk2' })

      expect(useAutomationStore.getState().streamingText).toBe('chunk1 chunk2')
    })

    it('ignores stream events for non-selected automation', () => {
      useAutomationStore.setState({ selectedAutomationId: 'other-auto', streamingText: '' })

      bridge.webContents.send('automation:stream-event', { automationId: 'auto-1', type: 'text', text: 'ignored' })

      expect(useAutomationStore.getState().streamingText).toBe('')
    })

    it('ignores stream events with non-text type', () => {
      useAutomationStore.setState({ selectedAutomationId: 'auto-1', streamingText: '' })

      bridge.webContents.send('automation:stream-event', { automationId: 'auto-1', type: 'thinking', text: 'inner thought' })
      bridge.webContents.send('automation:stream-event', { automationId: 'auto-1', type: 'tool_use', text: 'tool data' })

      expect(useAutomationStore.getState().streamingText).toBe('')
    })

    it('ignores stream events when no automation is selected', () => {
      useAutomationStore.setState({ selectedAutomationId: null, streamingText: '' })

      bridge.webContents.send('automation:stream-event', { automationId: 'auto-1', type: 'text', text: 'lost' })

      expect(useAutomationStore.getState().streamingText).toBe('')
    })
  })

  // -------------------------------------------------------------------------
  // Badge accumulation across multiple runs
  // -------------------------------------------------------------------------
  describe('badge accumulation', () => {
    it('accumulates badge across multiple automation completions', () => {
      const run1 = makeRun({ id: 'run-1', automationId: 'auto-1', status: 'success' })
      const run2 = makeRun({ id: 'run-2', automationId: 'auto-2', status: 'error' })
      const run3 = makeRun({ id: 'run-3', automationId: 'auto-1', status: 'success' })

      bridge.webContents.send('automation:run-update', { automationId: 'auto-1', run: run1 })
      bridge.webContents.send('automation:run-update', { automationId: 'auto-2', run: run2 })
      bridge.webContents.send('automation:run-update', { automationId: 'auto-1', run: run3 })

      expect(useAutomationStore.getState().notificationBadge).toBe(3)
    })

    it('running status updates do not affect the badge', () => {
      const start = makeRun({ status: 'running' })
      const progress = makeRun({ status: 'running' })
      const done = makeRun({ status: 'success', finishedAt: Date.now() })

      bridge.webContents.send('automation:run-update', { automationId: 'auto-1', run: start })
      bridge.webContents.send('automation:run-update', { automationId: 'auto-1', run: progress })
      bridge.webContents.send('automation:run-update', { automationId: 'auto-1', run: done })

      expect(useAutomationStore.getState().notificationBadge).toBe(1)
    })
  })
})
