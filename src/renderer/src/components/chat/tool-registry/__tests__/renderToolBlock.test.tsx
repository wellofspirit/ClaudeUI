/**
 * Unit tests for the unified renderToolBlock dispatch (via MessageBubble).
 *
 * The renderToolBlock function is private to MessageBubble.tsx, so we test it
 * by rendering MessageBubble with an assistant message containing a single
 * tool_use block. We mock the 5 destination components to capture which one
 * was selected for each tool name.
 *
 * Lifted kinds (plan/question/todo/task) → their interaction components.
 * Passive kinds (command/fileEdit/fileWrite/fileRead/search/web/mcp/unknown)
 * → ToolCallBlock.
 * hostedMcpKind takes priority over engineToolMap.kindOf.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import { useSessionStore } from '@renderer/stores/session-store'
import { makeSessionStatus, resetFactoryCounter } from '@test/factories/messages'

// Mock the lifted interaction components and ToolCallBlock
vi.mock('../../ExitPlanModeCard', () => ({
  ExitPlanModeCard: () => <div data-testid="ExitPlanModeCard" />
}))
vi.mock('../../AskUserQuestionBlock', () => ({
  AskUserQuestionBlock: () => <div data-testid="AskUserQuestionBlock" />
}))
vi.mock('../../TodoToolBlock', () => ({
  TodoToolBlock: () => <div data-testid="TodoToolBlock" />
}))
vi.mock('../../TaskCard', () => ({
  TaskCard: () => <div data-testid="TaskCard" />
}))
vi.mock('../../ToolCallBlock', () => ({
  ToolCallBlock: () => <div data-testid="ToolCallBlock" />
}))

import { MessageBubble } from '../../MessageBubble'
import type { ChatMessage, ContentBlock } from '../../../../../../shared/types'

beforeEach(() => {
  resetFactoryCounter()
  ;(globalThis as any).window.api = {
    saveSessionConfig: vi.fn(),
    saveSlashCommands: vi.fn(),
    logError: vi.fn(),
    respondApproval: vi.fn(),
    stopTask: vi.fn(),
    backgroundTask: vi.fn(),
    watchBackground: vi.fn(),
    unwatchBackground: vi.fn(),
    readBackgroundRange: vi.fn(),
    fetchAccountUsage: () => Promise.resolve(null),
    fetchBlockUsage: () => Promise.resolve(null),
    getPluginViews: () => Promise.resolve([])
  }

  useSessionStore.setState({
    activeSessionId: 'test-session',
    sessions: {
      'test-session': {
        cwd: '/test',
        sdkActive: false,
        isHistorical: false,
        forkOrigin: null,
        messages: [],
        streamingText: '',
        streamingThinking: '',
        thinkingStartedAt: null,
        thinkingDurationMs: null,
        status: makeSessionStatus({ state: 'idle', sessionId: null, model: null, cwd: null }),
        pendingApprovals: [],
        errors: [],
        warnings: [],
        todos: [],
        taskProgressMap: {},
        taskNotifications: [],
        openedTaskToolUseIds: [],
        rightPanel: 'none',
        subagentMessages: {},
        subagentStreamingText: {},
        subagentStreamingThinking: {},
        bashOutputs: {},
        backgroundOutputs: {},
        backgroundWatcherCounts: {},
        stoppingTaskIds: [],
        isWatching: false,
        needsAttention: false,
        permissionMode: 'default',
        effort: 'medium',
        thinkingMode: 'adaptive',
        statusLine: null,
        metering: null,
        queuedText: '',
        draftText: '',
        selectedModel: 'default',
        selectedEngineId: 'claude' as const,
        worktreeInfo: null,
        isGitRepo: false,
        gitStatus: null,
        gitBranches: null,
        gitSelectedFile: null,
        gitFileDiff: null,
        gitCommitMessage: '',
        gitFileFilter: 'all',
        gitReviewComments: [],
        gitSyncOperation: 'idle',
        gitSyncError: null,
        gitLastFetchTime: null,
        planReview: null,
        mockupDir: null,
        mockupTitle: null,
        sandboxViolations: [],
        voiceState: 'idle' as const,
        voiceInterimTranscript: '',
        btwQuestion: null,
        btwResponse: null,
        btwLoading: false,
        vendorAuthRequired: null
      }
    },
    settings: {
      expandToolCalls: false,
      expandReadResults: false,
      hideToolInput: false,
      maxRecentSessions: 20
    } as any
  })
})

function makeMessage(toolName: string, toolInput?: Record<string, unknown>): ChatMessage {
  const block: ContentBlock = {
    type: 'tool_use',
    toolUseId: 'test-id',
    toolName,
    toolInput
  }
  return {
    id: 'msg-1',
    role: 'assistant',
    content: [block],
    timestamp: Date.now()
  }
}

function renderMsg(toolName: string, toolInput?: Record<string, unknown>): void {
  render(
    <MessageBubble
      message={makeMessage(toolName, toolInput)}
      pendingApprovals={[]}
      isLastAssistant={true}
      thinkingStartedAt={null}
    />
  )
}

describe('renderToolBlock dispatch (via MessageBubble)', () => {
  describe('lifted kinds — route to interaction components', () => {
    it('ExitPlanMode → ExitPlanModeCard', () => {
      renderMsg('ExitPlanMode', { plan: 'Do stuff' })
      expect(screen.getByTestId('ExitPlanModeCard')).toBeInTheDocument()
    })

    it('AskUserQuestion → AskUserQuestionBlock', () => {
      renderMsg('AskUserQuestion', { questions: [] })
      expect(screen.getByTestId('AskUserQuestionBlock')).toBeInTheDocument()
    })

    it('TodoWrite → TodoToolBlock', () => {
      renderMsg('TodoWrite', { todos: [] })
      expect(screen.getByTestId('TodoToolBlock')).toBeInTheDocument()
    })

    it('Task → TaskCard', () => {
      renderMsg('Task', { description: 'Search' })
      expect(screen.getByTestId('TaskCard')).toBeInTheDocument()
    })

    it('Agent → TaskCard', () => {
      renderMsg('Agent', { description: 'Analyze' })
      expect(screen.getByTestId('TaskCard')).toBeInTheDocument()
    })
  })

  describe('passive kinds — route to ToolCallBlock', () => {
    it('Bash → ToolCallBlock', () => {
      renderMsg('Bash', { command: 'ls' })
      expect(screen.getByTestId('ToolCallBlock')).toBeInTheDocument()
    })

    it('Read → ToolCallBlock', () => {
      renderMsg('Read', { file_path: '/foo.ts' })
      expect(screen.getByTestId('ToolCallBlock')).toBeInTheDocument()
    })

    it('Edit → ToolCallBlock', () => {
      renderMsg('Edit', { file_path: '/foo.ts', old_string: 'a', new_string: 'b' })
      expect(screen.getByTestId('ToolCallBlock')).toBeInTheDocument()
    })

    it('Write → ToolCallBlock', () => {
      renderMsg('Write', { file_path: '/foo.ts', content: 'x' })
      expect(screen.getByTestId('ToolCallBlock')).toBeInTheDocument()
    })

    it('Glob → ToolCallBlock', () => {
      renderMsg('Glob', { pattern: '**/*.ts' })
      expect(screen.getByTestId('ToolCallBlock')).toBeInTheDocument()
    })

    it('WebFetch → ToolCallBlock', () => {
      renderMsg('WebFetch', { url: 'https://example.com' })
      expect(screen.getByTestId('ToolCallBlock')).toBeInTheDocument()
    })

    it('mcp__claude-ui__render_mermaid → ToolCallBlock (diagram kind)', () => {
      renderMsg('mcp__claude-ui__render_mermaid', { source: 'graph TD; A-->B' })
      expect(screen.getByTestId('ToolCallBlock')).toBeInTheDocument()
    })

    it('mcp__claude-ui-mockup__create_mockup → ToolCallBlock (mockup kind)', () => {
      renderMsg('mcp__claude-ui-mockup__create_mockup', { title: 'test' })
      expect(screen.getByTestId('ToolCallBlock')).toBeInTheDocument()
    })

    it('unknown tool → ToolCallBlock', () => {
      renderMsg('SomeRandomTool', { data: 'x' })
      expect(screen.getByTestId('ToolCallBlock')).toBeInTheDocument()
    })
  })

  describe('hidden tools are suppressed', () => {
    it('EnterPlanMode is not rendered', () => {
      renderMsg('EnterPlanMode', {})
      expect(screen.queryByTestId('ExitPlanModeCard')).not.toBeInTheDocument()
      expect(screen.queryByTestId('ToolCallBlock')).not.toBeInTheDocument()
    })

    it('TaskCreate is not rendered', () => {
      renderMsg('TaskCreate', { title: 'task' })
      expect(screen.queryByTestId('ToolCallBlock')).not.toBeInTheDocument()
    })

    it('TaskUpdate is not rendered', () => {
      renderMsg('TaskUpdate', { id: 'task-1' })
      expect(screen.queryByTestId('ToolCallBlock')).not.toBeInTheDocument()
    })
  })
})
