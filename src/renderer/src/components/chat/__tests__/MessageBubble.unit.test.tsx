/**
 * Layer 1: Unit tests for MessageBubble component.
 *
 * Tests pure rendering: given a ChatMessage with specific content blocks,
 * does it render the correct sub-components and structure?
 * No IPC, no business logic — just props in, DOM out.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import { MessageBubble } from '../MessageBubble'
import { useSessionStore } from '../../../stores/session-store'
import {
  makeChatMessage,
  makeTextBlock,
  makeToolUseBlock,
  makeToolResultBlock,
  makeThinkingBlock,
  makePendingApproval,
  resetFactoryCounter,
} from '@test/factories/messages'

// Stub window.api for store operations
beforeEach(() => {
  resetFactoryCounter()
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
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
    getPluginViews: () => Promise.resolve([]),
  }

  // Set up minimal store state for ToolCallBlock (reads from store)
  useSessionStore.setState({
    activeSessionId: 'test-session',
    sessions: {
      'test-session': {
        cwd: '/test',
        sdkActive: false,
        isHistorical: false,
        messages: [],
        streamingText: '',
        streamingThinking: '',
        thinkingStartedAt: null,
        thinkingDurationMs: null,
        status: { state: 'idle', sessionId: null, model: null, cwd: null, totalCostUsd: 0 },
        pendingApprovals: [],
        errors: [],
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
        queuedText: '',
        draftText: '',
        selectedModel: 'default',
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
      },
    },
    settings: {
      expandToolCalls: false,
      expandReadResults: false,
      hideToolInput: false,
      maxRecentSessions: 20,
    } as any,
  })
})

describe('MessageBubble', () => {
  describe('user messages', () => {
    it('renders user text in a chat bubble', () => {
      const msg = makeChatMessage({
        role: 'user',
        content: [makeTextBlock('Hello Claude')],
      })
      render(
        <MessageBubble message={msg} pendingApprovals={[]} isLastAssistant={false} thinkingStartedAt={null} />
      )
      expect(screen.getByText('Hello Claude')).toBeInTheDocument()
    })

    it('renders plan content as ExitPlanModeCard', () => {
      const msg = makeChatMessage({
        role: 'user',
        content: [makeTextBlock('plan text')],
        planContent: '# My Plan\n\nDo things',
      })
      render(
        <MessageBubble message={msg} pendingApprovals={[]} isLastAssistant={false} thinkingStartedAt={null} />
      )
      // ExitPlanModeCard renders the plan
      expect(screen.getByText(/My Plan/)).toBeInTheDocument()
    })
  })

  describe('assistant messages', () => {
    it('renders text content blocks', () => {
      const msg = makeChatMessage({
        role: 'assistant',
        content: [makeTextBlock('The answer is 42')],
      })
      render(
        <MessageBubble message={msg} pendingApprovals={[]} isLastAssistant={true} thinkingStartedAt={null} />
      )
      expect(screen.getByText(/The answer is 42/)).toBeInTheDocument()
    })

    it('renders tool_use blocks with tool name', () => {
      const msg = makeChatMessage({
        role: 'assistant',
        content: [makeToolUseBlock('Read', { file_path: '/foo.ts' })],
      })
      render(
        <MessageBubble message={msg} pendingApprovals={[]} isLastAssistant={true} thinkingStartedAt={null} />
      )
      expect(screen.getByText('Read')).toBeInTheDocument()
    })

    it('hides hidden tool types (EnterPlanMode, TaskCreate, etc.)', () => {
      const msg = makeChatMessage({
        role: 'assistant',
        content: [
          makeToolUseBlock('EnterPlanMode', {}),
          makeTextBlock('After plan mode'),
        ],
      })
      render(
        <MessageBubble message={msg} pendingApprovals={[]} isLastAssistant={true} thinkingStartedAt={null} />
      )
      // EnterPlanMode should not render — but text after it should
      expect(screen.getByText(/After plan mode/)).toBeInTheDocument()
      expect(screen.queryByText('EnterPlanMode')).not.toBeInTheDocument()
    })

    it('renders thinking blocks when present', () => {
      const msg = makeChatMessage({
        role: 'assistant',
        content: [
          makeThinkingBlock('Let me think about this carefully...'),
          makeTextBlock('Here is my answer'),
        ],
      })
      render(
        <MessageBubble message={msg} pendingApprovals={[]} isLastAssistant={true} thinkingStartedAt={null} />
      )
      expect(screen.getByText(/Here is my answer/)).toBeInTheDocument()
    })

    it('renders tool_use with tool_result together', () => {
      const toolUseId = 'tool-123'
      const msg = makeChatMessage({
        role: 'assistant',
        content: [
          makeToolUseBlock('Bash', { command: 'echo hello' }, toolUseId),
          makeToolResultBlock(toolUseId, 'hello'),
        ],
      })
      render(
        <MessageBubble message={msg} pendingApprovals={[]} isLastAssistant={true} thinkingStartedAt={null} />
      )
      expect(screen.getByText('Bash')).toBeInTheDocument()
    })

    it('renders TodoWrite tool as TodoToolBlock', () => {
      const msg = makeChatMessage({
        role: 'assistant',
        content: [
          makeToolUseBlock('TodoWrite', {
            todos: [{ content: 'Task 1', status: 'pending', activeForm: 'Working on task 1' }],
          }),
        ],
      })
      render(
        <MessageBubble message={msg} pendingApprovals={[]} isLastAssistant={true} thinkingStartedAt={null} />
      )
      // TodoToolBlock renders the task list — verify the component rendered
      const container = document.querySelector('[class*="animate-fade-in"]')
      expect(container).toBeInTheDocument()
    })

    it('renders Agent/Task tool as TaskCard', () => {
      const msg = makeChatMessage({
        role: 'assistant',
        content: [
          makeToolUseBlock('Agent', { description: 'Search codebase', prompt: 'find files' }),
        ],
      })
      render(
        <MessageBubble message={msg} pendingApprovals={[]} isLastAssistant={true} thinkingStartedAt={null} />
      )
      expect(screen.getByText(/Search codebase/)).toBeInTheDocument()
    })
  })

  describe('approval → tool_use binding', () => {
    // Regression guard for the bug where two tool_use blocks with the
    // same toolName+input signature would both display the permission
    // prompt because the matcher keyed on (toolName, input) instead of
    // tool_use_id. After the fix the approval binds only to the block
    // whose toolUseId matches.
    it('binds approval only to the tool_use block whose toolUseId matches', () => {
      const completedBlock = makeToolUseBlock('Bash', { command: 'ls' }, 'toolu_old')
      const pendingBlock = makeToolUseBlock('Bash', { command: 'ls' }, 'toolu_new')
      const msg = makeChatMessage({
        role: 'assistant',
        content: [
          completedBlock,
          // The old call has a tool_result, proving it already finished.
          makeToolResultBlock('toolu_old', 'total 0'),
          pendingBlock,
        ],
      })
      const approval = makePendingApproval({
        requestId: 'req-x',
        toolUseId: 'toolu_new',
        toolName: 'Bash',
        input: { command: 'ls' },
      })
      render(
        <MessageBubble
          message={msg}
          pendingApprovals={[approval]}
          isLastAssistant={true}
          thinkingStartedAt={null}
        />,
      )
      // Exactly one approval prompt visible — not one per matching
      // tool_use block. ToolCallBlockView renders an "Allow" button when
      // isPendingApproval is true; duplicated cards would yield two.
      const allowButtons = screen.getAllByRole('button', { name: /^Allow$/ })
      expect(allowButtons).toHaveLength(1)
    })

    it('falls back to (toolName,input) matching when the approval lacks toolUseId (legacy main-process payload)', () => {
      const block = makeToolUseBlock('Bash', { command: 'pwd' }, 'toolu_xyz')
      const msg = makeChatMessage({ role: 'assistant', content: [block] })
      const approvalWithoutId = makePendingApproval({
        requestId: 'req-legacy',
        // intentionally omit toolUseId
        toolName: 'Bash',
        input: { command: 'pwd' },
      })
      render(
        <MessageBubble
          message={msg}
          pendingApprovals={[approvalWithoutId]}
          isLastAssistant={true}
          thinkingStartedAt={null}
        />,
      )
      expect(screen.getAllByRole('button', { name: /^Allow$/ })).toHaveLength(1)
    })
  })

  describe('system messages', () => {
    it('renders compact separator', () => {
      const msg = makeChatMessage({
        role: 'system',
        content: [{ type: 'compact_separator', text: 'Context compacted' } as any],
      })
      render(
        <MessageBubble message={msg} pendingApprovals={[]} isLastAssistant={false} thinkingStartedAt={null} />
      )
      // CompactSeparator shows "Compacted" label and "Context summary" text
      expect(screen.getByText('Compacted')).toBeInTheDocument()
    })

    it('renders compact separator without summary', () => {
      const msg = makeChatMessage({
        role: 'system',
        content: [{ type: 'compact_separator' } as any],
      })
      render(
        <MessageBubble message={msg} pendingApprovals={[]} isLastAssistant={false} thinkingStartedAt={null} />
      )
      // Without summary, shows "compacted" in lowercase
      expect(screen.getByText('compacted')).toBeInTheDocument()
    })

    it('renders API error block', () => {
      const msg = makeChatMessage({
        role: 'system',
        content: [{ type: 'api_error', errorType: 'overloaded', errorMessage: 'Server busy' } as any],
      })
      render(
        <MessageBubble message={msg} pendingApprovals={[]} isLastAssistant={false} thinkingStartedAt={null} />
      )
      // ApiErrorBlock shows "API Error" header and error type as label
      expect(screen.getByText('API Error')).toBeInTheDocument()
      expect(screen.getByText('Overloaded')).toBeInTheDocument()
    })
  })

  describe('multiple content blocks', () => {
    it('renders thinking + text in order', () => {
      const msg = makeChatMessage({
        role: 'assistant',
        content: [
          makeThinkingBlock('Analyzing the problem...'),
          makeTextBlock('First point'),
          makeTextBlock('Second point'),
        ],
      })
      render(
        <MessageBubble message={msg} pendingApprovals={[]} isLastAssistant={true} thinkingStartedAt={null} />
      )
      expect(screen.getByText(/First point/)).toBeInTheDocument()
      expect(screen.getByText(/Second point/)).toBeInTheDocument()
    })
  })
})
