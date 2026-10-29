import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
vi.mock('electron', async () => import('@test/stubs/electron-shim'))

import { createElement } from 'react'
import { act, render, cleanup } from '@testing-library/react'
import { bootTestApp, type TestApp } from '@test/helpers/boot-test-app'
import { useClaudeEvents, PENDING_WAKE_GRACE_MS } from '../useClaudeEvents'
import { useSessionStore } from '../../stores/session-store'
import {
  makeChatMessage,
  makeAssistantMessage,
  makeToolUseBlock,
  makeSessionStatus,
  makeTodoItem,
  makeTaskNotification,
  resetFactoryCounter
} from '@test/factories/messages'
import type {
  TaskProgress,
  StatusLineData,
  GitStatusData,
  AccountUsage,
  BlockUsageData,
  PluginViewWithOwner,
  VoiceState,
  WorktreeInfo,
  FileDiff,
  EngineId
} from '../../../../shared/types'
import { seed, mirrorStoreIntoReplica } from '@test/helpers/replica-seed'
import {
  resetVoiceNoticesForTests,
  useVoiceNoticeStore,
  voiceNoticeFor
} from '../../lib/voice/voice-notice'
import {
  resetVoiceControllerForTests,
  voiceController,
  VOICE_OWNERSHIP_WINDOW_MS
} from '../../lib/voice/voice-controller'
import { resetVoicePackStoreForTests, useVoicePackStore } from '../../lib/voice/voice-pack-store'
import type { VoicePackState, VoicePackStatus } from '../../../../shared/voice-pack'

let app: TestApp

/**
 * Mounts the REAL hook (SyncCore phase 4c). The transient + host-local handlers
 * this file asserts on live nowhere else: the replicated channels are the reducer's
 * now, so what is left of `useClaudeEvents` is exactly the part a test has to mount
 * to exercise.
 */
function EventHarness(): null {
  useClaudeEvents()
  return null
}

// SyncCore phase 4c: the handler table this file used to carry — a copy of
// useClaudeEvents, itself a copy of the reducer — is DELETED. `app.emit` feeds the
// real SyncClient, whose raw-event tap folds `applyEvent` and projects the result
// into the store, so these tests assert on the ONE interpretation that ships.

beforeEach(async () => {
  // The real harness, not a bespoke bridge: `bootTestApp` builds the full
  // `window.api` the hook needs (`onAuthState`, `onVoiceState`, the usage fetches,
  // `getPluginViews`, …) and installs the sync transport + replica seam — which
  // also resets the replica, a module singleton whose canonical mirror would
  // otherwise carry the previous test's sessions into this one.
  app = await bootTestApp()
  resetFactoryCounter()
  // The hook's own `saveSlashCommands` / `confirmQuit` assertions need spies the
  // bridge-backed api does not provide.
  Object.assign(window.api, {
    saveSlashCommands: vi.fn(),
    confirmQuit: vi.fn(),
    ackQuitPrompt: vi.fn(() => Promise.resolve())
  })

  useSessionStore.setState({
    activeSessionId: null,
    sessions: {},
    directories: [],
    recentSessionIds: [],
    pinnedSessionIds: [],
    customTitles: {},
    worktreeInfoMap: {}
  })
  mirrorStoreIntoReplica()
  render(createElement(EventHarness))
})

afterEach(() => {
  cleanup()
  app.teardown()
})

describe('useClaudeEvents extended component tests', () => {
  describe('session:task-progress', () => {
    it('upserts task progress in taskProgressMap by toolUseId', () => {
      const routingId = 'route-1'
      useSessionStore.getState().createNewSession(routingId, '/test')

      const progress: TaskProgress = {
        toolUseId: 'tool-a',
        toolName: 'Task',
        parentToolUseId: null,
        elapsedTimeSeconds: 5
      }

      app.emit('session:task-progress', routingId, progress)

      const session = useSessionStore.getState().sessions[routingId]
      expect(session.taskProgressMap['tool-a']).toEqual(progress)
    })

    it('updates existing task progress entry on second event', () => {
      const routingId = 'route-1'
      useSessionStore.getState().createNewSession(routingId, '/test')

      app.emit('session:task-progress', routingId, {
        toolUseId: 'tool-a',
        toolName: 'Task',
        parentToolUseId: null,
        elapsedTimeSeconds: 3
      })
      app.emit('session:task-progress', routingId, {
        toolUseId: 'tool-a',
        toolName: 'Task',
        parentToolUseId: null,
        elapsedTimeSeconds: 10
      })

      const session = useSessionStore.getState().sessions[routingId]
      expect(session.taskProgressMap['tool-a'].elapsedTimeSeconds).toBe(10)
    })

    it('stores multiple tasks independently by toolUseId', () => {
      const routingId = 'route-1'
      useSessionStore.getState().createNewSession(routingId, '/test')

      app.emit('session:task-progress', routingId, {
        toolUseId: 'tool-a',
        toolName: 'Task',
        parentToolUseId: null,
        elapsedTimeSeconds: 1
      })
      app.emit('session:task-progress', routingId, {
        toolUseId: 'tool-b',
        toolName: 'Task',
        parentToolUseId: 'tool-a',
        elapsedTimeSeconds: 2
      })

      const session = useSessionStore.getState().sessions[routingId]
      expect(Object.keys(session.taskProgressMap)).toHaveLength(2)
      expect(session.taskProgressMap['tool-b'].parentToolUseId).toBe('tool-a')
    })
  })

  describe('session:task-notification', () => {
    it('appends task notification to session', () => {
      const routingId = 'route-1'
      useSessionStore.getState().createNewSession(routingId, '/test')

      const notification = makeTaskNotification({ toolUseId: null, status: 'completed' })
      app.emit('session:task-notification', routingId, notification)

      const session = useSessionStore.getState().sessions[routingId]
      expect(session.taskNotifications).toHaveLength(1)
      expect(session.taskNotifications[0].taskId).toBe(notification.taskId)
    })

    it('does not crash when toolUseId is null', () => {
      const routingId = 'route-1'
      useSessionStore.getState().createNewSession(routingId, '/test')

      app.emit('session:task-notification', routingId, makeTaskNotification({ toolUseId: null }))

      const session = useSessionStore.getState().sessions[routingId]
      expect(session.taskNotifications).toHaveLength(1)
    })
  })

  describe('session:subagent-message', () => {
    it('adds subagent message to the correct toolUseId slot', () => {
      const routingId = 'route-1'
      useSessionStore.getState().createNewSession(routingId, '/test')

      const message = makeAssistantMessage('subagent says hi')
      app.emit('session:subagent-message', routingId, {
        toolUseId: 'agent-1',
        message
      })

      const session = useSessionStore.getState().sessions[routingId]
      expect(session.subagentMessages['agent-1']).toHaveLength(1)
      expect(session.subagentMessages['agent-1'][0].content[0]).toEqual({
        type: 'text',
        text: 'subagent says hi'
      })
    })

    it('upserts subagent message with same ID', () => {
      const routingId = 'route-1'
      useSessionStore.getState().createNewSession(routingId, '/test')

      const msg1 = makeChatMessage({
        id: 'sub-msg-1',
        content: [{ type: 'text', text: 'partial' }]
      })
      const msg2 = makeChatMessage({
        id: 'sub-msg-1',
        content: [{ type: 'text', text: 'complete' }]
      })

      app.emit('session:subagent-message', routingId, {
        toolUseId: 'agent-1',
        message: msg1
      })
      app.emit('session:subagent-message', routingId, {
        toolUseId: 'agent-1',
        message: msg2
      })

      const session = useSessionStore.getState().sessions[routingId]
      expect(session.subagentMessages['agent-1']).toHaveLength(1)
    })

    it('keeps subagent messages isolated per toolUseId', () => {
      const routingId = 'route-1'
      useSessionStore.getState().createNewSession(routingId, '/test')

      app.emit('session:subagent-message', routingId, {
        toolUseId: 'agent-1',
        message: makeAssistantMessage('from agent 1')
      })
      app.emit('session:subagent-message', routingId, {
        toolUseId: 'agent-2',
        message: makeAssistantMessage('from agent 2')
      })

      const session = useSessionStore.getState().sessions[routingId]
      expect(session.subagentMessages['agent-1']).toHaveLength(1)
      expect(session.subagentMessages['agent-2']).toHaveLength(1)
    })
  })

  describe('session:subagent-message-batch', () => {
    it('appends batch of subagent messages', () => {
      const routingId = 'route-1'
      useSessionStore.getState().createNewSession(routingId, '/test')

      const messages = [
        makeAssistantMessage('batch msg 1'),
        makeAssistantMessage('batch msg 2'),
        makeAssistantMessage('batch msg 3')
      ]

      app.emit('session:subagent-message-batch', routingId, {
        toolUseId: 'agent-1',
        messages
      })

      const session = useSessionStore.getState().sessions[routingId]
      expect(session.subagentMessages['agent-1']).toHaveLength(3)
    })

    it('merges batch messages with existing messages by ID', () => {
      const routingId = 'route-1'
      useSessionStore.getState().createNewSession(routingId, '/test')

      const existing = makeChatMessage({ id: 'sub-1', content: [{ type: 'text', text: 'old' }] })
      app.emit('session:subagent-message', routingId, {
        toolUseId: 'agent-1',
        message: existing
      })

      const updated = makeChatMessage({ id: 'sub-1', content: [{ type: 'text', text: 'updated' }] })
      const fresh = makeAssistantMessage('new message')
      app.emit('session:subagent-message-batch', routingId, {
        toolUseId: 'agent-1',
        messages: [updated, fresh]
      })

      const session = useSessionStore.getState().sessions[routingId]
      expect(session.subagentMessages['agent-1']).toHaveLength(2)
    })
  })

  describe('session:subagent-tool-result', () => {
    it('appends subagent tool result to matching message', () => {
      const routingId = 'route-1'
      useSessionStore.getState().createNewSession(routingId, '/test')

      const toolMsg = makeChatMessage({
        id: 'sub-msg-1',
        content: [makeToolUseBlock('Bash', { command: 'ls' }, 'sub-tool-1')]
      })
      app.emit('session:subagent-message', routingId, {
        toolUseId: 'agent-1',
        message: toolMsg
      })

      app.emit('session:subagent-tool-result', routingId, {
        toolUseId: 'agent-1',
        toolResultToolUseId: 'sub-tool-1',
        result: 'file1.txt',
        isError: false
      })

      const session = useSessionStore.getState().sessions[routingId]
      const msgs = session.subagentMessages['agent-1']
      const resultBlock = msgs.flatMap((m) => m.content).find((b) => b.type === 'tool_result')
      expect(resultBlock).toBeDefined()
    })

    it('attaches fileDiffs (opencode apply_patch/edit) to the subagent tool_result block', () => {
      const routingId = 'route-1'
      useSessionStore.getState().createNewSession(routingId, '/test')

      const toolMsg = makeChatMessage({
        id: 'sub-msg-1',
        content: [
          makeToolUseBlock('apply_patch', { patchText: '*** Begin Patch ***' }, 'sub-tool-1')
        ]
      })
      app.emit('session:subagent-message', routingId, {
        toolUseId: 'agent-1',
        message: toolMsg
      })

      const fileDiffs: FileDiff[] = [
        {
          path: 'a.ts',
          patch: '@@ -1 +1 @@\n-old\n+new',
          additions: 1,
          deletions: 1,
          changeType: 'update'
        }
      ]
      app.emit('session:subagent-tool-result', routingId, {
        toolUseId: 'agent-1',
        toolResultToolUseId: 'sub-tool-1',
        result: 'Success. Updated the following files:\nM a.ts',
        isError: false,
        fileDiffs
      })

      const session = useSessionStore.getState().sessions[routingId]
      const msgs = session.subagentMessages['agent-1']
      const resultBlock = msgs.flatMap((m) => m.content).find((b) => b.type === 'tool_result')
      expect(resultBlock?.type === 'tool_result' && resultBlock.fileDiffs).toEqual(fileDiffs)
    })

    it('handles error tool results', () => {
      const routingId = 'route-1'
      useSessionStore.getState().createNewSession(routingId, '/test')

      app.emit('session:subagent-tool-result', routingId, {
        toolUseId: 'agent-1',
        toolResultToolUseId: 'nonexistent-tool',
        result: 'error output',
        isError: true
      })

      const session = useSessionStore.getState().sessions[routingId]
      expect(session).toBeDefined()
    })
  })

  describe('session:bash-output', () => {
    it('stores bash output with line and byte counts', () => {
      const routingId = 'route-1'
      useSessionStore.getState().createNewSession(routingId, '/test')

      app.emit('session:bash-output', routingId, {
        toolUseId: 'bash-tool-1',
        output: 'Hello\nWorld\n',
        totalLines: 2,
        totalBytes: 12
      })

      const session = useSessionStore.getState().sessions[routingId]
      expect(session.bashOutputs['bash-tool-1']).toEqual({
        output: 'Hello\nWorld\n',
        totalLines: 2,
        totalBytes: 12
      })
    })

    it('overwrites previous output for the same toolUseId', () => {
      const routingId = 'route-1'
      useSessionStore.getState().createNewSession(routingId, '/test')

      app.emit('session:bash-output', routingId, {
        toolUseId: 'bash-tool-1',
        output: 'old output',
        totalLines: 1,
        totalBytes: 10
      })
      app.emit('session:bash-output', routingId, {
        toolUseId: 'bash-tool-1',
        output: 'new output',
        totalLines: 1,
        totalBytes: 10
      })

      expect(useSessionStore.getState().sessions[routingId].bashOutputs['bash-tool-1'].output).toBe(
        'new output'
      )
    })

    it('stores outputs for different toolUseIds independently', () => {
      const routingId = 'route-1'
      useSessionStore.getState().createNewSession(routingId, '/test')

      app.emit('session:bash-output', routingId, {
        toolUseId: 'bash-1',
        output: 'output A',
        totalLines: 1,
        totalBytes: 8
      })
      app.emit('session:bash-output', routingId, {
        toolUseId: 'bash-2',
        output: 'output B',
        totalLines: 1,
        totalBytes: 8
      })

      const session = useSessionStore.getState().sessions[routingId]
      expect(session.bashOutputs['bash-1'].output).toBe('output A')
      expect(session.bashOutputs['bash-2'].output).toBe('output B')
    })
  })

  describe('session:background-output', () => {
    it('stores background output tail and total size', () => {
      const routingId = 'route-1'
      useSessionStore.getState().createNewSession(routingId, '/test')

      app.emit('session:background-output', routingId, {
        toolUseId: 'bg-tool-1',
        tail: 'last few lines',
        totalSize: 1024
      })

      const session = useSessionStore.getState().sessions[routingId]
      expect(session.backgroundOutputs['bg-tool-1']).toEqual({
        tail: 'last few lines',
        totalSize: 1024
      })
    })

    it('updates background output on subsequent events', () => {
      const routingId = 'route-1'
      useSessionStore.getState().createNewSession(routingId, '/test')

      app.emit('session:background-output', routingId, {
        toolUseId: 'bg-tool-1',
        tail: 'old tail',
        totalSize: 500
      })
      app.emit('session:background-output', routingId, {
        toolUseId: 'bg-tool-1',
        tail: 'new tail',
        totalSize: 1000
      })

      expect(
        useSessionStore.getState().sessions[routingId].backgroundOutputs['bg-tool-1'].tail
      ).toBe('new tail')
    })
  })

  describe('session:status-line', () => {
    it('sets the status line for a session', () => {
      const routingId = 'route-1'
      useSessionStore.getState().createNewSession(routingId, '/test')

      const statusLine: StatusLineData = {
        totalCostUsd: 0.05,
        totalDurationMs: 3000,
        totalApiDurationMs: 2500,
        totalInputTokens: 1000,
        totalOutputTokens: 500,
        cachedTokens: 200,
        totalTokens: 1500,
        contextWindow: { used: 1500, size: 200000 },
        usedPercentage: 0.75,
        remainingPercentage: 99.25
      }

      app.emit('session:status-line', routingId, statusLine)

      expect(useSessionStore.getState().sessions[routingId].statusLine).toEqual(statusLine)
    })

    it('replaces previous status line on update', () => {
      const routingId = 'route-1'
      useSessionStore.getState().createNewSession(routingId, '/test')

      const first: StatusLineData = {
        totalCostUsd: 0.01,
        totalDurationMs: 1000,
        totalApiDurationMs: 800,
        totalInputTokens: 100,
        totalOutputTokens: 50,
        cachedTokens: 0,
        totalTokens: 150,
        contextWindow: { used: 200, size: 200000 },
        usedPercentage: 0.1,
        remainingPercentage: 99.9
      }
      const second: StatusLineData = { ...first, totalCostUsd: 0.1, totalTokens: 5000 }

      app.emit('session:status-line', routingId, first)
      app.emit('session:status-line', routingId, second)

      expect(useSessionStore.getState().sessions[routingId].statusLine?.totalCostUsd).toBe(0.1)
    })
  })

  describe('session:slash-commands', () => {
    it('updates slashCommands in store', () => {
      const commands = [
        { name: 'review', description: 'Review code', content: 'Please review' },
        { name: 'test', description: 'Run tests', content: 'Run the tests' }
      ]

      app.emit('session:slash-commands', 'ignored', commands)

      expect(useSessionStore.getState().slashCommands).toEqual(commands)
    })

    it('calls window.api.saveSlashCommands with the received commands', () => {
      const commands = [{ name: 'deploy', description: 'Deploy', content: 'Deploy to prod' }]

      app.emit('session:slash-commands', 'ignored', commands)

      expect(window.api.saveSlashCommands as ReturnType<typeof vi.fn>).toHaveBeenCalledWith(
        commands
      )
    })

    it('replaces slash commands on subsequent event', () => {
      app.emit('session:slash-commands', 'ignored', [
        { name: 'old-cmd', description: 'old', content: 'old' }
      ])
      app.emit('session:slash-commands', 'ignored', [
        { name: 'new-cmd', description: 'new', content: 'new' }
      ])

      const { slashCommands } = useSessionStore.getState()
      expect(slashCommands).toHaveLength(1)
      expect(slashCommands[0].name).toBe('new-cmd')
    })
  })

  describe('session:skills', () => {
    it('updates sdkSkillNames in store', () => {
      app.emit('session:skills', 'ignored', ['bundle-analyzer', 'patch-readme'])

      expect(useSessionStore.getState().sdkSkillNames).toEqual(['bundle-analyzer', 'patch-readme'])
    })

    it('replaces previous skill names on update', () => {
      app.emit('session:skills', 'ignored', ['skill-a', 'skill-b'])
      app.emit('session:skills', 'ignored', ['skill-c'])

      expect(useSessionStore.getState().sdkSkillNames).toEqual(['skill-c'])
    })

    it('sets empty array when no skills provided', () => {
      app.emit('session:skills', 'ignored', ['skill-a'])
      app.emit('session:skills', 'ignored', [])

      expect(useSessionStore.getState().sdkSkillNames).toEqual([])
    })
  })

  describe('session:sandbox-violation', () => {
    it('adds sandbox violation message to session', () => {
      const routingId = 'route-1'
      useSessionStore.getState().createNewSession(routingId, '/test')

      app.emit('session:sandbox-violation', routingId, 'Network access denied to example.com')

      const session = useSessionStore.getState().sessions[routingId]
      expect(session.sandboxViolations).toContain('Network access denied to example.com')
    })

    it('accumulates multiple sandbox violations', () => {
      const routingId = 'route-1'
      useSessionStore.getState().createNewSession(routingId, '/test')

      app.emit('session:sandbox-violation', routingId, 'violation 1')
      app.emit('session:sandbox-violation', routingId, 'violation 2')

      expect(useSessionStore.getState().sessions[routingId].sandboxViolations).toHaveLength(2)
    })
  })

  // ADR-053 — the queue's consumed transition replaces session:steer-consumed.
  describe('session:queue-changed', () => {
    it('converts a consumed item to a user message and drops it from the card', () => {
      const routingId = 'route-1'
      useSessionStore.getState().createNewSession(routingId, '/test')
      app.emit('session:queue-changed', routingId, {
        items: [{ itemId: 'q1', text: 'steered command', state: 'queued' }]
      })

      app.emit('session:queue-changed', routingId, {
        items: [{ itemId: 'q1', text: 'steered command', state: 'consumed' }]
      })

      const session = useSessionStore.getState().sessions[routingId]
      expect(session.queuedItems).toEqual([])
      const lastMsg = session.messages[session.messages.length - 1]
      expect(lastMsg.id).toBe('steer-q1')
      expect(lastMsg.role).toBe('user')
      expect(lastMsg.content[0]).toEqual({ type: 'text', text: 'steered command' })
    })

    it('a recalled item leaves the card without entering the transcript', () => {
      const routingId = 'route-1'
      useSessionStore.getState().createNewSession(routingId, '/test')
      app.emit('session:queue-changed', routingId, {
        items: [{ itemId: 'q1', text: 'taken back', state: 'recalled' }]
      })

      const session = useSessionStore.getState().sessions[routingId]
      expect(session.messages).toHaveLength(0)
      expect(session.queuedItems).toEqual([])
    })

    it('does nothing for unknown session', () => {
      app.emit('session:queue-changed', 'nonexistent', {
        items: [{ itemId: 'q1', text: 'x', state: 'queued' }]
      })

      expect(useSessionStore.getState().sessions['nonexistent']).toBeUndefined()
    })
  })

  describe('session:watch-update', () => {
    it('replaces session messages and taskNotifications', () => {
      const routingId = 'route-1'
      useSessionStore.getState().createNewSession(routingId, '/test')
      seed.message(routingId, makeAssistantMessage('old message'))

      const newMessages = [makeAssistantMessage('new message')]
      const newNotifications = [makeTaskNotification()]

      app.emit('session:watch-update', {
        routingId,
        messages: newMessages,
        taskNotifications: newNotifications
      })

      const session = useSessionStore.getState().sessions[routingId]
      expect(session.messages).toHaveLength(1)
      expect(session.messages[0].content[0]).toEqual({ type: 'text', text: 'new message' })
      expect(session.taskNotifications).toHaveLength(1)
    })

    it('sets statusLine when provided in watch update', () => {
      const routingId = 'route-1'
      useSessionStore.getState().createNewSession(routingId, '/test')

      const statusLine: StatusLineData = {
        totalCostUsd: 0.02,
        totalDurationMs: 1000,
        totalApiDurationMs: 900,
        totalInputTokens: 200,
        totalOutputTokens: 100,
        cachedTokens: 50,
        totalTokens: 300,
        contextWindow: { used: 300, size: 200000 },
        usedPercentage: 0.15,
        remainingPercentage: 99.85
      }

      app.emit('session:watch-update', {
        routingId,
        messages: [],
        taskNotifications: [],
        statusLine
      })

      expect(useSessionStore.getState().sessions[routingId].statusLine).toEqual(statusLine)
    })

    it('does not set statusLine when not provided in watch update', () => {
      const routingId = 'route-1'
      useSessionStore.getState().createNewSession(routingId, '/test')

      app.emit('session:watch-update', {
        routingId,
        messages: [],
        taskNotifications: []
      })

      expect(useSessionStore.getState().sessions[routingId].statusLine).toBeNull()
    })

    it('dismisses all-completed todos on watch update', () => {
      const routingId = 'route-1'
      useSessionStore.getState().createNewSession(routingId, '/test')
      seed.plan(routingId, [
        makeTodoItem('Done 1', 'completed'),
        makeTodoItem('Done 2', 'completed')
      ])

      app.emit('session:watch-update', {
        routingId,
        messages: [],
        taskNotifications: []
      })

      expect(useSessionStore.getState().sessions[routingId].todos).toHaveLength(0)
    })

    // -----------------------------------------------------------------------
    // The S4 notify: no transcript on the wire, one debounced refetch per
    // session through the cold-history path, and a delete that stays deleted.
    // -----------------------------------------------------------------------

    /** A notify as `session-watcher.ts` emits it since S4. */
    function notify(routingId: string): void {
      app.emit('session:watch-update', {
        routingId,
        sessionId: 'uuid-w',
        projectKey: '-repo',
        cwd: '/test'
      })
    }

    function stubHistory(messages: unknown[]): ReturnType<typeof vi.fn> {
      const load = vi.fn(async () => ({
        messages,
        taskNotifications: [],
        customTitle: null,
        agentIdToToolUseId: {},
        statusLine: null,
        warnings: []
      }))
      Object.assign(window.api, { loadSessionHistory: load })
      return load
    }

    it('answers a BURST of notifies with exactly one refetch, and replaces', async () => {
      const routingId = 'route-1'
      useSessionStore.getState().createNewSession(routingId, '/test')
      seed.message(routingId, makeAssistantMessage('old message'))
      const load = stubHistory([makeAssistantMessage('from disk')])

      notify(routingId)
      notify(routingId)
      notify(routingId)

      await vi.waitFor(() => {
        expect(useSessionStore.getState().sessions[routingId].messages[0].content[0]).toEqual({
          type: 'text',
          text: 'from disk'
        })
      })
      // One read for the whole burst: the file read is not incremental, so a
      // catchup replaying N notifies costs one refetch that heals all of them.
      expect(load).toHaveBeenCalledTimes(1)
      expect(load).toHaveBeenCalledWith('uuid-w', '-repo')

      // A LATER change refetches again and REPLACES — the fill-only cold seed
      // would have frozen the transcript at the first read.
      stubHistory([makeAssistantMessage('grown')])
      notify(routingId)
      await vi.waitFor(() => {
        expect(useSessionStore.getState().sessions[routingId].messages[0].content[0]).toEqual({
          type: 'text',
          text: 'grown'
        })
      })
    })

    it('refetches within the max-wait bound under a sustained notify cadence', async () => {
      const routingId = 'route-1'
      useSessionStore.getState().createNewSession(routingId, '/test')
      const load = stubHistory([makeAssistantMessage('from disk')])

      // The watcher emits every ~100 ms while a transcript is being written, and
      // the client debounce is 150 ms — so a pure reset-on-each-notify debounce
      // never fires for as long as the writing continues, which is exactly when
      // the user is watching. The max-wait bound is what stops that starvation.
      for (let i = 0; i < 6; i++) {
        notify(routingId)
        await new Promise((r) => setTimeout(r, 100))
      }
      expect(load).toHaveBeenCalled()
      expect(useSessionStore.getState().sessions[routingId].messages[0].content[0]).toEqual({
        type: 'text',
        text: 'from disk'
      })
    })

    it('retries ONCE when the refetch fails, then gives up', async () => {
      const routingId = 'route-1'
      useSessionStore.getState().createNewSession(routingId, '/test')
      // A failed read leaves a resident, un-seeded stub that the sidebar's
      // resident fast-path would paint as an empty chat, so one repair attempt
      // rides here; the next file change heals anything past that.
      const load = vi
        .fn()
        .mockRejectedValueOnce(new Error('EBUSY'))
        .mockResolvedValueOnce({
          messages: [makeAssistantMessage('from disk')],
          taskNotifications: [],
          customTitle: null,
          agentIdToToolUseId: {},
          statusLine: null,
          warnings: []
        })
      Object.assign(window.api, { loadSessionHistory: load })

      notify(routingId)
      await vi.waitFor(() => {
        expect(useSessionStore.getState().sessions[routingId].messages[0].content[0]).toEqual({
          type: 'text',
          text: 'from disk'
        })
      })
      expect(load).toHaveBeenCalledTimes(2)
    })

    it('a delete inside the debounce window stops the read from ever starting', async () => {
      const routingId = 'route-1'
      useSessionStore.getState().createNewSession(routingId, '/test')
      const load = stubHistory([makeAssistantMessage('from disk')])

      notify(routingId)
      // Inside the 150 ms window: the cancel is what has to work here, not the
      // post-await residency check (nothing has been read yet).
      app.emit('session:removed', routingId)

      await new Promise((r) => setTimeout(r, 400))
      expect(load).not.toHaveBeenCalled()
      expect(useSessionStore.getState().sessions[routingId]).toBeUndefined()
    })

    it('a refetch in flight across a delete does not re-mint the session (F7)', async () => {
      const routingId = 'route-1'
      useSessionStore.getState().createNewSession(routingId, '/test')
      let release: (() => void) | null = null
      const load = vi.fn(
        () =>
          new Promise((resolve) => {
            release = () =>
              resolve({
                messages: [makeAssistantMessage('from disk')],
                taskNotifications: [],
                customTitle: null,
                agentIdToToolUseId: {},
                statusLine: null,
                warnings: []
              })
          })
      )
      Object.assign(window.api, { loadSessionHistory: load })

      notify(routingId)
      await vi.waitFor(() => expect(load).toHaveBeenCalled())

      // The delete lands while the read is in flight. Unwatch-before-delete stops
      // any FURTHER notify (handlers-core), but this read is already gone.
      app.emit('session:removed', routingId)
      expect(useSessionStore.getState().sessions[routingId]).toBeUndefined()

      release!()
      await Promise.resolve()
      await Promise.resolve()
      expect(useSessionStore.getState().sessions[routingId]).toBeUndefined()
    })

    it('a notify for a session this client does not hold refetches nothing', async () => {
      const load = stubHistory([makeAssistantMessage('from disk')])
      // The reducer bootstraps the entry, so "does not hold" means EVICTED here —
      // the heap bound dropped its arrays and a reselect re-hydrates them from the
      // same disk read, which is what refetching would undo.
      const routingId = 'route-evicted'
      useSessionStore.getState().createNewSession(routingId, '/test')
      useSessionStore.setState((s) => ({
        sessions: { ...s.sessions, [routingId]: { ...s.sessions[routingId], evicted: true } }
      }))

      notify(routingId)
      await new Promise((r) => setTimeout(r, 250))
      expect(load).not.toHaveBeenCalled()
    })

    it('an OLD-shape update refetches nothing — it carried its own content', async () => {
      const routingId = 'route-1'
      useSessionStore.getState().createNewSession(routingId, '/test')
      const load = stubHistory([makeAssistantMessage('from disk')])

      app.emit('session:watch-update', {
        routingId,
        messages: [makeAssistantMessage('inline')],
        taskNotifications: []
      })

      await new Promise((r) => setTimeout(r, 250))
      expect(load).not.toHaveBeenCalled()
      expect(useSessionStore.getState().sessions[routingId].messages[0].content[0]).toEqual({
        type: 'text',
        text: 'inline'
      })
    })

    it('keeps todos when not all completed on watch update', () => {
      const routingId = 'route-1'
      useSessionStore.getState().createNewSession(routingId, '/test')
      seed.plan(routingId, [makeTodoItem('Done', 'completed'), makeTodoItem('Pending', 'pending')])

      app.emit('session:watch-update', {
        routingId,
        messages: [],
        taskNotifications: []
      })

      expect(useSessionStore.getState().sessions[routingId].todos).toHaveLength(2)
    })
  })

  describe('git:status-update', () => {
    it('updates gitStatus for sessions matching the cwd', () => {
      const routingId = 'route-1'
      useSessionStore.getState().createNewSession(routingId, '/project/app')

      const status: GitStatusData = {
        branch: 'main',
        files: [],
        ahead: 0,
        behind: 0,
        trackingBranch: null,
        staged: [],
        unstaged: [],
        untracked: [],
        linesAdded: 0,
        linesRemoved: 0
      }

      app.emit('git:status-update', { cwd: '/project/app', status })

      expect(useSessionStore.getState().sessions[routingId].gitStatus).toEqual(status)
    })

    it('does not update sessions with a different cwd', () => {
      useSessionStore.getState().createNewSession('route-1', '/project/app')
      useSessionStore.getState().createNewSession('route-2', '/other/project')

      const status: GitStatusData = {
        branch: 'main',
        files: [],
        ahead: 0,
        behind: 0,
        trackingBranch: null,
        staged: [],
        unstaged: [],
        untracked: [],
        linesAdded: 0,
        linesRemoved: 0
      }

      app.emit('git:status-update', { cwd: '/project/app', status })

      expect(useSessionStore.getState().sessions['route-1'].gitStatus).toEqual(status)
      expect(useSessionStore.getState().sessions['route-2'].gitStatus).toBeNull()
    })

    it('updates all sessions that share the same cwd', () => {
      useSessionStore.getState().createNewSession('route-1', '/shared/project')
      useSessionStore.getState().createNewSession('route-2', '/shared/project')

      const status: GitStatusData = {
        branch: 'feature',
        files: [],
        ahead: 1,
        behind: 0,
        trackingBranch: null,
        staged: [],
        unstaged: [],
        untracked: [],
        linesAdded: 0,
        linesRemoved: 0
      }

      app.emit('git:status-update', { cwd: '/shared/project', status })

      expect(useSessionStore.getState().sessions['route-1'].gitStatus?.branch).toBe('feature')
      expect(useSessionStore.getState().sessions['route-2'].gitStatus?.branch).toBe('feature')
    })
  })

  describe('config:settings-changed', () => {
    it('applies external settings to store', () => {
      app.emit('config:settings-changed', { theme: 'light', expandToolCalls: false })

      expect(useSessionStore.getState().settings.theme).toBe('light')
      expect(useSessionStore.getState().settings.expandToolCalls).toBe(false)
    })

    it('merges with defaults for partial settings update', () => {
      app.emit('config:settings-changed', { theme: 'monokai' })

      const settings = useSessionStore.getState().settings
      expect(settings.theme).toBe('monokai')
      expect(typeof settings.expandToolCalls).toBe('boolean')
    })
  })

  describe('config:sessions-changed', () => {
    it('applies external session config with recentSessions', () => {
      app.emit('config:sessions-changed', {
        recentSessions: ['session-a', 'session-b'],
        pinnedSessions: ['session-a'],
        customTitles: { 'session-a': 'My Session' }
      })

      const state = useSessionStore.getState()
      expect(state.recentSessionIds).toEqual(['session-a', 'session-b'])
      expect(state.pinnedSessionIds).toEqual(['session-a'])
      expect(state.customTitles['session-a']).toBe('My Session')
    })

    it('handles empty config object gracefully', () => {
      app.emit('config:sessions-changed', {})

      const state = useSessionStore.getState()
      expect(state.recentSessionIds).toEqual([])
      expect(state.pinnedSessionIds).toEqual([])
    })
  })

  describe('usage:data', () => {
    it('stores account usage data', () => {
      const usageData: AccountUsage = {
        fiveHour: {
          usedPercent: 42,
          resetsAt: new Date(Date.now() + 3600000).toISOString()
        },
        sevenDay: null,
        sevenDaySonnet: null,
        sevenDayOpus: null,
        sevenDayModels: null,
        extraUsage: null,
        planName: 'claude_max_5x',
        fetchedAt: Date.now(),
        error: null,
        accountLabel: 'alice@example.test'
      }

      app.emit('usage:data', usageData)

      expect(useSessionStore.getState().accountUsage).toEqual(usageData)
    })

    it('replaces previous account usage on update', () => {
      const first: AccountUsage = {
        fiveHour: { usedPercent: 10, resetsAt: null },
        sevenDay: null,
        sevenDaySonnet: null,
        sevenDayOpus: null,
        sevenDayModels: null,
        extraUsage: null,
        planName: null,
        fetchedAt: Date.now(),
        error: null,
        accountLabel: null
      }
      const second: AccountUsage = { ...first, fiveHour: { usedPercent: 90, resetsAt: null } }

      app.emit('usage:data', first)
      app.emit('usage:data', second)

      expect(useSessionStore.getState().accountUsage?.fiveHour?.usedPercent).toBe(90)
    })
  })

  describe('engine:models-changed', () => {
    it("reloads that engine's models only, the Settings panes, and the provider registry", async () => {
      // Main answered a degraded [] for pi earlier (a failed boot probe); the
      // composer re-fetches an engine's models only off its own nonce, and the
      // Settings panes off the shared one.
      const listProviderRegistry = vi.fn(async () => ({ entries: [], opencodeInstalled: false }))
      Object.assign(window.api, { listProviderRegistry })
      const before = useSessionStore.getState().modelReloadNonce
      const engines = { ...useSessionStore.getState().engineModelReloadNonces }

      app.emit('engine:models-changed', { engineId: 'pi' })

      expect(useSessionStore.getState().modelReloadNonce).toBe(before + 1)
      expect(useSessionStore.getState().engineModelReloadNonces).toEqual({
        ...engines,
        pi: engines.pi + 1
      })
      await vi.waitFor(() => expect(listProviderRegistry).toHaveBeenCalledTimes(1))
    })
  })

  describe('usage:block-data', () => {
    it('stores block usage data', () => {
      const blockData: BlockUsageData = {
        currentBlock: null,
        recentBlocks: [],
        todaySnapshots: [],
        dailyHistory: [],
        accounts: [],
        accountFilter: null
      }

      app.emit('usage:block-data', blockData)

      expect(useSessionStore.getState().blockUsage).toEqual(blockData)
    })

    it('replaces previous block usage on update', () => {
      const first: BlockUsageData = {
        currentBlock: null,
        recentBlocks: [],
        todaySnapshots: [],
        dailyHistory: [],
        accounts: [],
        accountFilter: null
      }
      const second: BlockUsageData = {
        currentBlock: null,
        recentBlocks: [],
        todaySnapshots: [],
        dailyHistory: [
          {
            date: '2026-04-15',
            totalTokens: 5000,
            costUsd: 0.5,
            models: {},
            peakApiPercent: 30,
            blockCount: 1
          }
        ],
        accounts: [],
        accountFilter: null
      }

      app.emit('usage:block-data', first)
      app.emit('usage:block-data', second)

      expect(useSessionStore.getState().blockUsage?.dailyHistory).toHaveLength(1)
    })
  })

  describe('app:before-quit', () => {
    it('calls confirmQuit when no active worktrees', () => {
      useSessionStore.setState({ worktreeInfoMap: {} })
      mirrorStoreIntoReplica()

      app.emit('app:before-quit')

      expect(window.api.confirmQuit as ReturnType<typeof vi.fn>).toHaveBeenCalledOnce()
      // No modal, nothing to wait for: the fallback timer is not main's to stop.
      expect(window.api.ackQuitPrompt as ReturnType<typeof vi.fn>).not.toHaveBeenCalled()
    })

    it('acks the prompt to main when it shows the quit modal, so the 5 s fallback stops (S3)', () => {
      useSessionStore.setState({
        worktreeInfoMap: {
          'route-1': {
            worktreePath: '/project/worktrees/feature-x',
            worktreeBranch: 'feature-x',
            worktreeName: 'feature-x',
            originalCwd: '/project',
            gitRoot: '/project',
            originalHeadCommit: 'abc123',
            createdAt: Date.now(),
            origin: 'created'
          }
        }
      })
      mirrorStoreIntoReplica()

      app.emit('app:before-quit')

      expect(useSessionStore.getState().quitWorktrees).toHaveLength(1)
      expect(window.api.ackQuitPrompt as ReturnType<typeof vi.fn>).toHaveBeenCalledOnce()
    })

    it('calls setQuitWorktrees with active worktrees instead of confirming quit', () => {
      const worktreeInfo: WorktreeInfo = {
        worktreePath: '/project/worktrees/feature-x',
        worktreeBranch: 'feature-x',
        worktreeName: 'feature-x',
        originalCwd: '/project',
        gitRoot: '/project',
        originalHeadCommit: 'abc123',
        createdAt: Date.now()
      }

      useSessionStore.setState({
        worktreeInfoMap: { 'route-1': worktreeInfo }
      })
      mirrorStoreIntoReplica()

      app.emit('app:before-quit')

      expect(window.api.confirmQuit as ReturnType<typeof vi.fn>).not.toHaveBeenCalled()
      const state = useSessionStore.getState()
      expect(state.quitWorktrees).toHaveLength(1)
      expect(state.quitWorktrees![0].routingId).toBe('route-1')
    })

    it('offers only worktrees ClaudeUI created for removal (C-S11)', () => {
      const base: WorktreeInfo = {
        worktreePath: '/project/worktrees/created',
        worktreeBranch: 'created',
        worktreeName: 'created',
        originalCwd: '/project',
        gitRoot: '/project',
        originalHeadCommit: 'abc123',
        createdAt: Date.now()
      }
      useSessionStore.setState({
        worktreeInfoMap: {
          'route-created': { ...base, origin: 'created' },
          'route-detected': { ...base, worktreePath: '/p/wt/detected', origin: 'detected' },
          // legacy entry without `origin`: no head commit recorded = detected
          'route-legacy-detected': { ...base, worktreePath: '/p/wt/legacy', originalHeadCommit: '' }
        }
      })
      mirrorStoreIntoReplica()

      app.emit('app:before-quit')

      expect(useSessionStore.getState().quitWorktrees!.map((w) => w.routingId)).toEqual([
        'route-created'
      ])
    })

    it('does not ask when every recorded worktree was detected, not created', () => {
      useSessionStore.setState({
        quitWorktrees: null,
        worktreeInfoMap: {
          r1: {
            worktreePath: '/p/wt/detected',
            worktreeBranch: 'b',
            worktreeName: 'detected',
            originalCwd: '/p',
            gitRoot: '/p',
            originalHeadCommit: '',
            createdAt: 0,
            origin: 'detected'
          }
        }
      })
      mirrorStoreIntoReplica()

      app.emit('app:before-quit')

      expect(window.api.confirmQuit as ReturnType<typeof vi.fn>).toHaveBeenCalledOnce()
      expect(useSessionStore.getState().quitWorktrees).toBeNull()
    })

    it('calls confirmQuit after all worktrees are removed', () => {
      useSessionStore.setState({ worktreeInfoMap: {} })
      mirrorStoreIntoReplica()

      app.emit('app:before-quit')

      expect(window.api.confirmQuit as ReturnType<typeof vi.fn>).toHaveBeenCalledOnce()
    })
  })

  describe('voice:transcript', () => {
    it('updates voiceInterimTranscript for non-final transcript', () => {
      const routingId = 'route-1'
      useSessionStore.getState().createNewSession(routingId, '/test')

      app.emit('voice:transcript', routingId, { text: 'hello wor', isFinal: false })

      expect(useSessionStore.getState().sessions[routingId].voiceInterimTranscript).toBe(
        'hello wor'
      )
    })

    it('appends to draftText and clears interim for final transcript', () => {
      const routingId = 'route-1'
      useSessionStore.getState().createNewSession(routingId, '/test')

      app.emit('voice:transcript', routingId, { text: 'hello world', isFinal: true })

      const session = useSessionStore.getState().sessions[routingId]
      expect(session.draftText).toBe('hello world')
      expect(session.voiceInterimTranscript).toBe('')
    })

    it('appends with space separator when draftText is non-empty', () => {
      const routingId = 'route-1'
      useSessionStore.getState().createNewSession(routingId, '/test')
      useSessionStore.getState().setDraftText('existing text')

      app.emit('voice:transcript', routingId, {
        text: 'new sentence',
        isFinal: true
      })

      expect(useSessionStore.getState().sessions[routingId].draftText).toBe(
        'existing text new sentence'
      )
    })

    it('replaces interim transcript on each non-final event', () => {
      const routingId = 'route-1'
      useSessionStore.getState().createNewSession(routingId, '/test')

      app.emit('voice:transcript', routingId, { text: 'hel', isFinal: false })
      app.emit('voice:transcript', routingId, { text: 'hello', isFinal: false })
      app.emit('voice:transcript', routingId, { text: 'hello wor', isFinal: false })

      expect(useSessionStore.getState().sessions[routingId].voiceInterimTranscript).toBe(
        'hello wor'
      )
    })
  })

  describe('voice:state', () => {
    it('sets voiceState on the session', () => {
      const routingId = 'route-1'
      useSessionStore.getState().createNewSession(routingId, '/test')

      app.emit('voice:state', routingId, 'recording' as VoiceState)

      expect(useSessionStore.getState().sessions[routingId].voiceState).toBe('recording')
    })

    it('transitions through voice states correctly', () => {
      const routingId = 'route-1'
      useSessionStore.getState().createNewSession(routingId, '/test')

      app.emit('voice:state', routingId, 'connecting' as VoiceState)
      expect(useSessionStore.getState().sessions[routingId].voiceState).toBe('connecting')

      app.emit('voice:state', routingId, 'recording' as VoiceState)
      expect(useSessionStore.getState().sessions[routingId].voiceState).toBe('recording')

      app.emit('voice:state', routingId, 'processing' as VoiceState)
      expect(useSessionStore.getState().sessions[routingId].voiceState).toBe('processing')

      app.emit('voice:state', routingId, 'idle' as VoiceState)
      expect(useSessionStore.getState().sessions[routingId].voiceState).toBe('idle')
    })
  })

  // S3a item 2: a voice message is the mic's notice pill, NEVER the session's
  // error stack — and the tone main sends decides its colour.
  describe('voice:error', () => {
    const noticeOf = (routingId: string): ReturnType<typeof voiceNoticeFor> =>
      voiceNoticeFor(useVoiceNoticeStore.getState().notices, routingId)

    /**
     * Press and release through the REAL controller. jsdom has no audio, so the
     * capture refuses — but the press is this client's from the moment it is
     * made, exactly as a refused microphone's error is.
     */
    async function pressAndRelease(routingId: string): Promise<void> {
      await voiceController()
        .start(routingId, 'en')
        .catch(() => {})
      await voiceController()
        .stop(routingId)
        .catch(() => {})
    }

    beforeEach(async () => {
      resetVoiceNoticesForTests()
      resetVoiceControllerForTests()
      // These cases are about what a notice LOOKS like; this client captured.
      await pressAndRelease('route-1')
    })

    it('becomes the session’s voice notice, not a session error', () => {
      const routingId = 'route-1'
      useSessionStore.getState().createNewSession(routingId, '/test')

      app.emit('voice:error', routingId, 'Deepgram said no', 'warn')

      expect(noticeOf(routingId)).toMatchObject({ text: 'Deepgram said no', tone: 'warn' })
      expect(useSessionStore.getState().sessions[routingId].errors).toEqual([])
    })

    it('carries the tone main sent — an outcome is info', () => {
      app.emit('voice:error', 'route-1', 'No speech detected', 'info')
      expect(noticeOf('route-1')).toMatchObject({ text: 'No speech detected', tone: 'info' })
    })

    it('an older two-argument emitter reads as warn', () => {
      app.emit('voice:error', 'route-1', 'legacy')
      expect(noticeOf('route-1')).toMatchObject({ text: 'legacy', tone: 'warn' })
    })

    // Review item 1: `voice:error` is replicated — a client watching the session
    // must not show another client's microphone messages above its own mic.
    it('a session this client never captured for shows nothing (and no session error)', () => {
      useSessionStore.getState().createNewSession('route-2', '/test')
      app.emit('voice:error', 'route-2', 'Deepgram said no', 'warn')
      expect(noticeOf('route-2')).toBeNull()
      expect(useSessionStore.getState().sessions['route-2'].errors).toEqual([])
    })

    it('shows during its own capture and just after it, and nothing once the window closes', async () => {
      resetVoiceControllerForTests()
      vi.useFakeTimers({ toFake: ['Date'] })
      try {
        const starting = voiceController()
          .start('route-3', 'en')
          .catch(() => {})
        app.emit('voice:error', 'route-3', 'during', 'warn')
        expect(noticeOf('route-3')).toMatchObject({ text: 'during' })
        await starting

        await voiceController()
          .stop('route-3')
          .catch(() => {})
        vi.setSystemTime(Date.now() + VOICE_OWNERSHIP_WINDOW_MS - 1000)
        app.emit('voice:error', 'route-3', 'No speech detected', 'info')
        expect(noticeOf('route-3')).toMatchObject({ text: 'No speech detected' })

        vi.setSystemTime(Date.now() + 1000)
        app.emit('voice:error', 'route-3', 'too late', 'warn')
        expect(noticeOf('route-3')).toMatchObject({ text: 'No speech detected' })
      } finally {
        vi.useRealTimers()
      }
    })

    it('a newer message replaces the older rather than stacking', () => {
      const routingId = 'route-1'
      useSessionStore.getState().createNewSession(routingId, '/test')

      app.emit('voice:error', routingId, 'error 1', 'warn')
      app.emit('voice:error', routingId, 'error 2', 'warn')

      expect(noticeOf(routingId)).toMatchObject({ text: 'error 2' })
      expect(useSessionStore.getState().sessions[routingId].errors).toEqual([])
    })

    // ADR-101 §6: the action rides as data, like the tone — and the refusal that
    // carries it ends the start quietly in main, so THIS client's microphone,
    // opened before the start, has to be stopped here.
    describe('the install-voice-pack action', () => {
      const MODEL_TEXT = 'Voice input for this engine needs the on-device speech model (~700 MB)'

      it('reaches the notice as data, with its tone', () => {
        app.emit('voice:error', 'route-1', MODEL_TEXT, 'warn', 'install-voice-pack')
        expect(noticeOf('route-1')).toMatchObject({
          text: MODEL_TEXT,
          tone: 'warn',
          action: 'install-voice-pack'
        })
      })

      it('stops this client’s live capture for that session, with no notice of its own', () => {
        const stop = vi.spyOn(voiceController(), 'stopIfCapturing').mockResolvedValue()
        app.emit('voice:error', 'route-1', MODEL_TEXT, 'warn', 'install-voice-pack')
        expect(stop).toHaveBeenCalledTimes(1)
        expect(stop).toHaveBeenCalledWith('route-1')
        // The refusal IS the notice: nothing else was raised.
        expect(noticeOf('route-1')).toMatchObject({ text: MODEL_TEXT })
        expect(useVoiceNoticeStore.getState().notices).toEqual({
          'route-1': expect.objectContaining({ text: MODEL_TEXT })
        })
      })

      it('a failing stop does not surface (the capture is halted either way)', async () => {
        vi.spyOn(voiceController(), 'stopIfCapturing').mockRejectedValue(
          new Error('transport gone')
        )
        expect(() =>
          app.emit('voice:error', 'route-1', MODEL_TEXT, 'warn', 'install-voice-pack')
        ).not.toThrow()
        await Promise.resolve()
        expect(noticeOf('route-1')).toMatchObject({ text: MODEL_TEXT })
      })

      it('keys on the action, not the wording: a plain notice with the same text stops nothing', () => {
        const stop = vi.spyOn(voiceController(), 'stopIfCapturing').mockResolvedValue()
        app.emit('voice:error', 'route-1', MODEL_TEXT, 'warn')
        app.emit('voice:error', 'route-1', 'No speech detected', 'info')
        expect(stop).not.toHaveBeenCalled()
        expect(noticeOf('route-1')).not.toHaveProperty('action')
      })

      it('a session this client never captured for shows nothing and stops nothing', () => {
        const stop = vi.spyOn(voiceController(), 'stopIfCapturing').mockResolvedValue()
        app.emit('voice:error', 'route-2', MODEL_TEXT, 'warn', 'install-voice-pack')
        expect(noticeOf('route-2')).toBeNull()
        expect(stop).not.toHaveBeenCalled()
      })
    })
  })

  // ADR-101 §6: the speech pack's status is replicated; the client store follows it.
  describe('voice:pack-changed', () => {
    it('lands in the voice pack store, replacing the last status', () => {
      resetVoicePackStoreForTests()
      const status = (state: VoicePackState): VoicePackStatus => ({
        state,
        packId: 'parakeet-tdt-0.6b-v2-int8',
        label: 'Parakeet TDT 0.6B v2 (English)',
        approxBytes: 700_000_000
      })
      app.emit('voice:pack-changed', status('installing'))
      expect(useVoicePackStore.getState().status?.state).toBe('installing')
      app.emit('voice:pack-changed', status('ready'))
      expect(useVoicePackStore.getState().status?.state).toBe('ready')
    })
  })

  // S3: events are lost to a full resync, a host restart or a ring overflow, and a
  // pill that last heard "Downloading… 42%" would sit there for good. Every
  // answered sync re-reads the status (which is also the first read).
  describe('voice:pack-status after an answered sync', () => {
    const status = (state: VoicePackState): VoicePackStatus => ({
      state,
      packId: 'parakeet-tdt-0.6b-v2-int8',
      label: 'Parakeet TDT 0.6B v2 (English)',
      approxBytes: 700_000_000
    })

    it('re-reads the status, replacing a stale one', async () => {
      resetVoicePackStoreForTests()
      const reads = vi.fn(() => status('missing'))
      app.bridge.ipcMain.handle('voice:pack-status', reads)
      app.emit('voice:pack-changed', {
        ...status('installing'),
        progress: { receivedBytes: 42, totalBytes: 100 }
      })
      expect(useVoicePackStore.getState().status?.state).toBe('installing')

      // The host restarted: the install is gone, and no event said so.
      act(() => {
        app.syncClient.applyFullState({ seq: 1 } as never, 'epoch-2', 1)
      })
      await vi.waitFor(() => expect(useVoicePackStore.getState().status?.state).toBe('missing'))
      expect(reads).toHaveBeenCalled()
    })

    it('a host that cannot answer leaves the last status alone', async () => {
      resetVoicePackStoreForTests()
      app.bridge.ipcMain.handle('voice:pack-status', () => {
        throw new Error('No handler registered for voice:pack-status')
      })
      app.emit('voice:pack-changed', status('ready'))
      act(() => {
        app.syncClient.applyFullState({ seq: 1 } as never, 'epoch-3', 1)
      })
      await vi.waitFor(() => expect(useVoicePackStore.getState().readFailed).toBe(true))
      expect(useVoicePackStore.getState().status?.state).toBe('ready')
    })
  })

  describe('plugin:views-changed', () => {
    it('updates pluginViews in store', () => {
      const views: PluginViewWithOwner[] = [
        {
          pluginId: 'my-plugin',
          id: 'main-view',
          label: 'My Plugin View',
          icon: 'gear',
          htmlFile: 'index.html'
        }
      ]

      app.emit('plugin:views-changed', views)

      expect(useSessionStore.getState().pluginViews).toEqual(views)
    })

    it('replaces previous plugin views on update', () => {
      app.emit('plugin:views-changed', [
        { pluginId: 'plugin-a', id: 'view-a', label: 'View A', icon: 'a', htmlFile: 'a.html' }
      ])
      app.emit('plugin:views-changed', [])

      expect(useSessionStore.getState().pluginViews).toHaveLength(0)
    })
  })

  describe('session:status running state', () => {
    it('clears needsAttention when status becomes running', () => {
      const routingId = 'route-1'
      useSessionStore.getState().createNewSession(routingId, '/test')
      useSessionStore.getState().setNeedsAttention(routingId, true)

      app.emit(
        'session:status',
        routingId,
        makeSessionStatus({
          state: 'running',
          sessionId: routingId
        })
      )

      expect(useSessionStore.getState().sessions[routingId].needsAttention).toBe(false)
    })

    it('does not clear needsAttention when status becomes idle', () => {
      const routingId = 'route-1'
      useSessionStore.getState().createNewSession(routingId, '/test')
      useSessionStore.getState().setNeedsAttention(routingId, true)

      app.emit(
        'session:status',
        routingId,
        makeSessionStatus({
          state: 'idle',
          sessionId: routingId
        })
      )

      expect(useSessionStore.getState().sessions[routingId].needsAttention).toBe(true)
    })
  })

  describe('session:result turn-end gate', () => {
    const routingId = 'route-1'
    type NotifyCall = (title: string, options?: NotificationOptions) => void
    let notified: ReturnType<typeof vi.fn<NotifyCall>>
    let originalNotification: PropertyDescriptor | undefined

    beforeEach(() => {
      // The jsdom setup installs its DENIED stub only when `Notification` is
      // absent, and `notifyIfNeeded` reads the global at call time — so granting
      // permission is a per-test descriptor swap, restored below.
      originalNotification = Object.getOwnPropertyDescriptor(globalThis, 'Notification')
      notified = vi.fn<NotifyCall>()
      Object.defineProperty(globalThis, 'Notification', {
        configurable: true,
        value: class {
          static permission = 'granted'
          static requestPermission = async (): Promise<NotificationPermission> => 'granted'
          constructor(title: string, options?: NotificationOptions) {
            notified(title, options)
          }
        }
      })
      // switchTo=false: the attention branch is only reachable for a session that
      // is not the active one, and jsdom's document is focused.
      useSessionStore.getState().createNewSession(routingId, '/test', false)
      useSessionStore.getState().markSdkActive(routingId)
    })

    afterEach(() => {
      if (originalNotification) {
        Object.defineProperty(globalThis, 'Notification', originalNotification)
      } else {
        Reflect.deleteProperty(globalThis, 'Notification')
      }
    })

    it("does not claim the user's turn while a background agent is running", () => {
      seed.taskStarted(routingId, { toolUseId: 't1', taskId: 'a1', taskType: 'local_agent' })

      app.emit('session:result', routingId)

      expect(useSessionStore.getState().sessions[routingId].needsAttention).toBe(false)
      expect(notified).not.toHaveBeenCalled()
    })

    it.each(['local_bash', 'monitor_mcp', 'monitor_ws'])(
      'does not claim the turn while a background %s that wakes the agent is running',
      (taskType) => {
        // 2.1.293: a finished shell or monitor starts a turn of its own, so the
        // result under it is a pause, not the user's turn (owner ruling 2026-10-19).
        seed.taskStarted(routingId, {
          toolUseId: 't1',
          taskId: 'a1',
          taskType,
          wakesParent: true
        })

        app.emit('session:result', routingId)

        expect(useSessionStore.getState().sessions[routingId].needsAttention).toBe(false)
        expect(notified).not.toHaveBeenCalled()
      }
    )

    it('claims the turn while only a task that does not wake the agent is running', () => {
      seed.taskStarted(routingId, {
        toolUseId: 't1',
        taskId: 'a1',
        taskType: 'dream',
        wakesParent: false
      })

      app.emit('session:result', routingId)

      expect(useSessionStore.getState().sessions[routingId].needsAttention).toBe(true)
      expect(notified).toHaveBeenCalledWith('Ready for input', expect.anything())
    })

    describe('a background X-Agent (dispatch record with wakesParent) — ADR-105 §3', () => {
      const dispatchRecord = {
        toolUseId: 'tx',
        taskId: 's-abc234',
        taskType: 'dispatch',
        isBackgrounded: true,
        wakesParent: true
      }
      const status = (state: 'idle' | 'running'): void =>
        app.emit('session:status', routingId, makeSessionStatus({ state, sessionId: routingId }))
      const attention = (): boolean => useSessionStore.getState().sessions[routingId].needsAttention

      it('holds the turn end back while it runs; its result is delivered as a turn whose own end claims the turn', () => {
        seed.taskStarted(routingId, dispatchRecord)
        app.emit('session:result', routingId)
        // Violet, not yellow, and no "Ready for input": the X-Agent's result will wake the agent.
        expect(attention()).toBe(false)
        expect(notified).not.toHaveBeenCalled()

        // The X-Agent ends: its record leaves and the delivery starts a turn on the parent.
        seed.taskNotification(
          routingId,
          makeTaskNotification({ toolUseId: 'tx', status: 'completed' })
        )
        status('running')
        expect(attention()).toBe(false)
        app.emit('session:result', routingId)
        expect(attention()).toBe(true)
        expect(notified).toHaveBeenCalledWith('Ready for input', expect.anything())
      })

      it('a result that had to wait raises attention and a notification of its own', () => {
        seed.taskStarted(routingId, dispatchRecord)
        app.emit('session:result', routingId)
        seed.taskNotification(
          routingId,
          makeTaskNotification({ toolUseId: 'tx', status: 'completed' })
        )
        expect(attention()).toBe(false)

        app.emit('session:dispatch-result-held', routingId, { name: 'rev' })

        expect(attention()).toBe(true)
        // One notification per parent however many X-Agents are held: they share a tag.
        expect(notified).toHaveBeenCalledWith(
          'X-Agent rev finished — result waiting',
          expect.objectContaining({ tag: `dispatch-result-held:${routingId}` })
        )
      })

      it('a held result with no X-Agent name does not read "X-Agent agent finished"', () => {
        app.emit('session:dispatch-result-held', routingId, {})

        const [title] = notified.mock.calls[0]
        expect(title).toBe('An X-Agent finished — result waiting')
      })

      it('says nothing to a user who is looking at that session', () => {
        useSessionStore.setState({ activeSessionId: routingId })
        const focus = vi.spyOn(document, 'hasFocus').mockReturnValue(true)
        try {
          app.emit('session:dispatch-result-held', routingId, { name: 'rev' })
          expect(attention()).toBe(false)
          expect(notified).not.toHaveBeenCalled()
        } finally {
          focus.mockRestore()
        }
      })
    })

    // The OS notification of an approval names the action as the card does, not the wire
    // spelling of a first-party tool (owner ask #5, ADR-105).
    describe('the "Permission required" notification names the action, not its wire spelling', () => {
      const ask = (toolName: string, subagentType?: string, engineId?: EngineId): string => {
        // The replica owns the status the notification reads the session's engine from.
        if (engineId) seed.status(routingId, makeSessionStatus({ sessionId: routingId, engineId }))
        app.emit('session:approval-request', routingId, {
          requestId: `req-${toolName}`,
          toolName,
          input: {},
          ...(subagentType ? { agent: { agentId: 'a', label: 'pi', subagentType } } : {})
        })
        expect(notified).toHaveBeenCalledWith('Permission required', expect.anything())
        return notified.mock.calls[0][1]?.body ?? ''
      }

      it("a Claude parent's own dispatch_agent ask", () => {
        const body = ask('mcp__claude-ui-collab__dispatch_agent')
        expect(body).toContain('X-Agent needs approval')
        expect(body).not.toContain('mcp__')
      })

      it('an X-Agent session_message ask forwarded with the dispatch: prefix, in the target engine', () => {
        const body = ask('dispatch:session_message', 'dispatch:pi')
        expect(body).toContain('Session · message needs approval')
        expect(body).not.toContain('dispatch:')
      })

      it('an X-Agent hand_back ask, spelled bare by pi and claudeui_-prefixed by opencode', () => {
        expect(ask('dispatch:hand_back', 'dispatch:pi')).toContain('Hand back needs approval')
        notified.mockClear()
        expect(ask('dispatch:claudeui_hand_back', 'dispatch:opencode')).toContain(
          'Hand back needs approval'
        )
      })

      it('a Claude X-Agent’s mcp__ ask is read by the Claude map', () => {
        const body = ask('dispatch:mcp__claude-ui-sessions__session_message', 'dispatch:claude')
        expect(body).toContain('Session · message needs approval')
        expect(body).not.toContain('mcp__')
      })

      // A first-party tool keeps its label; a third-party one must say which tool it asks to run.
      it('a third-party MCP tool names its server and tool, on every engine', () => {
        for (const engine of ['claude', 'pi', 'opencode'] as const) {
          notified.mockClear()
          const body = ask('mcp__github__create_issue', undefined, engine)
          expect(body).toContain('github / create_issue needs approval')
        }
      })
    })

    it('lets wakesParent: false override the type', () => {
      // The emitter's word wins over the type set in both directions.
      seed.taskStarted(routingId, {
        toolUseId: 't1',
        taskId: 'a1',
        taskType: 'local_agent',
        wakesParent: false
      })

      app.emit('session:result', routingId)

      expect(useSessionStore.getState().sessions[routingId].needsAttention).toBe(true)
    })

    it('judges a record without wakesParent by the legacy type set', () => {
      // An older replay: a shell record carries no field and stays "not working",
      // an agent record carries none and still is.
      seed.taskStarted(routingId, { toolUseId: 't1', taskId: 'a1', taskType: 'local_bash' })
      app.emit('session:result', routingId)
      expect(useSessionStore.getState().sessions[routingId].needsAttention).toBe(true)

      useSessionStore.getState().setNeedsAttention(routingId, false)
      seed.taskNotification(
        routingId,
        makeTaskNotification({ toolUseId: 't1', status: 'completed' })
      )
      seed.taskStarted(routingId, { toolUseId: 't2', taskId: 'a2', taskType: 'local_agent' })
      app.emit('session:result', routingId)
      expect(useSessionStore.getState().sessions[routingId].needsAttention).toBe(false)
    })

    it('does not claim the turn while a queued prompt is about to go out', () => {
      seed.queue(routingId, [{ itemId: 'q1', text: 'next', state: 'queued' }])

      app.emit('session:result', routingId)

      expect(useSessionStore.getState().sessions[routingId].needsAttention).toBe(false)
      expect(notified).not.toHaveBeenCalled()
    })

    it('claims the turn for a queued prompt that is held behind a sign-in', () => {
      seed.queue(routingId, [{ itemId: 'q1', text: 'next', state: 'queued' }])
      app.emit('session:auth-required', routingId, { providerId: 'chatgpt', message: 'sign in' })

      app.emit('session:result', routingId)

      expect(useSessionStore.getState().sessions[routingId].needsAttention).toBe(true)
    })

    it('claims the turn again once the queue has drained', () => {
      seed.queue(routingId, [{ itemId: 'q1', text: 'next', state: 'queued' }])
      seed.queue(routingId, [{ itemId: 'q1', text: 'next', state: 'consumed' }])

      app.emit('session:result', routingId)

      expect(useSessionStore.getState().sessions[routingId].needsAttention).toBe(true)
    })

    it('claims the turn once the background agent has reported in', () => {
      seed.taskStarted(routingId, { toolUseId: 't1', taskId: 'a1', taskType: 'local_agent' })
      seed.taskNotification(
        routingId,
        makeTaskNotification({ toolUseId: 't1', status: 'completed' })
      )

      app.emit('session:result', routingId)

      expect(useSessionStore.getState().sessions[routingId].needsAttention).toBe(true)
      expect(notified).toHaveBeenCalledWith('Ready for input', expect.anything())
    })

    describe('a result that cli.js follows with a hand-back turn (pendingWake)', () => {
      const wakeResult = { totalCostUsd: 0, durationMs: 1, result: 'ok', pendingWake: true }
      const plainResult = { totalCostUsd: 0, durationMs: 1, result: 'ok' }
      const status = (state: 'idle' | 'running'): void =>
        app.emit('session:status', routingId, makeSessionStatus({ state, sessionId: routingId }))
      const attention = (): boolean => useSessionStore.getState().sessions[routingId].needsAttention

      beforeEach(() => {
        vi.useFakeTimers()
      })
      afterEach(() => {
        vi.useRealTimers()
      })

      it('raises nothing at the result; the hand-back turn’s own result decides', () => {
        app.emit('session:result', routingId, wakeResult)
        status('idle')
        expect(attention()).toBe(false)
        expect(notified).not.toHaveBeenCalled()

        // The extra turn starts ~17 ms later: the timer must be gone.
        status('running')
        vi.advanceTimersByTime(PENDING_WAKE_GRACE_MS * 2)
        expect(attention()).toBe(false)
        expect(notified).not.toHaveBeenCalled()

        app.emit('session:result', routingId, plainResult)
        status('idle')
        expect(attention()).toBe(true)
        expect(notified).toHaveBeenCalledTimes(1)
        expect(notified).toHaveBeenCalledWith('Ready for input', expect.anything())
      })

      it('falls back to the normal gate after 3 s when no turn follows', () => {
        app.emit('session:result', routingId, wakeResult)
        status('idle')

        vi.advanceTimersByTime(PENDING_WAKE_GRACE_MS - 1)
        expect(attention()).toBe(false)
        expect(notified).not.toHaveBeenCalled()

        vi.advanceTimersByTime(1)
        expect(attention()).toBe(true)
        expect(notified).toHaveBeenCalledTimes(1)
        expect(notified).toHaveBeenCalledWith('Ready for input', expect.anything())
      })

      it('applies the full gate at the fallback — waking tasks, a queued prompt', () => {
        seed.taskStarted(routingId, { toolUseId: 't1', taskId: 'a1', taskType: 'local_agent' })
        app.emit('session:result', routingId, wakeResult)
        vi.advanceTimersByTime(PENDING_WAKE_GRACE_MS)
        expect(attention()).toBe(false)
        expect(notified).not.toHaveBeenCalled()

        seed.taskNotification(
          routingId,
          makeTaskNotification({ toolUseId: 't1', status: 'completed' })
        )
        seed.queue(routingId, [{ itemId: 'q1', text: 'next', state: 'queued' }])
        app.emit('session:result', routingId, wakeResult)
        vi.advanceTimersByTime(PENDING_WAKE_GRACE_MS)
        expect(attention()).toBe(false)
        expect(notified).not.toHaveBeenCalled()
      })

      it('a newer result replaces the pending timer instead of adding a second notification', () => {
        app.emit('session:result', routingId, wakeResult)
        vi.advanceTimersByTime(1000)
        app.emit('session:result', routingId, plainResult)
        expect(notified).toHaveBeenCalledTimes(1)

        vi.advanceTimersByTime(PENDING_WAKE_GRACE_MS * 2)
        expect(notified).toHaveBeenCalledTimes(1)
      })

      it('a removed session never fires the fallback', () => {
        app.emit('session:result', routingId, wakeResult)
        app.emit('session:removed', routingId)
        vi.advanceTimersByTime(PENDING_WAKE_GRACE_MS * 2)
        expect(notified).not.toHaveBeenCalled()
      })
    })
  })

  describe('session:status never drops a worktree entry', () => {
    it('does NOT clear worktreeInfo when the status cwd is the original cwd (it is the spawn cwd)', () => {
      const routingId = 'route-1'
      useSessionStore.getState().createNewSession(routingId, '/project/app')
      useSessionStore.getState().setWorktreeInfo(routingId, {
        worktreePath: '/project/worktrees/feat',
        worktreeBranch: 'feat',
        worktreeName: 'feat',
        originalCwd: '/project/app',
        gitRoot: '/project/app',
        originalHeadCommit: 'abc123',
        createdAt: Date.now()
      })

      app.emit(
        'session:status',
        routingId,
        makeSessionStatus({
          state: 'idle',
          sessionId: routingId,
          cwd: '/project/app'
        })
      )

      expect(useSessionStore.getState().sessions[routingId].worktreeInfo).not.toBeNull()
      expect(useSessionStore.getState().worktreeInfoMap[routingId]).toBeDefined()
    })

    it('does not clear worktreeInfo when cwd is still in the worktree path', () => {
      const routingId = 'route-1'
      useSessionStore.getState().createNewSession(routingId, '/project/app')
      useSessionStore.getState().setWorktreeInfo(routingId, {
        worktreePath: '/project/worktrees/feat',
        worktreeBranch: 'feat',
        worktreeName: 'feat',
        originalCwd: '/project/app',
        gitRoot: '/project/app',
        originalHeadCommit: 'abc123',
        createdAt: Date.now()
      })

      app.emit(
        'session:status',
        routingId,
        makeSessionStatus({
          state: 'running',
          sessionId: routingId,
          cwd: '/project/worktrees/feat'
        })
      )

      expect(useSessionStore.getState().sessions[routingId].worktreeInfo).not.toBeNull()
    })

    it('does not clear worktreeInfo when status has no cwd', () => {
      const routingId = 'route-1'
      useSessionStore.getState().createNewSession(routingId, '/project/app')
      useSessionStore.getState().setWorktreeInfo(routingId, {
        worktreePath: '/project/worktrees/feat',
        worktreeBranch: 'feat',
        worktreeName: 'feat',
        originalCwd: '/project/app',
        gitRoot: '/project/app',
        originalHeadCommit: 'abc123',
        createdAt: Date.now()
      })

      app.emit(
        'session:status',
        routingId,
        makeSessionStatus({
          state: 'running',
          sessionId: routingId
        })
      )

      expect(useSessionStore.getState().sessions[routingId].worktreeInfo).not.toBeNull()
    })
  })

  // ── ADR-070 §2 / Slice I: the one resolution signal, and the reads it owes ──
  //
  // `account:changed` is HOST-LOCAL — `AccountManager.broadcast` sends it
  // straight to the desktop window, bypassing SyncCore — so a remote client
  // never hears the backfill that turns the `Account N` placeholder into the
  // real email. `provider:auth-resolved` is replicated and lands AFTER
  // `noteLogin` has written it (it is `finalize`'s last statement, deliberately),
  // so it is the edge a web client can learn from.
  describe('provider:auth-resolved', () => {
    const BACKFILLED = {
      enabled: true,
      activeId: 'a2',
      accounts: [
        {
          id: 'a2',
          email: 'two@example.com',
          subscriptionType: 'Claude Pro',
          organization: null,
          createdAt: 0
        }
      ]
    }

    it('anthropic re-reads the accounts, so a remote client sees the backfill', async () => {
      const getAccounts = vi.fn(async () => BACKFILLED)
      Object.assign(window.api, { getAccounts })

      app.emit('provider:auth-resolved', { providerId: 'anthropic' })

      await vi.waitFor(() => expect(getAccounts).toHaveBeenCalledTimes(1))
      await vi.waitFor(() => expect(useSessionStore.getState().accountsState).toEqual(BACKFILLED))
    })

    it('chatgpt does not read the ANTHROPIC accounts — the arms are disjoint', async () => {
      useSessionStore.setState({ accountsState: null })
      const getAccounts = vi.fn(async () => BACKFILLED)
      const listProviderRegistry = vi.fn(async () => ({ entries: [], opencodeInstalled: false }))
      Object.assign(window.api, { getAccounts, listProviderRegistry })

      app.emit('provider:auth-resolved', { providerId: 'chatgpt' })

      // The ChatGPT arm ran — so "no account read" is an assertion about the
      // arms being disjoint, not about the event having been missed.
      await vi.waitFor(() => expect(listProviderRegistry).toHaveBeenCalledTimes(1))
      expect(getAccounts).not.toHaveBeenCalled()
      expect(useSessionStore.getState().accountsState).toBeNull()
    })

    /**
     * `providerAccounts` is the ChatGPT twin of `accountsState` and it is
     * host-local in the same way — nothing publishes a change event for the
     * vault at all, so the only edge that refreshed it was `SignInDialog`'s own
     * `collectOutcome`. A SECOND client therefore kept the pre-sign-in list
     * (the `Account N` placeholder, or no account at all) for the life of the
     * page, while the `providerAuth` the same handler refreshed said connected.
     */
    it('chatgpt re-reads the VAULT account list, so a second client is not stale', async () => {
      const VAULT = {
        activeId: 'v1',
        accounts: [{ id: 'v1', email: 'vault@example.com', expiresAt: 0, needsReauth: false }]
      }
      useSessionStore.setState({ providerAccounts: null })
      const listProviderAccounts = vi.fn(async () => VAULT)
      const listProviderRegistry = vi.fn(async () => ({ entries: [], opencodeInstalled: false }))
      Object.assign(window.api, { listProviderAccounts, listProviderRegistry })

      app.emit('provider:auth-resolved', { providerId: 'chatgpt' })

      await vi.waitFor(() => expect(listProviderAccounts).toHaveBeenCalledWith('chatgpt'))
      await vi.waitFor(() => expect(useSessionStore.getState().providerAccounts).toEqual(VAULT))
    })

    /**
     * Another engineer's slice adds an optional `accountId` to this payload.
     * The handler must not start depending on it — both reads are unconditional
     * refreshes of host-owned state, not a per-account patch.
     */
    it('tolerates an accountId on the payload without changing what it reads', async () => {
      const listProviderAccounts = vi.fn(async () => ({
        activeId: 'v1',
        accounts: []
      }))
      const listProviderRegistry = vi.fn(async () => ({ entries: [], opencodeInstalled: false }))
      Object.assign(window.api, { listProviderAccounts, listProviderRegistry })

      app.emit('provider:auth-resolved', { providerId: 'chatgpt', accountId: 'v9' })

      await vi.waitFor(() => expect(listProviderRegistry).toHaveBeenCalledTimes(1))
      await vi.waitFor(() => expect(listProviderAccounts).toHaveBeenCalledTimes(1))
    })

    it('a failed read keeps the last good answer, exactly like the probe beside it', async () => {
      useSessionStore.setState({ accountsState: BACKFILLED })
      const getAccounts = vi.fn(async () => {
        throw new Error('account:get failed')
      })
      Object.assign(window.api, { getAccounts })

      app.emit('provider:auth-resolved', { providerId: 'anthropic' })

      await vi.waitFor(() => expect(getAccounts).toHaveBeenCalledTimes(1))
      expect(useSessionStore.getState().accountsState).toEqual(BACKFILLED)
    })
  })

  describe('multi-session isolation', () => {
    it('bash output for one session does not affect another', () => {
      useSessionStore.getState().createNewSession('route-1', '/proj1')
      useSessionStore.getState().createNewSession('route-2', '/proj2')

      app.emit('session:bash-output', 'route-1', {
        toolUseId: 'tool-1',
        output: 'only for route-1',
        totalLines: 1,
        totalBytes: 15
      })

      expect(useSessionStore.getState().sessions['route-1'].bashOutputs['tool-1']).toBeDefined()
      expect(useSessionStore.getState().sessions['route-2'].bashOutputs['tool-1']).toBeUndefined()
    })

    it('voice transcript for one session does not affect another', () => {
      useSessionStore.getState().createNewSession('route-1', '/proj1')
      useSessionStore.getState().createNewSession('route-2', '/proj2')

      app.emit('voice:transcript', 'route-1', {
        text: 'only route-1',
        isFinal: true
      })

      expect(useSessionStore.getState().sessions['route-1'].draftText).toBe('only route-1')
      expect(useSessionStore.getState().sessions['route-2'].draftText).toBe('')
    })

    it('sandbox violations for one session do not appear in another', () => {
      useSessionStore.getState().createNewSession('route-1', '/proj1')
      useSessionStore.getState().createNewSession('route-2', '/proj2')

      app.emit('session:sandbox-violation', 'route-1', 'network blocked')

      expect(useSessionStore.getState().sessions['route-1'].sandboxViolations).toHaveLength(1)
      expect(useSessionStore.getState().sessions['route-2'].sandboxViolations).toHaveLength(0)
    })
  })
})
