/**
 * Component tests for session-store Zustand actions.
 * Tests the store's state machine directly — no React rendering required.
 *
 * Pattern: arrange store state → call action → assert resulting state.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest'
import { useSessionStore } from '../session-store'
import {
  makeChatMessage,
  makeAssistantMessage,
  makeToolUseBlock,
  makeTaskNotification,
  resetFactoryCounter,
} from '@test/factories/messages'
import type { DiffComment, PlanComment, WorktreeInfo, TeammateInfo, GitStatusData } from '../../../../shared/types'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const store = () => useSessionStore.getState()

function makeGitStatus(overrides?: Partial<GitStatusData>): GitStatusData {
  return {
    branch: 'main',
    ahead: 0,
    behind: 0,
    trackingBranch: 'origin/main',
    files: [],
    staged: [],
    unstaged: [],
    untracked: [],
    linesAdded: 0,
    linesRemoved: 0,
    ...overrides,
  }
}

function makeDiffComment(overrides?: Partial<DiffComment>): DiffComment {
  return {
    id: `comment-${Date.now()}-${Math.random()}`,
    filePath: 'src/foo.ts',
    lineNumber: 10,
    endLineNumber: 10,
    side: 'new',
    lineContent: 'const x = 1',
    comment: 'Consider renaming',
    createdAt: Date.now(),
    ...overrides,
  }
}

function makePlanComment(overrides?: Partial<PlanComment>): PlanComment {
  return {
    id: `plan-comment-${Date.now()}-${Math.random()}`,
    selectedText: 'some plan text',
    lineNumber: 5,
    endLineNumber: 5,
    sectionIndex: 0,
    comment: 'Looks good',
    createdAt: Date.now(),
    ...overrides,
  }
}

function makeWorktreeInfo(overrides?: Partial<WorktreeInfo>): WorktreeInfo {
  return {
    worktreePath: '/tmp/worktrees/feature-branch',
    worktreeBranch: 'feature/test',
    worktreeName: 'feature-branch',
    originalCwd: '/test',
    gitRoot: '/test',
    originalHeadCommit: 'abc123',
    createdAt: Date.now(),
    ...overrides,
  }
}

function makeTeammateInfo(overrides?: Partial<TeammateInfo>): TeammateInfo {
  return {
    toolUseId: `teammate-${Date.now()}-${Math.random()}`,
    name: 'Agent-1',
    sanitizedName: 'agent-1',
    teamName: 'TestTeam',
    sanitizedTeamName: 'testteam',
    agentId: 'agent-abc123',
    status: 'running',
    ...overrides,
  }
}

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

beforeEach(() => {
  resetFactoryCounter()
  ;(globalThis as any).window = globalThis.window || {}
  ;(globalThis as any).window.api = {
    saveSessionConfig: vi.fn(),
    saveSlashCommands: vi.fn(),
    saveSettings: vi.fn(),
    logError: vi.fn(),
    killTerminal: vi.fn(),
    watchBackground: vi.fn(),
    unwatchBackground: vi.fn(),
  } as any

  useSessionStore.setState({
    activeSessionId: null,
    sessions: {},
    directories: [],
    recentSessionIds: [],
    pinnedSessionIds: [],
    customTitles: {},
    worktreeInfoMap: {},
    terminalGroups: {},
  })
})

// ---------------------------------------------------------------------------
// Session lifecycle
// ---------------------------------------------------------------------------

describe('createNewSession', () => {
  it('creates a new session with the given cwd', () => {
    store().createNewSession('r1', '/test/project')
    expect(store().sessions['r1']).toBeDefined()
    expect(store().sessions['r1'].cwd).toBe('/test/project')
  })

  it('prepends routingId to recentSessionIds', () => {
    store().createNewSession('r1', '/a')
    store().createNewSession('r2', '/b')
    expect(store().recentSessionIds[0]).toBe('r2')
    expect(store().recentSessionIds[1]).toBe('r1')
  })

  it('deduplicates recentSessionIds when same id re-created', () => {
    store().createNewSession('r1', '/a')
    store().createNewSession('r2', '/b')
    store().createNewSession('r1', '/a')
    const recents = store().recentSessionIds
    expect(recents.filter((id) => id === 'r1')).toHaveLength(1)
    expect(recents[0]).toBe('r1')
  })

  it('caps recentSessionIds at maxRecentSessions (default 5)', () => {
    for (let i = 1; i <= 7; i++) {
      store().createNewSession(`r${i}`, `/path/${i}`)
    }
    expect(store().recentSessionIds.length).toBeLessThanOrEqual(5)
  })

  it('sets activeSessionId when switchTo is true (default)', () => {
    store().createNewSession('r1', '/test')
    expect(store().activeSessionId).toBe('r1')
  })

  it('does not set activeSessionId when switchTo is false', () => {
    store().createNewSession('r1', '/test', false)
    expect(store().activeSessionId).toBeNull()
  })

  it('sets activeView to chat when switchTo is true', () => {
    store().createNewSession('r1', '/test')
    expect(store().activeView).toEqual({ type: 'chat' })
  })
})

describe('switchSession', () => {
  it('sets activeSessionId to the given routingId', () => {
    store().createNewSession('r1', '/a')
    store().createNewSession('r2', '/b', false)
    store().switchSession('r2')
    expect(store().activeSessionId).toBe('r2')
  })

  it('clears needsAttention on target session', () => {
    store().createNewSession('r1', '/a')
    store().createNewSession('r2', '/b', false)
    store().setNeedsAttention('r2', true)
    store().switchSession('r2')
    expect(store().sessions['r2'].needsAttention).toBe(false)
  })

  it('sets activeView to chat', () => {
    store().createNewSession('r1', '/a')
    useSessionStore.setState({ activeView: { type: 'usage' } })
    store().switchSession('r1')
    expect(store().activeView).toEqual({ type: 'chat' })
  })

  it('cleans up empty current session before switching', () => {
    store().createNewSession('r1', '/a') // active, no messages
    store().createNewSession('r2', '/b', false)
    store().switchSession('r2')
    // r1 had no messages so it should be pruned
    expect(store().sessions['r1']).toBeUndefined()
    expect(store().recentSessionIds).not.toContain('r1')
  })

  it('preserves current session when it has messages', () => {
    store().createNewSession('r1', '/a')
    store().addUserMessage('r1', 'msg-1', 'hello')
    store().createNewSession('r2', '/b', false)
    store().switchSession('r2')
    expect(store().sessions['r1']).toBeDefined()
  })
})

describe('showWelcome', () => {
  it('sets activeSessionId to null', () => {
    store().createNewSession('r1', '/a')
    store().showWelcome()
    expect(store().activeSessionId).toBeNull()
  })

  it('cleans up empty current session', () => {
    store().createNewSession('r1', '/a') // no messages
    store().showWelcome()
    expect(store().sessions['r1']).toBeUndefined()
    expect(store().recentSessionIds).not.toContain('r1')
  })

  it('preserves session with messages when returning to welcome', () => {
    store().createNewSession('r1', '/a')
    store().addUserMessage('r1', 'msg-1', 'hi')
    store().showWelcome()
    expect(store().sessions['r1']).toBeDefined()
  })
})

describe('loadHistoricalSession', () => {
  it('loads messages into session with isHistorical: true', () => {
    const messages = [makeAssistantMessage('Hello')]
    store().loadHistoricalSession('r1', messages, '/project')
    const session = store().sessions['r1']
    expect(session).toBeDefined()
    expect(session.isHistorical).toBe(true)
    expect(session.messages).toHaveLength(1)
    expect(session.cwd).toBe('/project')
  })

  it('loads taskNotifications when provided', () => {
    const notifications = [makeTaskNotification({ status: 'completed' })]
    store().loadHistoricalSession('r1', [], '/project', notifications)
    expect(store().sessions['r1'].taskNotifications).toHaveLength(1)
  })

  it('loads subagentMessages when provided', () => {
    const subMsg = makeChatMessage({ role: 'assistant' })
    store().loadHistoricalSession('r1', [], '/project', [], { 'tool-1': [subMsg] })
    expect(store().sessions['r1'].subagentMessages['tool-1']).toHaveLength(1)
  })

  it('loads statusLine when provided', () => {
    const statusLine = { text: 'Ready', color: 'green' }
    store().loadHistoricalSession('r1', [], '/project', [], {}, statusLine as any)
    expect(store().sessions['r1'].statusLine).toEqual(statusLine)
  })

  it('sets empty arrays when optional params omitted', () => {
    store().loadHistoricalSession('r1', [], '/project')
    expect(store().sessions['r1'].taskNotifications).toEqual([])
    expect(store().sessions['r1'].subagentMessages).toEqual({})
    expect(store().sessions['r1'].statusLine).toBeNull()
  })
})

describe('rekeySession', () => {
  it('renames the session key in sessions', () => {
    store().createNewSession('old-id', '/test')
    store().rekeySession('old-id', 'new-id')
    expect(store().sessions['new-id']).toBeDefined()
    expect(store().sessions['old-id']).toBeUndefined()
  })

  it('updates activeSessionId when rekeying active session', () => {
    store().createNewSession('old-id', '/test')
    expect(store().activeSessionId).toBe('old-id')
    store().rekeySession('old-id', 'new-id')
    expect(store().activeSessionId).toBe('new-id')
  })

  it('updates recentSessionIds', () => {
    store().createNewSession('old-id', '/test')
    store().rekeySession('old-id', 'new-id')
    expect(store().recentSessionIds).toContain('new-id')
    expect(store().recentSessionIds).not.toContain('old-id')
  })

  it('updates pinnedSessionIds', () => {
    store().createNewSession('old-id', '/test')
    store().pinSession('old-id')
    store().rekeySession('old-id', 'new-id')
    expect(store().pinnedSessionIds).toContain('new-id')
    expect(store().pinnedSessionIds).not.toContain('old-id')
  })

  it('migrates customTitles to new id', () => {
    store().createNewSession('old-id', '/test')
    store().setCustomTitle('old-id', 'My Session')
    store().rekeySession('old-id', 'new-id')
    expect(store().customTitles['new-id']).toBe('My Session')
    expect(store().customTitles['old-id']).toBeUndefined()
  })

  it('migrates worktreeInfoMap to new id', () => {
    store().createNewSession('old-id', '/test')
    useSessionStore.setState({
      worktreeInfoMap: { 'old-id': makeWorktreeInfo() }
    })
    store().rekeySession('old-id', 'new-id')
    expect(store().worktreeInfoMap['new-id']).toBeDefined()
    expect(store().worktreeInfoMap['old-id']).toBeUndefined()
  })

  it('is a no-op when oldId === newId', () => {
    store().createNewSession('r1', '/test')
    const before = store().sessions['r1']
    store().rekeySession('r1', 'r1')
    expect(store().sessions['r1']).toBe(before)
  })

  it('is a no-op when old session does not exist', () => {
    store().rekeySession('ghost', 'new-id')
    expect(store().sessions['new-id']).toBeUndefined()
  })
})

describe('pinSession', () => {
  it('moves session from recents to pinned', () => {
    store().createNewSession('r1', '/test')
    expect(store().recentSessionIds).toContain('r1')
    store().pinSession('r1')
    expect(store().pinnedSessionIds).toContain('r1')
    expect(store().recentSessionIds).not.toContain('r1')
  })

  it('is a no-op when session is already pinned', () => {
    store().createNewSession('r1', '/test')
    store().pinSession('r1')
    const pinnedBefore = [...store().pinnedSessionIds]
    store().pinSession('r1')
    expect(store().pinnedSessionIds).toEqual(pinnedBefore)
  })
})

describe('unpinSession', () => {
  it('moves session from pinned to recents', () => {
    store().createNewSession('r1', '/test')
    store().pinSession('r1')
    store().unpinSession('r1')
    expect(store().pinnedSessionIds).not.toContain('r1')
    expect(store().recentSessionIds).toContain('r1')
  })

  it('prepends to recents when unpinned', () => {
    store().createNewSession('r1', '/a')
    store().createNewSession('r2', '/b')
    store().pinSession('r1')
    store().unpinSession('r1')
    expect(store().recentSessionIds[0]).toBe('r1')
  })
})

// ---------------------------------------------------------------------------
// Message / queue actions
// ---------------------------------------------------------------------------

describe('consumeQueuedText', () => {
  it('creates a user message from queuedText and clears it', () => {
    store().createNewSession('r1', '/test')
    store().setQueuedText('r1', 'queued prompt')
    store().consumeQueuedText('r1')
    const session = store().sessions['r1']
    expect(session.messages).toHaveLength(1)
    expect(session.messages[0].role).toBe('user')
    expect(session.messages[0].content[0]).toMatchObject({ type: 'text', text: 'queued prompt' })
    expect(session.queuedText).toBe('')
  })

  it('is a no-op when queuedText is empty', () => {
    store().createNewSession('r1', '/test')
    store().consumeQueuedText('r1')
    expect(store().sessions['r1'].messages).toHaveLength(0)
  })

  it('is a no-op when session does not exist', () => {
    expect(() => store().consumeQueuedText('ghost')).not.toThrow()
  })
})

describe('addUserMessage', () => {
  it('appends a user message with text content', () => {
    store().createNewSession('r1', '/test')
    store().addUserMessage('r1', 'msg-1', 'hello world')
    const session = store().sessions['r1']
    expect(session.messages).toHaveLength(1)
    expect(session.messages[0]).toMatchObject({
      id: 'msg-1',
      role: 'user',
      content: [{ type: 'text', text: 'hello world' }],
    })
  })

  it('places image attachments before text', () => {
    store().createNewSession('r1', '/test')
    store().addUserMessage('r1', 'msg-1', 'look at this', undefined, [
      { mediaType: 'image/png', base64Data: 'abc123', fileName: 'pic.png' }
    ])
    const content = store().sessions['r1'].messages[0].content
    expect(content[0].type).toBe('image')
    expect(content[1].type).toBe('text')
  })

  it('places PDF attachments as document blocks before text', () => {
    store().createNewSession('r1', '/test')
    store().addUserMessage('r1', 'msg-1', 'here is a doc', undefined, [
      { mediaType: 'application/pdf', base64Data: 'pdfdata', fileName: 'doc.pdf' }
    ])
    const content = store().sessions['r1'].messages[0].content
    expect(content[0].type).toBe('document')
    expect(content[1].type).toBe('text')
  })

  it('stores planContent when provided', () => {
    store().createNewSession('r1', '/test')
    store().addUserMessage('r1', 'msg-1', 'run plan', 'the plan content')
    expect(store().sessions['r1'].messages[0].planContent).toBe('the plan content')
  })

  it('updates recentSessionIds', () => {
    store().createNewSession('r1', '/a', false)
    store().createNewSession('r2', '/b', false)
    store().addUserMessage('r1', 'msg-1', 'hello')
    expect(store().recentSessionIds[0]).toBe('r1')
  })

  it('is a no-op when session does not exist', () => {
    expect(() => store().addUserMessage('ghost', 'msg-1', 'hello')).not.toThrow()
  })
})

describe('removePendingApproval', () => {
  it('removes the approval matching the requestId', () => {
    store().createNewSession('r1', '/test')
    store().addPendingApproval('r1', { requestId: 'req-1', toolName: 'Bash', input: {} })
    store().addPendingApproval('r1', { requestId: 'req-2', toolName: 'Read', input: {} })
    store().removePendingApproval('r1', 'req-1')
    const approvals = store().sessions['r1'].pendingApprovals
    expect(approvals).toHaveLength(1)
    expect(approvals[0].requestId).toBe('req-2')
  })

  it('leaves approvals unchanged when requestId not found', () => {
    store().createNewSession('r1', '/test')
    store().addPendingApproval('r1', { requestId: 'req-1', toolName: 'Bash', input: {} })
    store().removePendingApproval('r1', 'ghost-req')
    expect(store().sessions['r1'].pendingApprovals).toHaveLength(1)
  })
})

// ---------------------------------------------------------------------------
// Task / subagent actions
// ---------------------------------------------------------------------------

describe('addTaskNotification', () => {
  it('appends notification to taskNotifications', () => {
    store().createNewSession('r1', '/test')
    const notification = makeTaskNotification({ toolUseId: 'tool-1', status: 'completed' })
    store().addTaskNotification('r1', notification)
    expect(store().sessions['r1'].taskNotifications).toHaveLength(1)
    expect(store().sessions['r1'].taskNotifications[0]).toEqual(notification)
  })

  it('clears stoppingTaskIds for the toolUseId', () => {
    store().createNewSession('r1', '/test')
    store().setTaskStopping('r1', 'tool-1')
    expect(store().sessions['r1'].stoppingTaskIds).toContain('tool-1')
    store().addTaskNotification('r1', makeTaskNotification({ toolUseId: 'tool-1' }))
    expect(store().sessions['r1'].stoppingTaskIds).not.toContain('tool-1')
  })

  it('clears bashOutputs for the toolUseId', () => {
    store().createNewSession('r1', '/test')
    store().setBashOutput('r1', 'tool-1', 'some output', 3, 100)
    expect(store().sessions['r1'].bashOutputs['tool-1']).toBeDefined()
    store().addTaskNotification('r1', makeTaskNotification({ toolUseId: 'tool-1' }))
    expect(store().sessions['r1'].bashOutputs['tool-1']).toBeUndefined()
  })

  it('does not modify stoppingTaskIds when toolUseId is null', () => {
    store().createNewSession('r1', '/test')
    store().setTaskStopping('r1', 'tool-1')
    store().addTaskNotification('r1', makeTaskNotification({ toolUseId: null }))
    expect(store().sessions['r1'].stoppingTaskIds).toContain('tool-1')
  })
})

describe('updateTaskProgress', () => {
  it('inserts progress entry by toolUseId', () => {
    store().createNewSession('r1', '/test')
    const progress = {
      toolUseId: 'tool-1',
      toolName: 'Bash',
      parentToolUseId: null,
      elapsedTimeSeconds: 5,
    }
    store().updateTaskProgress('r1', progress)
    expect(store().sessions['r1'].taskProgressMap['tool-1']).toEqual(progress)
  })

  it('updates existing progress entry', () => {
    store().createNewSession('r1', '/test')
    store().updateTaskProgress('r1', { toolUseId: 'tool-1', toolName: 'Bash', parentToolUseId: null, elapsedTimeSeconds: 5 })
    store().updateTaskProgress('r1', { toolUseId: 'tool-1', toolName: 'Bash', parentToolUseId: null, elapsedTimeSeconds: 10 })
    expect(store().sessions['r1'].taskProgressMap['tool-1'].elapsedTimeSeconds).toBe(10)
  })
})

describe('addSubagentMessage', () => {
  it('appends new message to subagentMessages[toolUseId]', () => {
    store().createNewSession('r1', '/test')
    const msg = makeAssistantMessage('step 1')
    store().addSubagentMessage('r1', 'tool-1', msg)
    expect(store().sessions['r1'].subagentMessages['tool-1']).toHaveLength(1)
  })

  it('upserts by message id when message already exists', () => {
    store().createNewSession('r1', '/test')
    const msg = makeChatMessage({ id: 'shared-id', role: 'assistant', content: [{ type: 'text', text: 'v1' }] })
    store().addSubagentMessage('r1', 'tool-1', msg)
    const updated = makeChatMessage({ id: 'shared-id', role: 'assistant', content: [{ type: 'text', text: 'v2' }] })
    store().addSubagentMessage('r1', 'tool-1', updated)
    const msgs = store().sessions['r1'].subagentMessages['tool-1']
    expect(msgs).toHaveLength(1)
    expect(msgs[0].content[0]).toMatchObject({ text: 'v2' })
  })

  it('clears streaming text and thinking for the toolUseId', () => {
    store().createNewSession('r1', '/test')
    store().appendSubagentStreamingText('r1', 'tool-1', 'partial...')
    store().addSubagentMessage('r1', 'tool-1', makeAssistantMessage('done'))
    expect(store().sessions['r1'].subagentStreamingText['tool-1']).toBe('')
    expect(store().sessions['r1'].subagentStreamingThinking['tool-1']).toBe('')
  })

  it('bootstraps session if it does not exist (team scenario)', () => {
    store().addSubagentMessage('ghost', 'tool-1', makeAssistantMessage('hi'))
    expect(store().sessions['ghost']).toBeDefined()
  })
})

describe('appendSubagentMessageBatch', () => {
  it('appends multiple messages in order', () => {
    store().createNewSession('r1', '/test')
    const msgs = [makeAssistantMessage('a'), makeAssistantMessage('b')]
    store().appendSubagentMessageBatch('r1', 'tool-1', msgs)
    expect(store().sessions['r1'].subagentMessages['tool-1']).toHaveLength(2)
  })

  it('upserts messages that share existing ids', () => {
    store().createNewSession('r1', '/test')
    const m1 = makeChatMessage({ id: 'x', role: 'assistant', content: [{ type: 'text', text: 'old' }] })
    store().addSubagentMessage('r1', 'tool-1', m1)
    const m2 = makeChatMessage({ id: 'x', role: 'assistant', content: [{ type: 'text', text: 'new' }] })
    store().appendSubagentMessageBatch('r1', 'tool-1', [m2])
    const msgs = store().sessions['r1'].subagentMessages['tool-1']
    expect(msgs).toHaveLength(1)
    expect(msgs[0].content[0]).toMatchObject({ text: 'new' })
  })

  it('clears streaming text and thinking', () => {
    store().createNewSession('r1', '/test')
    store().appendSubagentStreamingText('r1', 'tool-1', 'partial...')
    store().appendSubagentMessageBatch('r1', 'tool-1', [makeAssistantMessage('done')])
    expect(store().sessions['r1'].subagentStreamingText['tool-1']).toBe('')
  })
})

describe('appendSubagentToolResult', () => {
  it('appends tool_result block to the matching assistant message in subagentMessages', () => {
    store().createNewSession('r1', '/test')
    const toolMsg = makeChatMessage({
      id: 'agent-msg-1',
      role: 'assistant',
      content: [makeToolUseBlock('Bash', { command: 'ls' }, 'tu-abc')],
    })
    store().addSubagentMessage('r1', 'tool-1', toolMsg)
    store().appendSubagentToolResult('r1', 'tool-1', 'tu-abc', 'file1\nfile2', false)
    const msgs = store().sessions['r1'].subagentMessages['tool-1']
    const result = msgs[0].content.find((b) => b.type === 'tool_result')
    expect(result).toBeDefined()
    expect(result).toMatchObject({ toolUseId: 'tu-abc', toolResult: 'file1\nfile2', isError: false })
  })

  it('marks isError correctly', () => {
    store().createNewSession('r1', '/test')
    const toolMsg = makeChatMessage({
      id: 'agent-msg-1',
      role: 'assistant',
      content: [makeToolUseBlock('Bash', {}, 'tu-xyz')],
    })
    store().addSubagentMessage('r1', 'tool-1', toolMsg)
    store().appendSubagentToolResult('r1', 'tool-1', 'tu-xyz', 'error: permission denied', true)
    const msgs = store().sessions['r1'].subagentMessages['tool-1']
    const result = msgs[0].content.find((b) => b.type === 'tool_result')
    expect(result).toMatchObject({ isError: true })
  })

  it('is a no-op when session does not exist', () => {
    expect(() => store().appendSubagentToolResult('ghost', 'tool-1', 'tu-1', 'result', false)).not.toThrow()
  })
})

// ---------------------------------------------------------------------------
// Team actions
// ---------------------------------------------------------------------------

describe('addTeammate', () => {
  it('adds a teammate keyed by toolUseId', () => {
    store().createNewSession('r1', '/test')
    const teammate = makeTeammateInfo({ toolUseId: 'tm-1' })
    store().addTeammate('r1', teammate)
    expect(store().sessions['r1'].teammates['tm-1']).toEqual(teammate)
  })

  it('overwrites existing teammate with same toolUseId', () => {
    store().createNewSession('r1', '/test')
    const tm1 = makeTeammateInfo({ toolUseId: 'tm-1', status: 'running' })
    store().addTeammate('r1', tm1)
    const tm2 = makeTeammateInfo({ toolUseId: 'tm-1', status: 'completed' })
    store().addTeammate('r1', tm2)
    expect(store().sessions['r1'].teammates['tm-1'].status).toBe('completed')
  })

  it('bootstraps session if needed', () => {
    store().addTeammate('new-session', makeTeammateInfo())
    expect(store().sessions['new-session']).toBeDefined()
  })
})

describe('updateTeammateStatus', () => {
  it('updates the status field of an existing teammate', () => {
    store().createNewSession('r1', '/test')
    store().addTeammate('r1', makeTeammateInfo({ toolUseId: 'tm-1', status: 'running' }))
    store().updateTeammateStatus('r1', 'tm-1', 'completed')
    expect(store().sessions['r1'].teammates['tm-1'].status).toBe('completed')
  })

  it('is a no-op when teammate does not exist', () => {
    store().createNewSession('r1', '/test')
    expect(() => store().updateTeammateStatus('r1', 'ghost-tm', 'completed')).not.toThrow()
  })

  it('is a no-op when session does not exist', () => {
    expect(() => store().updateTeammateStatus('ghost', 'tm-1', 'completed')).not.toThrow()
  })
})

describe('addTeammateUserMessage', () => {
  it('appends a user message to subagentMessages[toolUseId]', () => {
    store().createNewSession('r1', '/test')
    store().addTeammateUserMessage('r1', 'tm-1', 'um-1', 'send this to agent')
    const msgs = store().sessions['r1'].subagentMessages['tm-1']
    expect(msgs).toHaveLength(1)
    expect(msgs[0]).toMatchObject({
      id: 'um-1',
      role: 'user',
      content: [{ type: 'text', text: 'send this to agent' }],
    })
  })

  it('appends to existing messages without replacing', () => {
    store().createNewSession('r1', '/test')
    store().addSubagentMessage('r1', 'tm-1', makeAssistantMessage('agent response'))
    store().addTeammateUserMessage('r1', 'tm-1', 'um-1', 'follow-up')
    expect(store().sessions['r1'].subagentMessages['tm-1']).toHaveLength(2)
  })

  it('is a no-op when session does not exist', () => {
    expect(() => store().addTeammateUserMessage('ghost', 'tm-1', 'um-1', 'hi')).not.toThrow()
  })
})

// ---------------------------------------------------------------------------
// Voice actions
// ---------------------------------------------------------------------------

describe('appendVoiceTranscript', () => {
  it('appends final transcript to draftText with space separator', () => {
    store().createNewSession('r1', '/test')
    useSessionStore.setState({
      sessions: {
        ...store().sessions,
        r1: { ...store().sessions['r1'], draftText: 'existing text' }
      }
    })
    store().appendVoiceTranscript('r1', 'new words', true)
    expect(store().sessions['r1'].draftText).toBe('existing text new words')
  })

  it('does not double-space when draftText already ends with space', () => {
    store().createNewSession('r1', '/test')
    useSessionStore.setState({
      sessions: {
        ...store().sessions,
        r1: { ...store().sessions['r1'], draftText: 'existing text ' }
      }
    })
    store().appendVoiceTranscript('r1', 'new words', true)
    expect(store().sessions['r1'].draftText).toBe('existing text new words')
  })

  it('appends to empty draftText without leading space', () => {
    store().createNewSession('r1', '/test')
    store().appendVoiceTranscript('r1', 'first words', true)
    expect(store().sessions['r1'].draftText).toBe('first words')
  })

  it('clears voiceInterimTranscript when isFinal', () => {
    store().createNewSession('r1', '/test')
    store().setVoiceInterimTranscript('r1', 'interim...')
    store().appendVoiceTranscript('r1', 'final text', true)
    expect(store().sessions['r1'].voiceInterimTranscript).toBe('')
  })

  it('updates voiceInterimTranscript when not final', () => {
    store().createNewSession('r1', '/test')
    store().appendVoiceTranscript('r1', 'speaking now...', false)
    expect(store().sessions['r1'].voiceInterimTranscript).toBe('speaking now...')
  })

  it('does not modify draftText for interim transcripts', () => {
    store().createNewSession('r1', '/test')
    useSessionStore.setState({
      sessions: { ...store().sessions, r1: { ...store().sessions['r1'], draftText: 'typed so far' } }
    })
    store().appendVoiceTranscript('r1', 'partial...', false)
    expect(store().sessions['r1'].draftText).toBe('typed so far')
  })
})

// ---------------------------------------------------------------------------
// Background output actions
// ---------------------------------------------------------------------------

describe('watchBackgroundOutput', () => {
  it('increments backgroundWatcherCounts', () => {
    store().createNewSession('r1', '/test')
    store().watchBackgroundOutput('r1', 'tool-1')
    expect(store().sessions['r1'].backgroundWatcherCounts['tool-1']).toBe(1)
    store().watchBackgroundOutput('r1', 'tool-1')
    expect(store().sessions['r1'].backgroundWatcherCounts['tool-1']).toBe(2)
  })

  it('calls window.api.watchBackground', () => {
    store().createNewSession('r1', '/test')
    store().watchBackgroundOutput('r1', 'tool-1')
    expect((window.api as any).watchBackground).toHaveBeenCalledWith('r1', 'tool-1')
  })

  it('is a no-op when session does not exist', () => {
    expect(() => store().watchBackgroundOutput('ghost', 'tool-1')).not.toThrow()
  })
})

describe('unwatchBackgroundOutput', () => {
  it('decrements backgroundWatcherCounts', () => {
    store().createNewSession('r1', '/test')
    store().watchBackgroundOutput('r1', 'tool-1')
    store().watchBackgroundOutput('r1', 'tool-1')
    store().unwatchBackgroundOutput('r1', 'tool-1')
    expect(store().sessions['r1'].backgroundWatcherCounts['tool-1']).toBe(1)
  })

  it('calls unwatchBackground and removes entries when count reaches 0', () => {
    store().createNewSession('r1', '/test')
    store().watchBackgroundOutput('r1', 'tool-1')
    store().setBackgroundOutput('r1', 'tool-1', 'some tail', 500)
    store().unwatchBackgroundOutput('r1', 'tool-1')
    expect((window.api as any).unwatchBackground).toHaveBeenCalledWith('r1', 'tool-1')
    expect(store().sessions['r1'].backgroundOutputs['tool-1']).toBeUndefined()
    expect(store().sessions['r1'].backgroundWatcherCounts['tool-1']).toBeUndefined()
  })

  it('does not call unwatchBackground while count remains above 0', () => {
    store().createNewSession('r1', '/test')
    store().watchBackgroundOutput('r1', 'tool-1')
    store().watchBackgroundOutput('r1', 'tool-1')
    store().unwatchBackgroundOutput('r1', 'tool-1')
    expect((window.api as any).unwatchBackground).not.toHaveBeenCalled()
  })

  it('is a no-op when session does not exist', () => {
    expect(() => store().unwatchBackgroundOutput('ghost', 'tool-1')).not.toThrow()
  })
})

// ---------------------------------------------------------------------------
// Terminal actions
// ---------------------------------------------------------------------------

describe('addTerminalTab', () => {
  it('adds tab to group keyed by normalized cwd', () => {
    store().addTerminalTab({ id: 'term-1', title: 'bash', cwd: '/project/' })
    expect(store().terminalGroups['/project']).toBeDefined()
    expect(store().terminalGroups['/project'].tabs).toHaveLength(1)
  })

  it('sets activeTabId to the new tab', () => {
    store().addTerminalTab({ id: 'term-1', title: 'bash', cwd: '/project' })
    expect(store().terminalGroups['/project'].activeTabId).toBe('term-1')
  })

  it('appends to existing group without replacing other tabs', () => {
    store().addTerminalTab({ id: 'term-1', title: 'bash', cwd: '/project' })
    store().addTerminalTab({ id: 'term-2', title: 'zsh', cwd: '/project' })
    expect(store().terminalGroups['/project'].tabs).toHaveLength(2)
    expect(store().terminalGroups['/project'].activeTabId).toBe('term-2')
  })
})

describe('closeTerminalTab', () => {
  it('removes the tab and calls killTerminal', () => {
    store().addTerminalTab({ id: 'term-1', title: 'bash', cwd: '/project' })
    store().closeTerminalTab('term-1')
    expect(store().terminalGroups['/project'].tabs).toHaveLength(0)
    expect((window.api as any).killTerminal).toHaveBeenCalledWith('term-1')
  })

  it('updates activeTabId to last remaining tab', () => {
    store().addTerminalTab({ id: 'term-1', title: 'bash', cwd: '/project' })
    store().addTerminalTab({ id: 'term-2', title: 'zsh', cwd: '/project' })
    store().closeTerminalTab('term-2')
    expect(store().terminalGroups['/project'].activeTabId).toBe('term-1')
  })

  it('sets activeTabId to null when no tabs remain', () => {
    store().addTerminalTab({ id: 'term-1', title: 'bash', cwd: '/project' })
    store().closeTerminalTab('term-1')
    expect(store().terminalGroups['/project'].activeTabId).toBeNull()
  })
})

describe('removeTerminalTab', () => {
  it('removes tab without calling killTerminal', () => {
    store().addTerminalTab({ id: 'term-1', title: 'bash', cwd: '/project' })
    store().removeTerminalTab('term-1')
    expect(store().terminalGroups['/project'].tabs).toHaveLength(0)
    expect((window.api as any).killTerminal).not.toHaveBeenCalled()
  })

  it('updates activeTabId to last remaining tab', () => {
    store().addTerminalTab({ id: 'term-1', title: 'bash', cwd: '/project' })
    store().addTerminalTab({ id: 'term-2', title: 'zsh', cwd: '/project' })
    store().removeTerminalTab('term-2')
    expect(store().terminalGroups['/project'].activeTabId).toBe('term-1')
  })
})

describe('removeTerminalGroup', () => {
  it('removes the entire group for the given cwd', () => {
    store().addTerminalTab({ id: 'term-1', title: 'bash', cwd: '/project' })
    store().removeTerminalGroup('/project')
    expect(store().terminalGroups['/project']).toBeUndefined()
  })

  it('normalizes cwd before removing', () => {
    store().addTerminalTab({ id: 'term-1', title: 'bash', cwd: '/project' })
    store().removeTerminalGroup('/project/')  // trailing slash
    expect(store().terminalGroups['/project']).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// Git / Plan / Worktree actions
// ---------------------------------------------------------------------------

describe('setGitStatus', () => {
  it('updates gitStatus on the session', () => {
    store().createNewSession('r1', '/test')
    const status = makeGitStatus({ branch: 'feature' })
    store().setGitStatus('r1', status)
    expect(store().sessions['r1'].gitStatus?.branch).toBe('feature')
  })

  it('caches git status for the session cwd', () => {
    // Create a second session with the same cwd — it should receive cached status
    store().createNewSession('r1', '/shared-cwd')
    const status = makeGitStatus({ branch: 'main', files: [{ path: 'README.md', index: 'M', working: ' ' }] })
    store().setGitStatus('r1', status)
    // New session with same cwd should pick up cached status
    store().createNewSession('r2', '/shared-cwd')
    expect(store().sessions['r2'].gitStatus?.branch).toBe('main')
  })
})

describe('selectNextGitFile', () => {
  it('selects the first file from gitStatus.files', () => {
    store().createNewSession('r1', '/test')
    store().setGitStatus('r1', makeGitStatus({
      files: [
        { path: 'a.ts', index: 'M', working: ' ' },
        { path: 'b.ts', index: 'M', working: ' ' },
      ]
    }))
    store().selectNextGitFile('r1')
    expect(store().sessions['r1'].gitSelectedFile).toBe('a.ts')
  })

  it('sets gitSelectedFile to null when no files in gitStatus', () => {
    store().createNewSession('r1', '/test')
    store().setGitStatus('r1', makeGitStatus({ files: [] }))
    store().selectNextGitFile('r1')
    expect(store().sessions['r1'].gitSelectedFile).toBeNull()
  })

  it('sets gitSelectedFile to null when gitStatus is null', () => {
    store().createNewSession('r1', '/test')
    store().selectNextGitFile('r1')
    expect(store().sessions['r1'].gitSelectedFile).toBeNull()
  })

  it('clears gitFileDiff when selecting next file', () => {
    store().createNewSession('r1', '/test')
    store().setGitFileDiff('r1', { patch: 'diff --git...' })
    store().setGitStatus('r1', makeGitStatus({ files: [{ path: 'a.ts', index: 'M', working: ' ' }] }))
    store().selectNextGitFile('r1')
    expect(store().sessions['r1'].gitFileDiff).toBeNull()
  })
})

describe('addDiffComment / removeDiffComment / clearDiffComments', () => {
  it('addDiffComment appends a comment', () => {
    store().createNewSession('r1', '/test')
    const comment = makeDiffComment({ id: 'c-1' })
    store().addDiffComment('r1', comment)
    expect(store().sessions['r1'].gitReviewComments).toHaveLength(1)
  })

  it('removeDiffComment removes by id', () => {
    store().createNewSession('r1', '/test')
    store().addDiffComment('r1', makeDiffComment({ id: 'c-1' }))
    store().addDiffComment('r1', makeDiffComment({ id: 'c-2' }))
    store().removeDiffComment('r1', 'c-1')
    expect(store().sessions['r1'].gitReviewComments).toHaveLength(1)
    expect(store().sessions['r1'].gitReviewComments[0].id).toBe('c-2')
  })

  it('clearDiffComments empties the array', () => {
    store().createNewSession('r1', '/test')
    store().addDiffComment('r1', makeDiffComment())
    store().addDiffComment('r1', makeDiffComment())
    store().clearDiffComments('r1')
    expect(store().sessions['r1'].gitReviewComments).toHaveLength(0)
  })
})

describe('openPlanPanel / closePlanPanel', () => {
  it('openPlanPanel sets rightPanel to plan and initializes planReview', () => {
    store().createNewSession('r1', '/test')
    store().openPlanPanel('r1', 'the plan content', 'req-abc')
    const session = store().sessions['r1']
    expect(session.rightPanel).toBe('plan')
    expect(session.planReview).toMatchObject({
      planContent: 'the plan content',
      approvalRequestId: 'req-abc',
      comments: [],
    })
  })

  it('closePlanPanel sets rightPanel to none and nulls planReview', () => {
    store().createNewSession('r1', '/test')
    store().openPlanPanel('r1', 'plan', 'req-1')
    store().closePlanPanel('r1')
    expect(store().sessions['r1'].rightPanel).toBe('none')
    expect(store().sessions['r1'].planReview).toBeNull()
  })
})

describe('plan comment CRUD', () => {
  beforeEach(() => {
    store().createNewSession('r1', '/test')
    store().openPlanPanel('r1', 'some plan', 'req-1')
  })

  it('addPlanComment appends a comment', () => {
    const comment = makePlanComment({ id: 'pc-1' })
    store().addPlanComment('r1', comment)
    expect(store().sessions['r1'].planReview?.comments).toHaveLength(1)
  })

  it('updatePlanComment updates the text of an existing comment', () => {
    store().addPlanComment('r1', makePlanComment({ id: 'pc-1', comment: 'original' }))
    store().updatePlanComment('r1', 'pc-1', 'updated text')
    expect(store().sessions['r1'].planReview?.comments[0].comment).toBe('updated text')
  })

  it('updatePlanComment leaves other comments unchanged', () => {
    store().addPlanComment('r1', makePlanComment({ id: 'pc-1', comment: 'keep me' }))
    store().addPlanComment('r1', makePlanComment({ id: 'pc-2', comment: 'change me' }))
    store().updatePlanComment('r1', 'pc-2', 'changed')
    expect(store().sessions['r1'].planReview?.comments[0].comment).toBe('keep me')
  })

  it('removePlanComment removes by id', () => {
    store().addPlanComment('r1', makePlanComment({ id: 'pc-1' }))
    store().addPlanComment('r1', makePlanComment({ id: 'pc-2' }))
    store().removePlanComment('r1', 'pc-1')
    expect(store().sessions['r1'].planReview?.comments).toHaveLength(1)
    expect(store().sessions['r1'].planReview?.comments[0].id).toBe('pc-2')
  })

  it('clearPlanComments empties the array', () => {
    store().addPlanComment('r1', makePlanComment())
    store().addPlanComment('r1', makePlanComment())
    store().clearPlanComments('r1')
    expect(store().sessions['r1'].planReview?.comments).toHaveLength(0)
  })

  it('plan comment actions are no-ops when planReview is null', () => {
    store().closePlanPanel('r1')
    expect(() => store().addPlanComment('r1', makePlanComment())).not.toThrow()
    expect(store().sessions['r1'].planReview).toBeNull()
  })
})

describe('setWorktreeInfo', () => {
  it('updates worktreeInfoMap and session.worktreeInfo', () => {
    store().createNewSession('r1', '/test')
    const info = makeWorktreeInfo()
    store().setWorktreeInfo('r1', info)
    expect(store().worktreeInfoMap['r1']).toEqual(info)
    expect(store().sessions['r1'].worktreeInfo).toEqual(info)
  })

  it('updates session cwd to worktreePath when different', () => {
    store().createNewSession('r1', '/original')
    const info = makeWorktreeInfo({ worktreePath: '/tmp/worktrees/branch', originalCwd: '/original' })
    store().setWorktreeInfo('r1', info)
    expect(store().sessions['r1'].cwd).toBe('/tmp/worktrees/branch')
  })

  it('removes from map when info is null', () => {
    store().createNewSession('r1', '/test')
    store().setWorktreeInfo('r1', makeWorktreeInfo())
    store().setWorktreeInfo('r1', null)
    expect(store().worktreeInfoMap['r1']).toBeUndefined()
    expect(store().sessions['r1'].worktreeInfo).toBeNull()
  })
})

describe('clearWorktreeInfo', () => {
  it('removes from worktreeInfoMap and sets session.worktreeInfo to null', () => {
    store().createNewSession('r1', '/test')
    store().setWorktreeInfo('r1', makeWorktreeInfo())
    store().clearWorktreeInfo('r1')
    expect(store().worktreeInfoMap['r1']).toBeUndefined()
    expect(store().sessions['r1'].worktreeInfo).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// Settings actions
// ---------------------------------------------------------------------------

describe('applyExternalSettings', () => {
  it('merges incoming settings with DEFAULT_SETTINGS', () => {
    store().applyExternalSettings({ theme: 'light', expandToolCalls: false })
    expect(store().settings.theme).toBe('light')
    expect(store().settings.expandToolCalls).toBe(false)
  })

  it('fills missing fields from DEFAULT_SETTINGS', () => {
    store().applyExternalSettings({ theme: 'monokai' })
    // maxRecentSessions should still be the default value (5)
    expect(store().settings.maxRecentSessions).toBe(5)
  })

  it('does not call saveSettings (no disk write)', () => {
    store().applyExternalSettings({ theme: 'light' })
    expect((window.api as any).saveSettings).not.toHaveBeenCalled()
  })
})

describe('applyExternalSessionConfig', () => {
  it('replaces recentSessionIds', () => {
    store().applyExternalSessionConfig({ recentSessions: ['r1', 'r2'] })
    expect(store().recentSessionIds).toEqual(['r1', 'r2'])
  })

  it('replaces pinnedSessionIds', () => {
    store().applyExternalSessionConfig({ pinnedSessions: ['pinned-1'] })
    expect(store().pinnedSessionIds).toEqual(['pinned-1'])
  })

  it('replaces customTitles', () => {
    store().applyExternalSessionConfig({ customTitles: { 'r1': 'My Session' } })
    expect(store().customTitles['r1']).toBe('My Session')
  })

  it('replaces worktreeInfoMap', () => {
    const info = makeWorktreeInfo()
    store().applyExternalSessionConfig({ worktreeInfoMap: { 'r1': info } })
    expect(store().worktreeInfoMap['r1']).toEqual(info)
  })

  it('uses empty defaults when fields are missing', () => {
    store().applyExternalSessionConfig({})
    expect(store().recentSessionIds).toEqual([])
    expect(store().pinnedSessionIds).toEqual([])
    expect(store().customTitles).toEqual({})
    expect(store().worktreeInfoMap).toEqual({})
  })

  it('does not call saveSessionConfig (no disk write)', () => {
    store().applyExternalSessionConfig({ recentSessions: ['r1'] })
    expect((window.api as any).saveSessionConfig).not.toHaveBeenCalled()
  })
})
