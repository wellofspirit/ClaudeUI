import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { TestIpcBridge } from '@test/bridges/test-ipc-bridge'
import { useSessionStore } from '../../stores/session-store'
import {
  makeChatMessage,
  makeAssistantMessage,
  makeToolUseBlock,
  makeSessionStatus,
  makeTodoItem,
  makeTaskNotification,
  resetFactoryCounter,
} from '@test/factories/messages'
import type {
  ChatMessage,
  TaskProgress,
  TaskNotification,
  StatusLineData,
  GitStatusData,
  AccountUsage,
  BlockUsageData,
  PluginViewWithOwner,
  VoiceState,
  WorktreeInfo,
  TeammateInfo,
} from '../../../../shared/types'

let bridge: TestIpcBridge
let cleanups: Array<() => void>

function onEvent<T extends (...args: never[]) => void>(channel: string): (cb: T) => () => void {
  return (cb: T) => {
    const handler = (_: unknown, ...args: unknown[]): void => (cb as Function)(...args)
    bridge.ipcRenderer.on(channel, handler)
    const cleanup = (): void => { bridge.ipcRenderer.removeListener(channel, handler) }
    cleanups.push(cleanup)
    return cleanup
  }
}

function wireEventHandlers(): void {
  const store = useSessionStore.getState

  onEvent<(routingId: string, data: TaskProgress) => void>('session:task-progress')((routingId, data) => {
    store().updateTaskProgress(routingId, data)
  })

  onEvent<(routingId: string, data: TaskNotification) => void>('session:task-notification')((routingId, data) => {
    store().addTaskNotification(routingId, data)
    if (data.toolUseId) {
      const s = store()
      const session = s.sessions[routingId]
      if (session?.teammates[data.toolUseId]) {
        const statusMap: Record<string, 'completed' | 'failed' | 'stopped'> = {
          completed: 'completed', failed: 'failed', stopped: 'stopped'
        }
        s.updateTeammateStatus(routingId, data.toolUseId, statusMap[data.status] || 'completed')
      }
    }
  })

  onEvent<(routingId: string, data: Omit<TeammateInfo, 'status'>) => void>('session:teammate-detected')((routingId, data) => {
    store().addTeammate(routingId, { ...data, status: 'running' })
  })

  onEvent<(routingId: string, data: { toolUseId: string; message: ChatMessage }) => void>('session:subagent-message')((routingId, data) => {
    store().addSubagentMessage(routingId, data.toolUseId, data.message)
  })

  onEvent<(routingId: string, data: { toolUseId: string; messages: ChatMessage[] }) => void>('session:subagent-message-batch')((routingId, data) => {
    store().appendSubagentMessageBatch(routingId, data.toolUseId, data.messages)
  })

  onEvent<(routingId: string, data: { toolUseId: string; toolResultToolUseId: string; result: string; isError: boolean }) => void>('session:subagent-tool-result')((routingId, data) => {
    store().appendSubagentToolResult(routingId, data.toolUseId, data.toolResultToolUseId, data.result, data.isError)
  })

  onEvent<(routingId: string, data: { toolUseId: string; output: string; totalLines: number; totalBytes: number }) => void>('session:bash-output')((routingId, data) => {
    store().setBashOutput(routingId, data.toolUseId, data.output, data.totalLines, data.totalBytes)
  })

  onEvent<(routingId: string, data: { toolUseId: string; tail: string; totalSize: number }) => void>('session:background-output')((routingId, data) => {
    store().setBackgroundOutput(routingId, data.toolUseId, data.tail, data.totalSize)
  })

  onEvent<(routingId: string, data: StatusLineData) => void>('session:status-line')((routingId, data) => {
    store().setStatusLine(routingId, data)
  })

  onEvent<(routingId: string, commands: unknown[]) => void>('session:slash-commands')((_routingId, commands) => {
    store().setSlashCommands(commands as never)
    window.api.saveSlashCommands(commands as never)
  })

  onEvent<(routingId: string, names: string[]) => void>('session:skills')((_routingId, names) => {
    store().setSdkSkillNames(names)
  })

  onEvent<(routingId: string, message: string) => void>('session:sandbox-violation')((routingId, message) => {
    store().addSandboxViolation(routingId, message)
  })

  onEvent<(routingId: string) => void>('session:steer-consumed')((routingId) => {
    store().consumeQueuedText(routingId)
  })

  onEvent<(data: { routingId: string; messages: ChatMessage[]; taskNotifications: TaskNotification[]; statusLine?: StatusLineData }) => void>('session:watch-update')((data) => {
    const { routingId, messages, taskNotifications, statusLine } = data
    store().updateWatchedSession(routingId, messages, taskNotifications)
    if (statusLine) store().setStatusLine(routingId, statusLine)
    const { sessions, setTodos } = store()
    const session = sessions[routingId]
    if (session && session.todos.length > 0) {
      const allDone = session.todos.every((t) => t.status === 'completed')
      if (allDone) setTodos(routingId, [])
    }
  })

  onEvent<(data: { cwd: string; status: GitStatusData }) => void>('git:status-update')((data) => {
    const { cwd, status } = data
    const s = store()
    for (const [routingId, session] of Object.entries(s.sessions)) {
      if (session.cwd === cwd) {
        s.setGitStatus(routingId, status)
      }
    }
  })

  onEvent<(settings: Record<string, unknown>) => void>('config:settings-changed')((settings) => {
    store().applyExternalSettings(settings)
  })

  onEvent<(config: { recentSessions?: string[]; pinnedSessions?: string[]; customTitles?: Record<string, string>; worktreeInfoMap?: Record<string, WorktreeInfo> }) => void>('config:sessions-changed')((config) => {
    store().applyExternalSessionConfig(config)
  })

  onEvent<(data: AccountUsage) => void>('usage:data')((data) => {
    store().setAccountUsage(data)
  })

  onEvent<(data: BlockUsageData) => void>('usage:block-data')((data) => {
    store().setBlockUsage(data)
  })

  onEvent<() => void>('app:before-quit')(() => {
    const s = store()
    const activeWorktrees = Object.entries(s.worktreeInfoMap)
      .map(([routingId, worktreeInfo]) => ({ routingId, worktreeInfo }))
    if (activeWorktrees.length === 0) {
      window.api.confirmQuit()
    } else {
      s.setQuitWorktrees(activeWorktrees)
    }
  })

  onEvent<(routingId: string, data: { text: string; isFinal: boolean }) => void>('voice:transcript')((routingId, data) => {
    store().appendVoiceTranscript(routingId, data.text, data.isFinal)
  })

  onEvent<(routingId: string, state: VoiceState) => void>('voice:state')((routingId, state) => {
    store().setVoiceState(routingId, state)
  })

  onEvent<(routingId: string, error: string) => void>('voice:error')((routingId, error) => {
    store().addError(routingId, error)
  })

  onEvent<(views: PluginViewWithOwner[]) => void>('plugin:views-changed')((views) => {
    store().setPluginViews(views)
  })

  onEvent<(routingId: string, status: import('../../../../shared/types').SessionStatus) => void>('session:status')((routingId, status) => {
    let effectiveRoutingId = routingId
    if (status.sessionId && status.sessionId !== routingId) {
      const s = store()
      if (s.sessions[routingId]) {
        s.rekeySession(routingId, status.sessionId)
        effectiveRoutingId = status.sessionId
      }
    }

    if (status.state === 'disconnected') {
      store().markSdkInactive(effectiveRoutingId)
      store().setStatus(effectiveRoutingId, { ...status, state: 'idle' })
      store().clearPendingApprovals(effectiveRoutingId)
      return
    }
    store().setStatus(effectiveRoutingId, status)
    if (status.state === 'idle') {
      store().clearPendingApprovals(effectiveRoutingId)
    }
    if (status.state === 'running') {
      store().setNeedsAttention(effectiveRoutingId, false)
    }
    if (status.cwd) {
      const s = store()
      const session = s.sessions[effectiveRoutingId]
      if (session?.worktreeInfo && status.cwd === session.worktreeInfo.originalCwd) {
        s.clearWorktreeInfo(effectiveRoutingId)
      }
    }
  })

  onEvent<(routingId: string, data: { toolUseId: string; result: string; isError: boolean }) => void>('session:tool-result')((routingId, { toolUseId, result, isError }) => {
    store().appendToolResult(routingId, toolUseId, result, isError)

    if (!isError && result) {
      const s = store()
      const session = s.sessions[routingId]
      if (session && !session.worktreeInfo) {
        for (const msg of session.messages) {
          const toolBlock = msg.content.find(
            (b) => b.type === 'tool_use' && b.toolUseId === toolUseId
          )
          if (toolBlock && toolBlock.type === 'tool_use' && /worktree/i.test(toolBlock.toolName)) {
            const naturalMatch = result.match(/worktree at (.+?) on branch ([\w-]+)/)
            const pathMatch = naturalMatch?.[1] || result.match(/worktreePath:\s*(.+?)(?:\n|$)/i)?.[1]
            const branchMatch = naturalMatch?.[2] || result.match(/worktreeBranch:\s*(.+?)(?:\n|$)/i)?.[1]
            if (pathMatch && branchMatch) {
              const wtPath = pathMatch.trim()
              const wtBranch = branchMatch.trim()
              const wtName = wtPath.split('/').pop() || wtBranch.replace(/^worktree-/, '')
              s.setWorktreeInfo(routingId, {
                worktreePath: wtPath,
                worktreeBranch: wtBranch,
                worktreeName: wtName,
                originalCwd: session.cwd,
                gitRoot: session.cwd,
                originalHeadCommit: '',
                createdAt: Date.now()
              })
            }
            break
          }
        }
      }
    }
  })
}

beforeEach(() => {
  bridge = new TestIpcBridge()
  cleanups = []
  resetFactoryCounter()

  ;(globalThis as never as { window: unknown }).window = (globalThis as never as { window: unknown }).window || {}
  ;(globalThis as never as { window: { api: unknown } }).window.api = {
    saveSessionConfig: () => {},
    saveSlashCommands: vi.fn(),
    logError: () => {},
    fetchAccountUsage: () => Promise.resolve(null),
    fetchBlockUsage: () => Promise.resolve(null),
    getPluginViews: () => Promise.resolve([]),
    confirmQuit: vi.fn(),
    watchBackground: () => {},
    unwatchBackground: () => {},
    rekeySession: () => {},
  }

  useSessionStore.setState({
    activeSessionId: null,
    sessions: {},
    directories: [],
    recentSessionIds: [],
    pinnedSessionIds: [],
    customTitles: {},
    worktreeInfoMap: {},
  })

  wireEventHandlers()
})

afterEach(() => {
  cleanups.forEach((fn) => fn())
  bridge.reset()
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
        elapsedTimeSeconds: 5,
      }

      bridge.webContents.send('session:task-progress', routingId, progress)

      const session = useSessionStore.getState().sessions[routingId]
      expect(session.taskProgressMap['tool-a']).toEqual(progress)
    })

    it('updates existing task progress entry on second event', () => {
      const routingId = 'route-1'
      useSessionStore.getState().createNewSession(routingId, '/test')

      bridge.webContents.send('session:task-progress', routingId, {
        toolUseId: 'tool-a', toolName: 'Task', parentToolUseId: null, elapsedTimeSeconds: 3,
      })
      bridge.webContents.send('session:task-progress', routingId, {
        toolUseId: 'tool-a', toolName: 'Task', parentToolUseId: null, elapsedTimeSeconds: 10,
      })

      const session = useSessionStore.getState().sessions[routingId]
      expect(session.taskProgressMap['tool-a'].elapsedTimeSeconds).toBe(10)
    })

    it('stores multiple tasks independently by toolUseId', () => {
      const routingId = 'route-1'
      useSessionStore.getState().createNewSession(routingId, '/test')

      bridge.webContents.send('session:task-progress', routingId, {
        toolUseId: 'tool-a', toolName: 'Task', parentToolUseId: null, elapsedTimeSeconds: 1,
      })
      bridge.webContents.send('session:task-progress', routingId, {
        toolUseId: 'tool-b', toolName: 'Task', parentToolUseId: 'tool-a', elapsedTimeSeconds: 2,
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
      bridge.webContents.send('session:task-notification', routingId, notification)

      const session = useSessionStore.getState().sessions[routingId]
      expect(session.taskNotifications).toHaveLength(1)
      expect(session.taskNotifications[0].taskId).toBe(notification.taskId)
    })

    it('updates teammate status to completed when toolUseId matches a teammate', () => {
      const routingId = 'route-1'
      useSessionStore.getState().createNewSession(routingId, '/test')
      useSessionStore.getState().addTeammate(routingId, {
        toolUseId: 'agent-tool-1',
        name: 'Worker',
        sanitizedName: 'Worker',
        teamName: 'my-team',
        sanitizedTeamName: 'my-team',
        agentId: 'agent-1',
        status: 'running',
      })

      const notification = makeTaskNotification({ toolUseId: 'agent-tool-1', status: 'completed' })
      bridge.webContents.send('session:task-notification', routingId, notification)

      const session = useSessionStore.getState().sessions[routingId]
      expect(session.teammates['agent-tool-1'].status).toBe('completed')
    })

    it('maps failed status to failed on teammate', () => {
      const routingId = 'route-1'
      useSessionStore.getState().createNewSession(routingId, '/test')
      useSessionStore.getState().addTeammate(routingId, {
        toolUseId: 'agent-tool-2',
        name: 'Worker',
        sanitizedName: 'Worker',
        teamName: 'team',
        sanitizedTeamName: 'team',
        agentId: 'agent-2',
        status: 'running',
      })

      bridge.webContents.send('session:task-notification', routingId, makeTaskNotification({
        toolUseId: 'agent-tool-2', status: 'failed',
      }))

      expect(useSessionStore.getState().sessions[routingId].teammates['agent-tool-2'].status).toBe('failed')
    })

    it('maps stopped status to stopped on teammate', () => {
      const routingId = 'route-1'
      useSessionStore.getState().createNewSession(routingId, '/test')
      useSessionStore.getState().addTeammate(routingId, {
        toolUseId: 'agent-tool-3',
        name: 'Worker',
        sanitizedName: 'Worker',
        teamName: 'team',
        sanitizedTeamName: 'team',
        agentId: 'agent-3',
        status: 'running',
      })

      bridge.webContents.send('session:task-notification', routingId, makeTaskNotification({
        toolUseId: 'agent-tool-3', status: 'stopped',
      }))

      expect(useSessionStore.getState().sessions[routingId].teammates['agent-tool-3'].status).toBe('stopped')
    })

    it('does not crash when toolUseId is null', () => {
      const routingId = 'route-1'
      useSessionStore.getState().createNewSession(routingId, '/test')

      bridge.webContents.send('session:task-notification', routingId, makeTaskNotification({ toolUseId: null }))

      const session = useSessionStore.getState().sessions[routingId]
      expect(session.taskNotifications).toHaveLength(1)
    })

    it('does not update teammate status when toolUseId does not match any teammate', () => {
      const routingId = 'route-1'
      useSessionStore.getState().createNewSession(routingId, '/test')
      useSessionStore.getState().addTeammate(routingId, {
        toolUseId: 'different-id',
        name: 'Worker',
        sanitizedName: 'Worker',
        teamName: 'team',
        sanitizedTeamName: 'team',
        agentId: 'agent-x',
        status: 'running',
      })

      bridge.webContents.send('session:task-notification', routingId, makeTaskNotification({
        toolUseId: 'no-match-id', status: 'completed',
      }))

      expect(useSessionStore.getState().sessions[routingId].teammates['different-id'].status).toBe('running')
    })
  })

  describe('session:teammate-detected', () => {
    it('adds teammate with running status', () => {
      const routingId = 'route-1'
      useSessionStore.getState().createNewSession(routingId, '/test')

      bridge.webContents.send('session:teammate-detected', routingId, {
        toolUseId: 'agent-tool-1',
        name: 'SubAgent',
        sanitizedName: 'SubAgent',
        teamName: 'alpha-team',
        sanitizedTeamName: 'alpha-team',
        agentId: 'agent-abc',
      })

      const session = useSessionStore.getState().sessions[routingId]
      expect(session.teammates['agent-tool-1']).toBeDefined()
      expect(session.teammates['agent-tool-1'].status).toBe('running')
      expect(session.teammates['agent-tool-1'].name).toBe('SubAgent')
    })

    it('always sets status to running regardless of source data', () => {
      const routingId = 'route-1'
      useSessionStore.getState().createNewSession(routingId, '/test')

      bridge.webContents.send('session:teammate-detected', routingId, {
        toolUseId: 'agent-tool-5',
        name: 'AnotherAgent',
        sanitizedName: 'AnotherAgent',
        teamName: 'beta-team',
        sanitizedTeamName: 'beta-team',
        agentId: 'agent-xyz',
      })

      expect(useSessionStore.getState().sessions[routingId].teammates['agent-tool-5'].status).toBe('running')
    })

    it('adds multiple teammates independently', () => {
      const routingId = 'route-1'
      useSessionStore.getState().createNewSession(routingId, '/test')

      bridge.webContents.send('session:teammate-detected', routingId, {
        toolUseId: 'tool-1', name: 'Agent1', sanitizedName: 'Agent1',
        teamName: 'team', sanitizedTeamName: 'team', agentId: 'a1',
      })
      bridge.webContents.send('session:teammate-detected', routingId, {
        toolUseId: 'tool-2', name: 'Agent2', sanitizedName: 'Agent2',
        teamName: 'team', sanitizedTeamName: 'team', agentId: 'a2',
      })

      const session = useSessionStore.getState().sessions[routingId]
      expect(Object.keys(session.teammates)).toHaveLength(2)
    })
  })

  describe('session:subagent-message', () => {
    it('adds subagent message to the correct toolUseId slot', () => {
      const routingId = 'route-1'
      useSessionStore.getState().createNewSession(routingId, '/test')

      const message = makeAssistantMessage('subagent says hi')
      bridge.webContents.send('session:subagent-message', routingId, {
        toolUseId: 'agent-1',
        message,
      })

      const session = useSessionStore.getState().sessions[routingId]
      expect(session.subagentMessages['agent-1']).toHaveLength(1)
      expect(session.subagentMessages['agent-1'][0].content[0]).toEqual({ type: 'text', text: 'subagent says hi' })
    })

    it('upserts subagent message with same ID', () => {
      const routingId = 'route-1'
      useSessionStore.getState().createNewSession(routingId, '/test')

      const msg1 = makeChatMessage({ id: 'sub-msg-1', content: [{ type: 'text', text: 'partial' }] })
      const msg2 = makeChatMessage({ id: 'sub-msg-1', content: [{ type: 'text', text: 'complete' }] })

      bridge.webContents.send('session:subagent-message', routingId, { toolUseId: 'agent-1', message: msg1 })
      bridge.webContents.send('session:subagent-message', routingId, { toolUseId: 'agent-1', message: msg2 })

      const session = useSessionStore.getState().sessions[routingId]
      expect(session.subagentMessages['agent-1']).toHaveLength(1)
    })

    it('keeps subagent messages isolated per toolUseId', () => {
      const routingId = 'route-1'
      useSessionStore.getState().createNewSession(routingId, '/test')

      bridge.webContents.send('session:subagent-message', routingId, {
        toolUseId: 'agent-1', message: makeAssistantMessage('from agent 1'),
      })
      bridge.webContents.send('session:subagent-message', routingId, {
        toolUseId: 'agent-2', message: makeAssistantMessage('from agent 2'),
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
        makeAssistantMessage('batch msg 3'),
      ]

      bridge.webContents.send('session:subagent-message-batch', routingId, {
        toolUseId: 'agent-1',
        messages,
      })

      const session = useSessionStore.getState().sessions[routingId]
      expect(session.subagentMessages['agent-1']).toHaveLength(3)
    })

    it('merges batch messages with existing messages by ID', () => {
      const routingId = 'route-1'
      useSessionStore.getState().createNewSession(routingId, '/test')

      const existing = makeChatMessage({ id: 'sub-1', content: [{ type: 'text', text: 'old' }] })
      bridge.webContents.send('session:subagent-message', routingId, { toolUseId: 'agent-1', message: existing })

      const updated = makeChatMessage({ id: 'sub-1', content: [{ type: 'text', text: 'updated' }] })
      const fresh = makeAssistantMessage('new message')
      bridge.webContents.send('session:subagent-message-batch', routingId, {
        toolUseId: 'agent-1',
        messages: [updated, fresh],
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
        content: [makeToolUseBlock('Bash', { command: 'ls' }, 'sub-tool-1')],
      })
      bridge.webContents.send('session:subagent-message', routingId, { toolUseId: 'agent-1', message: toolMsg })

      bridge.webContents.send('session:subagent-tool-result', routingId, {
        toolUseId: 'agent-1',
        toolResultToolUseId: 'sub-tool-1',
        result: 'file1.txt',
        isError: false,
      })

      const session = useSessionStore.getState().sessions[routingId]
      const msgs = session.subagentMessages['agent-1']
      const resultBlock = msgs.flatMap((m) => m.content).find((b) => b.type === 'tool_result')
      expect(resultBlock).toBeDefined()
    })

    it('handles error tool results', () => {
      const routingId = 'route-1'
      useSessionStore.getState().createNewSession(routingId, '/test')

      bridge.webContents.send('session:subagent-tool-result', routingId, {
        toolUseId: 'agent-1',
        toolResultToolUseId: 'nonexistent-tool',
        result: 'error output',
        isError: true,
      })

      const session = useSessionStore.getState().sessions[routingId]
      expect(session).toBeDefined()
    })
  })

  describe('session:bash-output', () => {
    it('stores bash output with line and byte counts', () => {
      const routingId = 'route-1'
      useSessionStore.getState().createNewSession(routingId, '/test')

      bridge.webContents.send('session:bash-output', routingId, {
        toolUseId: 'bash-tool-1',
        output: 'Hello\nWorld\n',
        totalLines: 2,
        totalBytes: 12,
      })

      const session = useSessionStore.getState().sessions[routingId]
      expect(session.bashOutputs['bash-tool-1']).toEqual({
        output: 'Hello\nWorld\n',
        totalLines: 2,
        totalBytes: 12,
      })
    })

    it('overwrites previous output for the same toolUseId', () => {
      const routingId = 'route-1'
      useSessionStore.getState().createNewSession(routingId, '/test')

      bridge.webContents.send('session:bash-output', routingId, {
        toolUseId: 'bash-tool-1', output: 'old output', totalLines: 1, totalBytes: 10,
      })
      bridge.webContents.send('session:bash-output', routingId, {
        toolUseId: 'bash-tool-1', output: 'new output', totalLines: 1, totalBytes: 10,
      })

      expect(useSessionStore.getState().sessions[routingId].bashOutputs['bash-tool-1'].output).toBe('new output')
    })

    it('stores outputs for different toolUseIds independently', () => {
      const routingId = 'route-1'
      useSessionStore.getState().createNewSession(routingId, '/test')

      bridge.webContents.send('session:bash-output', routingId, {
        toolUseId: 'bash-1', output: 'output A', totalLines: 1, totalBytes: 8,
      })
      bridge.webContents.send('session:bash-output', routingId, {
        toolUseId: 'bash-2', output: 'output B', totalLines: 1, totalBytes: 8,
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

      bridge.webContents.send('session:background-output', routingId, {
        toolUseId: 'bg-tool-1',
        tail: 'last few lines',
        totalSize: 1024,
      })

      const session = useSessionStore.getState().sessions[routingId]
      expect(session.backgroundOutputs['bg-tool-1']).toEqual({
        tail: 'last few lines',
        totalSize: 1024,
      })
    })

    it('updates background output on subsequent events', () => {
      const routingId = 'route-1'
      useSessionStore.getState().createNewSession(routingId, '/test')

      bridge.webContents.send('session:background-output', routingId, {
        toolUseId: 'bg-tool-1', tail: 'old tail', totalSize: 500,
      })
      bridge.webContents.send('session:background-output', routingId, {
        toolUseId: 'bg-tool-1', tail: 'new tail', totalSize: 1000,
      })

      expect(useSessionStore.getState().sessions[routingId].backgroundOutputs['bg-tool-1'].tail).toBe('new tail')
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
        remainingPercentage: 99.25,
      }

      bridge.webContents.send('session:status-line', routingId, statusLine)

      expect(useSessionStore.getState().sessions[routingId].statusLine).toEqual(statusLine)
    })

    it('replaces previous status line on update', () => {
      const routingId = 'route-1'
      useSessionStore.getState().createNewSession(routingId, '/test')

      const first: StatusLineData = {
        totalCostUsd: 0.01, totalDurationMs: 1000, totalApiDurationMs: 800,
        totalInputTokens: 100, totalOutputTokens: 50, cachedTokens: 0,
        totalTokens: 150, contextWindowSize: 200000, usedPercentage: 0.1, remainingPercentage: 99.9,
      }
      const second: StatusLineData = { ...first, totalCostUsd: 0.10, totalTokens: 5000 }

      bridge.webContents.send('session:status-line', routingId, first)
      bridge.webContents.send('session:status-line', routingId, second)

      expect(useSessionStore.getState().sessions[routingId].statusLine?.totalCostUsd).toBe(0.10)
    })
  })

  describe('session:slash-commands', () => {
    it('updates slashCommands in store', () => {
      const commands = [
        { name: 'review', description: 'Review code', content: 'Please review' },
        { name: 'test', description: 'Run tests', content: 'Run the tests' },
      ]

      bridge.webContents.send('session:slash-commands', 'ignored', commands)

      expect(useSessionStore.getState().slashCommands).toEqual(commands)
    })

    it('calls window.api.saveSlashCommands with the received commands', () => {
      const commands = [{ name: 'deploy', description: 'Deploy', content: 'Deploy to prod' }]

      bridge.webContents.send('session:slash-commands', 'ignored', commands)

      expect((window.api.saveSlashCommands as ReturnType<typeof vi.fn>)).toHaveBeenCalledWith(commands)
    })

    it('replaces slash commands on subsequent event', () => {
      bridge.webContents.send('session:slash-commands', 'ignored', [
        { name: 'old-cmd', description: 'old', content: 'old' },
      ])
      bridge.webContents.send('session:slash-commands', 'ignored', [
        { name: 'new-cmd', description: 'new', content: 'new' },
      ])

      const { slashCommands } = useSessionStore.getState()
      expect(slashCommands).toHaveLength(1)
      expect(slashCommands[0].name).toBe('new-cmd')
    })
  })

  describe('session:skills', () => {
    it('updates sdkSkillNames in store', () => {
      bridge.webContents.send('session:skills', 'ignored', ['bundle-analyzer', 'patch-readme'])

      expect(useSessionStore.getState().sdkSkillNames).toEqual(['bundle-analyzer', 'patch-readme'])
    })

    it('replaces previous skill names on update', () => {
      bridge.webContents.send('session:skills', 'ignored', ['skill-a', 'skill-b'])
      bridge.webContents.send('session:skills', 'ignored', ['skill-c'])

      expect(useSessionStore.getState().sdkSkillNames).toEqual(['skill-c'])
    })

    it('sets empty array when no skills provided', () => {
      bridge.webContents.send('session:skills', 'ignored', ['skill-a'])
      bridge.webContents.send('session:skills', 'ignored', [])

      expect(useSessionStore.getState().sdkSkillNames).toEqual([])
    })
  })

  describe('session:sandbox-violation', () => {
    it('adds sandbox violation message to session', () => {
      const routingId = 'route-1'
      useSessionStore.getState().createNewSession(routingId, '/test')

      bridge.webContents.send('session:sandbox-violation', routingId, 'Network access denied to example.com')

      const session = useSessionStore.getState().sessions[routingId]
      expect(session.sandboxViolations).toContain('Network access denied to example.com')
    })

    it('accumulates multiple sandbox violations', () => {
      const routingId = 'route-1'
      useSessionStore.getState().createNewSession(routingId, '/test')

      bridge.webContents.send('session:sandbox-violation', routingId, 'violation 1')
      bridge.webContents.send('session:sandbox-violation', routingId, 'violation 2')

      expect(useSessionStore.getState().sessions[routingId].sandboxViolations).toHaveLength(2)
    })
  })

  describe('session:steer-consumed', () => {
    it('converts queuedText to a user message and clears queuedText', () => {
      const routingId = 'route-1'
      useSessionStore.getState().createNewSession(routingId, '/test')
      useSessionStore.getState().setQueuedText(routingId, 'steered command')

      bridge.webContents.send('session:steer-consumed', routingId)

      const session = useSessionStore.getState().sessions[routingId]
      expect(session.queuedText).toBe('')
      const lastMsg = session.messages[session.messages.length - 1]
      expect(lastMsg.role).toBe('user')
      expect(lastMsg.content[0]).toEqual({ type: 'text', text: 'steered command' })
    })

    it('does nothing when queuedText is empty', () => {
      const routingId = 'route-1'
      useSessionStore.getState().createNewSession(routingId, '/test')

      bridge.webContents.send('session:steer-consumed', routingId)

      const session = useSessionStore.getState().sessions[routingId]
      expect(session.messages).toHaveLength(0)
      expect(session.queuedText).toBe('')
    })

    it('does nothing for unknown session', () => {
      bridge.webContents.send('session:steer-consumed', 'nonexistent')

      expect(useSessionStore.getState().sessions['nonexistent']).toBeUndefined()
    })
  })

  describe('session:watch-update', () => {
    it('replaces session messages and taskNotifications', () => {
      const routingId = 'route-1'
      useSessionStore.getState().createNewSession(routingId, '/test')
      useSessionStore.getState().addMessage(routingId, makeAssistantMessage('old message'))

      const newMessages = [makeAssistantMessage('new message')]
      const newNotifications = [makeTaskNotification()]

      bridge.webContents.send('session:watch-update', {
        routingId,
        messages: newMessages,
        taskNotifications: newNotifications,
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
        totalCostUsd: 0.02, totalDurationMs: 1000, totalApiDurationMs: 900,
        totalInputTokens: 200, totalOutputTokens: 100, cachedTokens: 50,
        totalTokens: 300, contextWindowSize: 200000, usedPercentage: 0.15, remainingPercentage: 99.85,
      }

      bridge.webContents.send('session:watch-update', {
        routingId,
        messages: [],
        taskNotifications: [],
        statusLine,
      })

      expect(useSessionStore.getState().sessions[routingId].statusLine).toEqual(statusLine)
    })

    it('does not set statusLine when not provided in watch update', () => {
      const routingId = 'route-1'
      useSessionStore.getState().createNewSession(routingId, '/test')

      bridge.webContents.send('session:watch-update', {
        routingId,
        messages: [],
        taskNotifications: [],
      })

      expect(useSessionStore.getState().sessions[routingId].statusLine).toBeNull()
    })

    it('dismisses all-completed todos on watch update', () => {
      const routingId = 'route-1'
      useSessionStore.getState().createNewSession(routingId, '/test')
      useSessionStore.getState().setTodos(routingId, [
        makeTodoItem('Done 1', 'completed'),
        makeTodoItem('Done 2', 'completed'),
      ])

      bridge.webContents.send('session:watch-update', {
        routingId, messages: [], taskNotifications: [],
      })

      expect(useSessionStore.getState().sessions[routingId].todos).toHaveLength(0)
    })

    it('keeps todos when not all completed on watch update', () => {
      const routingId = 'route-1'
      useSessionStore.getState().createNewSession(routingId, '/test')
      useSessionStore.getState().setTodos(routingId, [
        makeTodoItem('Done', 'completed'),
        makeTodoItem('Pending', 'pending'),
      ])

      bridge.webContents.send('session:watch-update', {
        routingId, messages: [], taskNotifications: [],
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
        linesRemoved: 0,
      }

      bridge.webContents.send('git:status-update', { cwd: '/project/app', status })

      expect(useSessionStore.getState().sessions[routingId].gitStatus).toEqual(status)
    })

    it('does not update sessions with a different cwd', () => {
      useSessionStore.getState().createNewSession('route-1', '/project/app')
      useSessionStore.getState().createNewSession('route-2', '/other/project')

      const status: GitStatusData = {
        branch: 'main', files: [], ahead: 0, behind: 0, trackingBranch: null,
        staged: [], unstaged: [], untracked: [], linesAdded: 0, linesRemoved: 0,
      }

      bridge.webContents.send('git:status-update', { cwd: '/project/app', status })

      expect(useSessionStore.getState().sessions['route-1'].gitStatus).toEqual(status)
      expect(useSessionStore.getState().sessions['route-2'].gitStatus).toBeNull()
    })

    it('updates all sessions that share the same cwd', () => {
      useSessionStore.getState().createNewSession('route-1', '/shared/project')
      useSessionStore.getState().createNewSession('route-2', '/shared/project')

      const status: GitStatusData = {
        branch: 'feature', files: [], ahead: 1, behind: 0, trackingBranch: null,
        staged: [], unstaged: [], untracked: [], linesAdded: 0, linesRemoved: 0,
      }

      bridge.webContents.send('git:status-update', { cwd: '/shared/project', status })

      expect(useSessionStore.getState().sessions['route-1'].gitStatus?.branch).toBe('feature')
      expect(useSessionStore.getState().sessions['route-2'].gitStatus?.branch).toBe('feature')
    })
  })

  describe('config:settings-changed', () => {
    it('applies external settings to store', () => {
      bridge.webContents.send('config:settings-changed', { theme: 'light', expandToolCalls: false })

      expect(useSessionStore.getState().settings.theme).toBe('light')
      expect(useSessionStore.getState().settings.expandToolCalls).toBe(false)
    })

    it('merges with defaults for partial settings update', () => {
      bridge.webContents.send('config:settings-changed', { theme: 'monokai' })

      const settings = useSessionStore.getState().settings
      expect(settings.theme).toBe('monokai')
      expect(typeof settings.expandToolCalls).toBe('boolean')
    })
  })

  describe('config:sessions-changed', () => {
    it('applies external session config with recentSessions', () => {
      bridge.webContents.send('config:sessions-changed', {
        recentSessions: ['session-a', 'session-b'],
        pinnedSessions: ['session-a'],
        customTitles: { 'session-a': 'My Session' },
      })

      const state = useSessionStore.getState()
      expect(state.recentSessionIds).toEqual(['session-a', 'session-b'])
      expect(state.pinnedSessionIds).toEqual(['session-a'])
      expect(state.customTitles['session-a']).toBe('My Session')
    })

    it('handles empty config object gracefully', () => {
      bridge.webContents.send('config:sessions-changed', {})

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
          resetsAt: new Date(Date.now() + 3600000).toISOString(),
          
        },
        sevenDay: null,
        sevenDaySonnet: null,
        sevenDayOpus: null,
        extraUsage: null,
        planName: 'claude_max_5x',
        fetchedAt: Date.now(),
        error: null,
      }

      bridge.webContents.send('usage:data', usageData)

      expect(useSessionStore.getState().accountUsage).toEqual(usageData)
    })

    it('replaces previous account usage on update', () => {
      const first: AccountUsage = {
        fiveHour: { usedPercent: 10, resetsAt: null },
        sevenDay: null, sevenDaySonnet: null, sevenDayOpus: null,
        extraUsage: null, planName: null, fetchedAt: Date.now(), error: null,
      }
      const second: AccountUsage = { ...first, fiveHour: { usedPercent: 90, resetsAt: null } }

      bridge.webContents.send('usage:data', first)
      bridge.webContents.send('usage:data', second)

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
      }

      bridge.webContents.send('usage:block-data', blockData)

      expect(useSessionStore.getState().blockUsage).toEqual(blockData)
    })

    it('replaces previous block usage on update', () => {
      const first: BlockUsageData = {
        currentBlock: null, recentBlocks: [], todaySnapshots: [], dailyHistory: [],
      }
      const second: BlockUsageData = {
        currentBlock: null, recentBlocks: [], todaySnapshots: [],
        dailyHistory: [{ date: '2026-04-15', totalTokens: 5000, costUsd: 0.5, models: {}, peakApiPercent: 30, blockCount: 1 }],
      }

      bridge.webContents.send('usage:block-data', first)
      bridge.webContents.send('usage:block-data', second)

      expect(useSessionStore.getState().blockUsage?.dailyHistory).toHaveLength(1)
    })
  })

  describe('app:before-quit', () => {
    it('calls confirmQuit when no active worktrees', () => {
      useSessionStore.setState({ worktreeInfoMap: {} })

      bridge.webContents.send('app:before-quit')

      expect((window.api.confirmQuit as ReturnType<typeof vi.fn>)).toHaveBeenCalledOnce()
    })

    it('calls setQuitWorktrees with active worktrees instead of confirming quit', () => {
      const worktreeInfo: WorktreeInfo = {
        worktreePath: '/project/worktrees/feature-x',
        worktreeBranch: 'feature-x',
        worktreeName: 'feature-x',
        originalCwd: '/project',
        gitRoot: '/project',
        originalHeadCommit: 'abc123',
        createdAt: Date.now(),
      }

      useSessionStore.setState({
        worktreeInfoMap: { 'route-1': worktreeInfo },
      })

      bridge.webContents.send('app:before-quit')

      expect((window.api.confirmQuit as ReturnType<typeof vi.fn>)).not.toHaveBeenCalled()
      const state = useSessionStore.getState()
      expect(state.quitWorktrees).toHaveLength(1)
      expect(state.quitWorktrees![0].routingId).toBe('route-1')
    })

    it('calls confirmQuit after all worktrees are removed', () => {
      useSessionStore.setState({ worktreeInfoMap: {} })

      bridge.webContents.send('app:before-quit')

      expect((window.api.confirmQuit as ReturnType<typeof vi.fn>)).toHaveBeenCalledOnce()
    })
  })

  describe('voice:transcript', () => {
    it('updates voiceInterimTranscript for non-final transcript', () => {
      const routingId = 'route-1'
      useSessionStore.getState().createNewSession(routingId, '/test')

      bridge.webContents.send('voice:transcript', routingId, { text: 'hello wor', isFinal: false })

      expect(useSessionStore.getState().sessions[routingId].voiceInterimTranscript).toBe('hello wor')
    })

    it('appends to draftText and clears interim for final transcript', () => {
      const routingId = 'route-1'
      useSessionStore.getState().createNewSession(routingId, '/test')

      bridge.webContents.send('voice:transcript', routingId, { text: 'hello world', isFinal: true })

      const session = useSessionStore.getState().sessions[routingId]
      expect(session.draftText).toBe('hello world')
      expect(session.voiceInterimTranscript).toBe('')
    })

    it('appends with space separator when draftText is non-empty', () => {
      const routingId = 'route-1'
      useSessionStore.getState().createNewSession(routingId, '/test')
      useSessionStore.getState().setDraftText('existing text')

      bridge.webContents.send('voice:transcript', routingId, { text: 'new sentence', isFinal: true })

      expect(useSessionStore.getState().sessions[routingId].draftText).toBe('existing text new sentence')
    })

    it('replaces interim transcript on each non-final event', () => {
      const routingId = 'route-1'
      useSessionStore.getState().createNewSession(routingId, '/test')

      bridge.webContents.send('voice:transcript', routingId, { text: 'hel', isFinal: false })
      bridge.webContents.send('voice:transcript', routingId, { text: 'hello', isFinal: false })
      bridge.webContents.send('voice:transcript', routingId, { text: 'hello wor', isFinal: false })

      expect(useSessionStore.getState().sessions[routingId].voiceInterimTranscript).toBe('hello wor')
    })
  })

  describe('voice:state', () => {
    it('sets voiceState on the session', () => {
      const routingId = 'route-1'
      useSessionStore.getState().createNewSession(routingId, '/test')

      bridge.webContents.send('voice:state', routingId, 'recording' as VoiceState)

      expect(useSessionStore.getState().sessions[routingId].voiceState).toBe('recording')
    })

    it('transitions through voice states correctly', () => {
      const routingId = 'route-1'
      useSessionStore.getState().createNewSession(routingId, '/test')

      bridge.webContents.send('voice:state', routingId, 'connecting' as VoiceState)
      expect(useSessionStore.getState().sessions[routingId].voiceState).toBe('connecting')

      bridge.webContents.send('voice:state', routingId, 'recording' as VoiceState)
      expect(useSessionStore.getState().sessions[routingId].voiceState).toBe('recording')

      bridge.webContents.send('voice:state', routingId, 'processing' as VoiceState)
      expect(useSessionStore.getState().sessions[routingId].voiceState).toBe('processing')

      bridge.webContents.send('voice:state', routingId, 'idle' as VoiceState)
      expect(useSessionStore.getState().sessions[routingId].voiceState).toBe('idle')
    })
  })

  describe('voice:error', () => {
    it('adds voice error to session errors array', () => {
      const routingId = 'route-1'
      useSessionStore.getState().createNewSession(routingId, '/test')

      bridge.webContents.send('voice:error', routingId, 'Microphone access denied')

      expect(useSessionStore.getState().sessions[routingId].errors).toContain('Microphone access denied')
    })

    it('accumulates multiple voice errors', () => {
      const routingId = 'route-1'
      useSessionStore.getState().createNewSession(routingId, '/test')

      bridge.webContents.send('voice:error', routingId, 'error 1')
      bridge.webContents.send('voice:error', routingId, 'error 2')

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
          htmlFile: 'index.html',
        },
      ]

      bridge.webContents.send('plugin:views-changed', views)

      expect(useSessionStore.getState().pluginViews).toEqual(views)
    })

    it('replaces previous plugin views on update', () => {
      bridge.webContents.send('plugin:views-changed', [
        { pluginId: 'plugin-a', id: 'view-a', label: 'View A', icon: 'a', htmlFile: 'a.html' },
      ])
      bridge.webContents.send('plugin:views-changed', [])

      expect(useSessionStore.getState().pluginViews).toHaveLength(0)
    })
  })

  describe('session:status running state', () => {
    it('clears needsAttention when status becomes running', () => {
      const routingId = 'route-1'
      useSessionStore.getState().createNewSession(routingId, '/test')
      useSessionStore.getState().setNeedsAttention(routingId, true)

      bridge.webContents.send('session:status', routingId, makeSessionStatus({
        state: 'running',
        sessionId: routingId,
      }))

      expect(useSessionStore.getState().sessions[routingId].needsAttention).toBe(false)
    })

    it('does not clear needsAttention when status becomes idle', () => {
      const routingId = 'route-1'
      useSessionStore.getState().createNewSession(routingId, '/test')
      useSessionStore.getState().setNeedsAttention(routingId, true)

      bridge.webContents.send('session:status', routingId, makeSessionStatus({
        state: 'idle',
        sessionId: routingId,
      }))

      expect(useSessionStore.getState().sessions[routingId].needsAttention).toBe(true)
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
        createdAt: Date.now(),
      })

      bridge.webContents.send('session:status', routingId, makeSessionStatus({
        state: 'idle',
        sessionId: routingId,
        cwd: '/project/app',
      }))

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
        createdAt: Date.now(),
      })

      bridge.webContents.send('session:status', routingId, makeSessionStatus({
        state: 'running',
        sessionId: routingId,
        cwd: '/project/worktrees/feat',
      }))

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
        createdAt: Date.now(),
      })

      bridge.webContents.send('session:status', routingId, makeSessionStatus({
        state: 'running',
        sessionId: routingId,
      }))

      expect(useSessionStore.getState().sessions[routingId].worktreeInfo).not.toBeNull()
    })
  })

  describe('session:tool-result worktree detection', () => {
    it('sets worktreeInfo when tool name matches /worktree/i and result has natural language format', () => {
      const routingId = 'route-1'
      useSessionStore.getState().createNewSession(routingId, '/project/app')

      const toolMsg = makeChatMessage({
        content: [makeToolUseBlock('EnterWorktree', {}, 'wt-tool-1')],
      })
      useSessionStore.getState().addMessage(routingId, toolMsg)

      bridge.webContents.send('session:tool-result', routingId, {
        toolUseId: 'wt-tool-1',
        result: 'Created worktree at /project/worktrees/my-branch on branch my-branch. Now working in that directory.',
        isError: false,
      })

      const session = useSessionStore.getState().sessions[routingId]
      expect(session.worktreeInfo).not.toBeNull()
      expect(session.worktreeInfo?.worktreePath).toBe('/project/worktrees/my-branch')
      expect(session.worktreeInfo?.worktreeBranch).toBe('my-branch')
    })

    it('does not set worktreeInfo when toolName does not match /worktree/i', () => {
      const routingId = 'route-1'
      useSessionStore.getState().createNewSession(routingId, '/project/app')

      const toolMsg = makeChatMessage({
        content: [makeToolUseBlock('Bash', { command: 'git worktree add' }, 'bash-tool-1')],
      })
      useSessionStore.getState().addMessage(routingId, toolMsg)

      bridge.webContents.send('session:tool-result', routingId, {
        toolUseId: 'bash-tool-1',
        result: 'Created worktree at /project/worktrees/feat on branch feat.',
        isError: false,
      })

      expect(useSessionStore.getState().sessions[routingId].worktreeInfo).toBeNull()
    })

    it('does not set worktreeInfo when result is an error', () => {
      const routingId = 'route-1'
      useSessionStore.getState().createNewSession(routingId, '/project/app')

      const toolMsg = makeChatMessage({
        content: [makeToolUseBlock('EnterWorktree', {}, 'wt-tool-err')],
      })
      useSessionStore.getState().addMessage(routingId, toolMsg)

      bridge.webContents.send('session:tool-result', routingId, {
        toolUseId: 'wt-tool-err',
        result: 'Failed to create worktree',
        isError: true,
      })

      expect(useSessionStore.getState().sessions[routingId].worktreeInfo).toBeNull()
    })

    it('does not overwrite existing worktreeInfo', () => {
      const routingId = 'route-1'
      useSessionStore.getState().createNewSession(routingId, '/project/app')
      const existingInfo: WorktreeInfo = {
        worktreePath: '/project/worktrees/existing',
        worktreeBranch: 'existing',
        worktreeName: 'existing',
        originalCwd: '/project/app',
        gitRoot: '/project/app',
        originalHeadCommit: 'abc',
        createdAt: Date.now(),
      }
      useSessionStore.getState().setWorktreeInfo(routingId, existingInfo)

      const toolMsg = makeChatMessage({
        content: [makeToolUseBlock('CreateWorktree', {}, 'wt-tool-2')],
      })
      useSessionStore.getState().addMessage(routingId, toolMsg)

      bridge.webContents.send('session:tool-result', routingId, {
        toolUseId: 'wt-tool-2',
        result: 'Created worktree at /project/worktrees/new on branch new.',
        isError: false,
      })

      expect(useSessionStore.getState().sessions[routingId].worktreeInfo?.worktreePath).toBe('/project/worktrees/existing')
    })
  })

  describe('multi-session isolation', () => {
    it('bash output for one session does not affect another', () => {
      useSessionStore.getState().createNewSession('route-1', '/proj1')
      useSessionStore.getState().createNewSession('route-2', '/proj2')

      bridge.webContents.send('session:bash-output', 'route-1', {
        toolUseId: 'tool-1', output: 'only for route-1', totalLines: 1, totalBytes: 15,
      })

      expect(useSessionStore.getState().sessions['route-1'].bashOutputs['tool-1']).toBeDefined()
      expect(useSessionStore.getState().sessions['route-2'].bashOutputs['tool-1']).toBeUndefined()
    })

    it('voice transcript for one session does not affect another', () => {
      useSessionStore.getState().createNewSession('route-1', '/proj1')
      useSessionStore.getState().createNewSession('route-2', '/proj2')

      bridge.webContents.send('voice:transcript', 'route-1', { text: 'only route-1', isFinal: true })

      expect(useSessionStore.getState().sessions['route-1'].draftText).toBe('only route-1')
      expect(useSessionStore.getState().sessions['route-2'].draftText).toBe('')
    })

    it('sandbox violations for one session do not appear in another', () => {
      useSessionStore.getState().createNewSession('route-1', '/proj1')
      useSessionStore.getState().createNewSession('route-2', '/proj2')

      bridge.webContents.send('session:sandbox-violation', 'route-1', 'network blocked')

      expect(useSessionStore.getState().sessions['route-1'].sandboxViolations).toHaveLength(1)
      expect(useSessionStore.getState().sessions['route-2'].sandboxViolations).toHaveLength(0)
    })
  })
})
