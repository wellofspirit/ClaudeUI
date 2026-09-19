/**
 * Layer 1: Unit tests for MessageBubble component.
 *
 * Tests pure rendering: given a ChatMessage with specific content blocks,
 * does it render the correct sub-components and structure?
 * No IPC, no business logic — just props in, DOM out.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest'
import { render, screen, act } from '@testing-library/react'
import { MessageBubble } from '../MessageBubble'
import { useSessionStore } from '../../../stores/session-store'
import { resolveOpencodeCapabilities } from '../../../../../shared/model-capabilities'
import type { ToolReviewBlock } from '../../../../../shared/types'
import {
  makeChatMessage,
  makeTextBlock,
  makeToolUseBlock,
  makeToolResultBlock,
  makeThinkingBlock,
  makePendingApproval,
  makeSessionStatus,
  resetFactoryCounter
} from '@test/factories/messages'

// Stub window.api for store operations
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

  // Set up minimal store state for ToolCallBlock (reads from store)
  useSessionStore.setState({
    activeSessionId: 'test-session',
    sessions: {
      'test-session': {
        cwd: '/test',
        sdkActive: false,
        isHistorical: false,
        forkOrigin: null,
        messages: [],
        itemStreams: {},
        itemStreamRevision: 0,
        evicted: false,
        status: makeSessionStatus({ state: 'idle', sessionId: null, model: null, cwd: null }),
        pendingApprovals: [],
        errors: [],
        warnings: [],
        todos: [],
        sentFiles: [],
        taskProgressMap: {},
        taskNotifications: [],
        activeTasks: {},
        openedTaskToolUseIds: [],
        rightPanel: 'none',
        subagentMessages: {},
        bashOutputs: {},
        backgroundOutputs: {},
        backgroundWatcherCounts: {},
        stoppingTaskIds: [],
        isWatching: false,
        needsAttention: false,
        permissionMode: 'default',
        effort: 'medium',
        thinkingMode: 'adaptive',
        reasoningVariant: null,
        statusLine: null,
        metering: null,
        queuedItems: [],
        draftText: '',
        draftAttachments: [],
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
        authRequired: null
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

describe('MessageBubble', () => {
  describe('user messages', () => {
    it('renders user text in a chat bubble', () => {
      const msg = makeChatMessage({
        role: 'user',
        content: [makeTextBlock('Hello Claude')]
      })
      render(<MessageBubble message={msg} pendingApprovals={[]} isLastAssistant={false} />)
      expect(screen.getByText('Hello Claude')).toBeInTheDocument()
    })

    it('renders plan content as ExitPlanModeCard', () => {
      const msg = makeChatMessage({
        role: 'user',
        content: [makeTextBlock('plan text')],
        planContent: '# My Plan\n\nDo things'
      })
      render(<MessageBubble message={msg} pendingApprovals={[]} isLastAssistant={false} />)
      // ExitPlanModeCard renders the plan
      expect(screen.getByText(/My Plan/)).toBeInTheDocument()
    })
  })

  describe('assistant messages', () => {
    it('renders text content blocks', () => {
      const msg = makeChatMessage({
        role: 'assistant',
        content: [makeTextBlock('The answer is 42')]
      })
      render(<MessageBubble message={msg} pendingApprovals={[]} isLastAssistant={true} />)
      expect(screen.getByText(/The answer is 42/)).toBeInTheDocument()
    })

    it('renders tool_use blocks with tool name', () => {
      const msg = makeChatMessage({
        role: 'assistant',
        content: [makeToolUseBlock('Read', { file_path: '/foo.ts' })]
      })
      render(<MessageBubble message={msg} pendingApprovals={[]} isLastAssistant={true} />)
      expect(screen.getByText('Read')).toBeInTheDocument()
    })

    it('hides hidden tool types (EnterPlanMode, TaskCreate, etc.)', () => {
      const msg = makeChatMessage({
        role: 'assistant',
        content: [makeToolUseBlock('EnterPlanMode', {}), makeTextBlock('After plan mode')]
      })
      render(<MessageBubble message={msg} pendingApprovals={[]} isLastAssistant={true} />)
      // EnterPlanMode should not render — but text after it should
      expect(screen.getByText(/After plan mode/)).toBeInTheDocument()
      expect(screen.queryByText('EnterPlanMode')).not.toBeInTheDocument()
    })

    it('renders thinking blocks when present', () => {
      const msg = makeChatMessage({
        role: 'assistant',
        content: [
          makeThinkingBlock('Let me think about this carefully...'),
          makeTextBlock('Here is my answer')
        ]
      })
      render(<MessageBubble message={msg} pendingApprovals={[]} isLastAssistant={true} />)
      expect(screen.getByText(/Here is my answer/)).toBeInTheDocument()
    })

    it('hides an empty inactive thinking slot', () => {
      const msg = makeChatMessage({
        role: 'assistant',
        content: [makeThinkingBlock(''), makeTextBlock('Visible answer')]
      })
      render(<MessageBubble message={msg} pendingApprovals={[]} isLastAssistant={true} />)
      expect(screen.queryByTestId('ThinkingBlock')).not.toBeInTheDocument()
      expect(screen.getByText(/Visible answer/)).toBeInTheDocument()
    })

    it('renders tool_use with tool_result together', () => {
      const toolUseId = 'tool-123'
      const msg = makeChatMessage({
        role: 'assistant',
        content: [
          makeToolUseBlock('Bash', { command: 'echo hello' }, toolUseId),
          makeToolResultBlock(toolUseId, 'hello')
        ]
      })
      render(<MessageBubble message={msg} pendingApprovals={[]} isLastAssistant={true} />)
      expect(screen.getByText('Bash')).toBeInTheDocument()
    })

    it('renders TodoWrite tool as TodoToolBlock', () => {
      const msg = makeChatMessage({
        role: 'assistant',
        content: [
          makeToolUseBlock('TodoWrite', {
            todos: [{ content: 'Task 1', status: 'pending', activeForm: 'Working on task 1' }]
          })
        ]
      })
      render(<MessageBubble message={msg} pendingApprovals={[]} isLastAssistant={true} />)
      // TodoToolBlock renders the task list — verify the component rendered
      const container = document.querySelector('[class*="animate-fade-in"]')
      expect(container).toBeInTheDocument()
    })

    it('renders Agent/Task tool as TaskCard', () => {
      const msg = makeChatMessage({
        role: 'assistant',
        content: [
          makeToolUseBlock('Agent', { description: 'Search codebase', prompt: 'find files' })
        ]
      })
      render(<MessageBubble message={msg} pendingApprovals={[]} isLastAssistant={true} />)
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
          pendingBlock
        ]
      })
      const approval = makePendingApproval({
        requestId: 'req-x',
        toolUseId: 'toolu_new',
        toolName: 'Bash',
        input: { command: 'ls' }
      })
      render(<MessageBubble message={msg} pendingApprovals={[approval]} isLastAssistant={true} />)
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
        input: { command: 'pwd' }
      })
      render(
        <MessageBubble
          message={msg}
          pendingApprovals={[approvalWithoutId]}
          isLastAssistant={true}
        />
      )
      expect(screen.getAllByRole('button', { name: /^Allow$/ })).toHaveLength(1)
    })

    // A Codex guardian-denial override binds to an ALREADY DECLINED card: the
    // tool_use has its error result, and the offer is to let Codex retry it.
    // Nothing is pending on this click, so it must not float either.
    it('binds a guardian override to the declined card it names', () => {
      act(() => {
        useSessionStore.setState((state) => ({
          sessions: {
            ...state.sessions,
            'test-session': {
              ...state.sessions['test-session'],
              status: { ...state.sessions['test-session'].status, engineId: 'codex' as const }
            }
          }
        }))
      })
      const toolUseId = 'codex:["root","turn","esc"]'
      const block = makeToolUseBlock('commandExecution', { command: 'rm -rf x' }, toolUseId)
      const msg = makeChatMessage({
        role: 'assistant',
        content: [block, makeToolResultBlock(toolUseId, 'rejected: unacceptable risk')]
      })
      const approval = makePendingApproval({
        requestId: 'codex-guardian:gen:item:review-1',
        toolUseId,
        toolName: 'commandExecution',
        input: { command: 'rm -rf x' },
        decisionReason: 'Codex auto-review denied this action.',
        codex: { guardianOverride: true }
      })
      render(<MessageBubble message={msg} pendingApprovals={[approval]} isLastAssistant={true} />)
      expect(screen.getByTestId('ApprovalButtons.approveAnyway')).toBeInTheDocument()
      expect(screen.getByTestId('ApprovalButtons.dismiss')).toBeInTheDocument()
      expect(screen.queryByTestId('ApprovalButtons.allow')).not.toBeInTheDocument()
    })
  })

  /**
   * F18 — a review verdict is bound to the card of the call it judged, by
   * `toolUseId` and nothing else. The LAST verdict for a call wins: a re-review
   * after "approve anyway" is a new decision, not a second opinion.
   */
  describe('review → tool_use binding', () => {
    const review = (toolUseId: string, over: Partial<ToolReviewBlock> = {}): ToolReviewBlock => ({
      type: 'tool_review',
      toolUseId,
      reviewId: `rv-${toolUseId}`,
      reviewer: 'codex-auto-review',
      decision: 'approved',
      riskLevel: 'low',
      ...over
    })

    it('reaches only the card whose toolUseId matches', () => {
      const msg = makeChatMessage({
        role: 'assistant',
        content: [
          makeToolUseBlock('Bash', { command: 'ls' }, 'toolu_a'),
          makeToolUseBlock('Bash', { command: 'pwd' }, 'toolu_b'),
          review('toolu_b', { decision: 'denied' })
        ]
      })
      render(<MessageBubble message={msg} pendingApprovals={[]} isLastAssistant={true} />)
      const chips = screen.getAllByTestId('ToolCard.reviewChip')
      expect(chips).toHaveLength(1)
      expect(chips[0]).toHaveTextContent('Auto-review · denied · low')
    })

    it('shows the LAST verdict when a call was reviewed twice', () => {
      const msg = makeChatMessage({
        role: 'assistant',
        content: [
          makeToolUseBlock('Bash', { command: 'ls' }, 'toolu_a'),
          review('toolu_a', { reviewId: 'rv-1', decision: 'denied' }),
          review('toolu_a', { reviewId: 'rv-2', decision: 'approved' })
        ]
      })
      render(<MessageBubble message={msg} pendingApprovals={[]} isLastAssistant={true} />)
      expect(screen.getByTestId('ToolCard.reviewChip')).toHaveTextContent(
        'Auto-review · approved · low'
      )
    })

    it('renders no stray row for the verdict block itself', () => {
      const msg = makeChatMessage({
        role: 'assistant',
        content: [
          makeToolUseBlock('Bash', { command: 'ls' }, 'toolu_a'),
          review('toolu_a', { rationale: 'Reads only.' })
        ]
      })
      const { container } = render(
        <MessageBubble message={msg} pendingApprovals={[]} isLastAssistant={true} />
      )
      // The rationale appears only inside the card's own strip, never loose in
      // the transcript — the card is collapsed here, so not at all.
      expect(container.textContent).not.toContain('Reads only.')
    })
  })

  describe('system messages', () => {
    it('renders compact separator', () => {
      const msg = makeChatMessage({
        role: 'system',
        content: [{ type: 'compact_separator', text: 'Context compacted' } as any]
      })
      render(<MessageBubble message={msg} pendingApprovals={[]} isLastAssistant={false} />)
      // CompactSeparator shows "Compacted" label and "Context summary" text
      expect(screen.getByText('Compacted')).toBeInTheDocument()
    })

    it('renders compact separator without summary', () => {
      const msg = makeChatMessage({
        role: 'system',
        content: [{ type: 'compact_separator' } as any]
      })
      render(<MessageBubble message={msg} pendingApprovals={[]} isLastAssistant={false} />)
      // Without summary, shows "compacted" in lowercase
      expect(screen.getByText('compacted')).toBeInTheDocument()
    })

    it('renders a plain text notice — Codex auto-review rows arrive as one', () => {
      // Codex's `auto` guardian decisions have no tool call, no diff and no
      // error to hang off: a text block on a system row is the whole row, and
      // before this it fell through the block switch and rendered nothing.
      const msg = makeChatMessage({
        role: 'system',
        content: [
          { type: 'text', text: 'Codex auto-review approved `ls` (risk: low). Looks safe.' }
        ]
      })
      render(<MessageBubble message={msg} pendingApprovals={[]} isLastAssistant={false} />)
      const notice = screen.getByTestId('MessageBubble.systemNotice')
      expect(notice).toHaveTextContent('Codex auto-review approved `ls` (risk: low). Looks safe.')
      // Untrusted model text: rendered verbatim, never as markdown/HTML.
      expect(notice.querySelector('code')).toBeNull()
    })

    it('renders API error block', () => {
      const msg = makeChatMessage({
        role: 'system',
        content: [
          { type: 'api_error', errorType: 'overloaded', errorMessage: 'Server busy' } as any
        ]
      })
      render(<MessageBubble message={msg} pendingApprovals={[]} isLastAssistant={false} />)
      // ApiErrorBlock shows "API Error" header and error type as label
      expect(screen.getByText('API Error')).toBeInTheDocument()
      expect(screen.getByText('Overloaded')).toBeInTheDocument()
    })

    /**
     * ADR-070 §4: the selection point, and that the SETTLED row (no owed sign-in
     * on the session, which is what a reloaded transcript always restores to) has
     * no action on it. The three lifetimes and every action live in
     * `AuthTranscriptRow.component.test.tsx`.
     */
    it('renders the engine-neutral auth row, not the generic API-error card', () => {
      useSessionStore.setState({ authState: null, signInDialog: null })
      const msg = makeChatMessage({
        role: 'system',
        content: [
          {
            type: 'api_error',
            errorType: 'authentication',
            errorMessage: 'API Error: 401 Invalid authentication credentials'
          } as any
        ]
      })
      render(<MessageBubble message={msg} pendingApprovals={[]} isLastAssistant={false} />)
      expect(screen.getByTestId('AuthTranscriptRow')).toHaveTextContent('Turn stopped')
      expect(screen.queryByText('API Error')).not.toBeInTheDocument()
    })

    it('a settled row offers no sign-in and nothing to dismiss', () => {
      useSessionStore.setState({ authState: null, signInDialog: null })
      const msg = makeChatMessage({
        role: 'system',
        content: [{ type: 'api_error', errorType: 'authentication', errorMessage: '401' } as any]
      })
      render(<MessageBubble message={msg} pendingApprovals={[]} isLastAssistant={false} />)
      const row = screen.getByTestId('AuthTranscriptRow')
      expect(row).toHaveAttribute('data-lifetime', 'settled')
      expect(screen.queryByTestId('AuthTranscriptRow.signIn')).not.toBeInTheDocument()
      expect(screen.queryByTestId('AuthTranscriptRow.retry')).not.toBeInTheDocument()
      expect(screen.queryByText('Dismiss')).not.toBeInTheDocument()
    })

    it('a global flow state cannot turn this row into a success card (no retry loop)', () => {
      // The card used to mirror `authState`, which is how a freshly arrived
      // error could inherit someone else's "success" and offer a Retry that
      // re-failed. It renders the session's own auth fact now, and nothing else.
      useSessionStore.setState({
        authState: {
          status: 'success',
          account: { email: 'user@example.com', organization: null, subscriptionType: 'max' },
          error: null
        }
      })
      const msg = makeChatMessage({
        role: 'system',
        content: [{ type: 'api_error', errorType: 'authentication', errorMessage: '401' } as any]
      })
      render(<MessageBubble message={msg} pendingApprovals={[]} isLastAssistant={false} />)
      expect(screen.getByTestId('AuthTranscriptRow')).toBeInTheDocument()
      expect(screen.queryByText('Signed in as user@example.com')).not.toBeInTheDocument()
      expect(screen.queryByTestId('AuthTranscriptRow.retry')).not.toBeInTheDocument()
    })
  })

  describe('multiple content blocks', () => {
    it('renders thinking + text in order', () => {
      const msg = makeChatMessage({
        role: 'assistant',
        content: [
          makeThinkingBlock('Analyzing the problem...'),
          makeTextBlock('First point'),
          makeTextBlock('Second point')
        ]
      })
      render(<MessageBubble message={msg} pendingApprovals={[]} isLastAssistant={true} />)
      expect(screen.getByText(/First point/)).toBeInTheDocument()
      expect(screen.getByText(/Second point/)).toBeInTheDocument()
    })
  })

  describe('fork affordance (capability-gated)', () => {
    it('shows Fork for a Claude session', () => {
      const msg = makeChatMessage({
        role: 'assistant',
        content: [makeTextBlock('hi')]
      })
      render(<MessageBubble message={msg} pendingApprovals={[]} isLastAssistant={true} />)
      expect(screen.queryByTestId('MessageBubble.fork')).toBeInTheDocument()
    })

    it('hides Fork for an opencode session', () => {
      act(() => {
        useSessionStore.setState((s) => ({
          sessions: {
            ...s.sessions,
            'test-session': {
              ...s.sessions['test-session'],
              status: makeSessionStatus({
                engineId: 'opencode',
                capabilities: resolveOpencodeCapabilities()
              })
            }
          }
        }))
      })
      const msg = makeChatMessage({
        role: 'assistant',
        content: [makeTextBlock('hi')]
      })
      render(<MessageBubble message={msg} pendingApprovals={[]} isLastAssistant={true} />)
      expect(screen.queryByTestId('MessageBubble.fork')).not.toBeInTheDocument()
    })
  })
})

/**
 * F20 — the ROUTING the new rows depend on. The components themselves are
 * covered by their own unit files; what is pinned here is that MessageBubble
 * reaches them at all: two new system `ContentBlock`s in the system switch, and
 * the `sleep` kind lifted out of the card shell the way `todo` is.
 */
describe('MessageBubble — F20 rows', () => {
  const codex = (): void => {
    act(() => {
      useSessionStore.setState((state) => ({
        sessions: {
          ...state.sessions,
          'test-session': {
            ...state.sessions['test-session'],
            status: { ...state.sessions['test-session'].status, engineId: 'codex' as const }
          }
        }
      }))
    })
  }

  it('routes a context_note system block to ContextNoteBlock', () => {
    const msg = makeChatMessage({
      role: 'system',
      content: [
        {
          type: 'context_note',
          title: 'Injected context',
          fragments: [{ text: 'policy', label: '9f2a' }]
        }
      ]
    })
    render(<MessageBubble message={msg} pendingApprovals={[]} isLastAssistant={false} />)
    expect(screen.getByTestId('ContextNoteBlock')).toBeInTheDocument()
  })

  it('routes a review_result system block to ReviewResultCard', () => {
    const msg = makeChatMessage({
      role: 'system',
      content: [{ type: 'review_result', text: 'Two findings need attention.' }]
    })
    render(<MessageBubble message={msg} pendingApprovals={[]} isLastAssistant={false} />)
    expect(screen.getByTestId('ReviewResultCard')).toBeInTheDocument()
  })

  it('lifts a Codex sleep tool_use out of the card shell into SleepRow', () => {
    codex()
    const msg = makeChatMessage({
      role: 'assistant',
      content: [makeToolUseBlock('sleep', { durationMs: 2500 }, 'tu-sleep')]
    })
    render(<MessageBubble message={msg} pendingApprovals={[]} isLastAssistant={true} />)
    expect(screen.getByTestId('SleepRow')).toBeInTheDocument()
    expect(screen.queryByTestId('ToolCard')).not.toBeInTheDocument()
  })
})
