import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
vi.mock('electron', async () => import('@test/stubs/electron-shim'))

import { createElement } from 'react'
import { render, cleanup } from '@testing-library/react'
import { bootTestApp, type TestApp } from '@test/helpers/boot-test-app'
import { useClaudeEvents } from '../useClaudeEvents'
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
  FileDiff
} from '../../../../shared/types'
import { seed, mirrorStoreIntoReplica } from '@test/helpers/replica-seed'

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
  Object.assign(window.api, { saveSlashCommands: vi.fn(), confirmQuit: vi.fn() })

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
        contextWindowSize: 200000,
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
        contextWindowSize: 200000,
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
        contextWindowSize: 200000,
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
        error: null
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
        error: null
      }
      const second: AccountUsage = { ...first, fiveHour: { usedPercent: 90, resetsAt: null } }

      app.emit('usage:data', first)
      app.emit('usage:data', second)

      expect(useSessionStore.getState().accountUsage?.fiveHour.usedPercent).toBe(90)
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

  describe('voice:error', () => {
    it('adds voice error to session errors array', () => {
      const routingId = 'route-1'
      useSessionStore.getState().createNewSession(routingId, '/test')

      app.emit('voice:error', routingId, 'Microphone access denied')

      expect(useSessionStore.getState().sessions[routingId].errors).toContain(
        'Microphone access denied'
      )
    })

    it('accumulates multiple voice errors', () => {
      const routingId = 'route-1'
      useSessionStore.getState().createNewSession(routingId, '/test')

      app.emit('voice:error', routingId, 'error 1')
      app.emit('voice:error', routingId, 'error 2')

      expect(useSessionStore.getState().sessions[routingId].errors).toHaveLength(2)
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

    it('still claims the turn while a background SHELL is running', () => {
      // A dev server left running is the user's turn, not the agent's.
      seed.taskStarted(routingId, { toolUseId: 't1', taskId: 'a1', taskType: 'local_bash' })

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
  })

  describe('session:status worktree exit detection', () => {
    it('clears worktreeInfo when cwd returns to originalCwd', () => {
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

      expect(useSessionStore.getState().sessions[routingId].worktreeInfo).toBeNull()
      expect(useSessionStore.getState().worktreeInfoMap[routingId]).toBeUndefined()
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
