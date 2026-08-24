/**
 * Layer 2: Component tests for FloatingApproval approval response flow.
 *
 * Tests the business logic: user responds to approval → IPC call → store update.
 * Uses TestIpcBridge as Electron transport shim.
 *
 * Two describe blocks:
 *
 * 1. "FloatingApproval approval response flow" — store-only tests using
 *    simulateApprovalResponse (no rendering). Covers all decision variants,
 *    sandbox exclusion logic, and suggestion filtering.
 *
 * 2. "FloatingApproval rendered component" — renders <FloatingApproval /> and
 *    clicks Allow/Deny via DOM to exercise the full component path (hooks →
 *    handleRespond → IPC → store).
 *
 * The FloatingApproval component:
 * 1. Reads pending approvals from the store (populated by session:approval-request events)
 * 2. When user responds: calls window.api.respondApproval() → IPC → main process
 * 3. Then removes the approval from the store
 * 4. Optionally updates sandbox exclusions and forwards permission suggestions
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, act } from '@testing-library/react'
import { TestIpcBridge } from '@test/bridges/test-ipc-bridge'
import { useSessionStore } from '../../../stores/session-store'
import { makePendingApproval, resetFactoryCounter } from '@test/factories/messages'
import type { PendingApproval, PermissionSuggestion } from '../../../../../shared/types'
import { FloatingApproval } from '../FloatingApproval'
import { seed, resetReplicaSeam, mirrorStoreIntoReplica } from '@test/helpers/replica-seed'

let bridge: TestIpcBridge

/** Captured args from the most recent approval-response IPC call */
let lastApprovalResponse: {
  routingId: string
  requestId: string
  decision: string
  answers: Record<string, string> | undefined
  suggestions: PermissionSuggestion[] | undefined
} | null = null

beforeEach(() => {
  // The replica is a module singleton holding canonical state: resetting only the
  // store would leave the two disagreeing and the next projection would resurrect
  // the previous test's sessions (SyncCore phase 4c).
  resetReplicaSeam()
  bridge = new TestIpcBridge()
  resetFactoryCounter()
  lastApprovalResponse = null

  // Register handler for approval-response IPC (what respondApproval calls)
  bridge.ipcMain.handle(
    'session:approval-response',
    (_event, routingId, requestId, decision, answers, suggestions) => {
      lastApprovalResponse = { routingId, requestId, decision, answers, suggestions }
    }
  )

  // Stub other IPC channels the store calls internally
  bridge.ipcMain.handle('config:save-sessions', () => {})

  // Build window.api backed by the bridge
  ;(globalThis as any).window = globalThis.window || {}
  ;(globalThis as any).window.api = {
    respondApproval: (
      routingId: string,
      requestId: string,
      decision: string,
      answers?: Record<string, string>,
      suggestions?: PermissionSuggestion[]
    ) =>
      bridge.ipcRenderer.invoke(
        'session:approval-response',
        routingId,
        requestId,
        decision,
        answers,
        suggestions
      ),
    saveSessionConfig: () => {},
    saveSlashCommands: () => {},
    saveSettings: () => {},
    logError: () => {},
    fetchAccountUsage: () => Promise.resolve(null),
    fetchBlockUsage: () => Promise.resolve(null),
    getPluginViews: () => Promise.resolve([])
  }

  // Reset store (sessions + settings that tests mutate)
  useSessionStore.setState({
    activeSessionId: null,
    sessions: {},
    directories: [],
    recentSessionIds: [],
    pinnedSessionIds: [],
    customTitles: {}
  })
  mirrorStoreIntoReplica()
  // Reset sandbox exclusions (mutated by sandbox escape tests)
  const currentSandbox = useSessionStore.getState().engineConfig.sandbox
  if (currentSandbox) {
    useSessionStore
      .getState()
      .setEngineConfig({ sandbox: { ...currentSandbox, excludedCommands: [] } })
  }
})

afterEach(() => {
  bridge.reset()
})

/**
 * Simulate what the FloatingApproval component's handleRespond does:
 * read store state, make decisions, call IPC, update store.
 *
 * This mirrors the logic in ApprovalCard's handleRespond — the same code
 * that would execute when a user clicks Allow/Deny.
 */
async function simulateApprovalResponse(
  decision: 'allow' | 'deny',
  opts: {
    alwaysAllow?: boolean
    checkedSuggestions?: boolean[]
  } = {}
): Promise<void> {
  const { activeSessionId, sessions, dismissApproval, engineConfig, setEngineConfig } =
    useSessionStore.getState()
  if (!activeSessionId) return

  const session = sessions[activeSessionId]
  if (!session || session.pendingApprovals.length === 0) return

  const approval = session.pendingApprovals[0]
  const alwaysAllow = opts.alwaysAllow ?? false
  const checkedSuggestions =
    opts.checkedSuggestions ?? (approval.suggestions || []).map(() => false)
  const sandboxSettings = engineConfig.sandbox
  const isSandboxEscape = !!approval.input?.dangerouslyDisableSandbox

  // Sandbox exclusion logic
  if (decision === 'allow' && alwaysAllow && isSandboxEscape && approval.input?.command) {
    const cmd = String(approval.input.command)
    const currentExcluded = sandboxSettings?.excludedCommands ?? []
    if (!currentExcluded.includes(cmd)) {
      const nextSandbox = sandboxSettings
        ? { ...sandboxSettings, excludedCommands: [...currentExcluded, cmd] }
        : {
            enabled: false,
            autoAllowBashIfSandboxed: false,
            allowUnsandboxedCommands: false,
            network: {
              restrictNetwork: false,
              allowLocalBinding: false,
              allowedDomains: [],
              allowManagedDomainsOnly: false,
              allowAllUnixSockets: false,
              allowUnixSockets: []
            },
            filesystem: { allowWrite: [], denyWrite: [], denyRead: [] },
            excludedCommands: [cmd]
          }
      setEngineConfig({ ...engineConfig, sandbox: nextSandbox })
    }
  }

  // Permission suggestions
  const selected =
    decision === 'allow' && approval.suggestions
      ? approval.suggestions.filter((_, i) => checkedSuggestions[i])
      : undefined

  await window.api.respondApproval(
    activeSessionId,
    approval.requestId,
    decision,
    undefined,
    selected?.length ? selected : undefined
  )
  dismissApproval(activeSessionId, approval.requestId)
}

// ---------------------------------------------------------------------------
// Store-logic tests (no rendering)
// ---------------------------------------------------------------------------

describe('FloatingApproval approval response flow', () => {
  const ROUTE = 'route-1'

  function setup(approvalOverrides?: Partial<PendingApproval>): PendingApproval {
    useSessionStore.getState().createNewSession(ROUTE, '/test')
    useSessionStore.setState({ activeSessionId: ROUTE })

    const approval = makePendingApproval(approvalOverrides)
    seed.approvalRequest(ROUTE, approval)
    return approval
  }

  it('sends allow decision via IPC and removes approval from store', async () => {
    const approval = setup({ toolName: 'Bash', input: { command: 'echo hello' } })

    await simulateApprovalResponse('allow')

    // IPC called correctly
    expect(lastApprovalResponse).toEqual({
      routingId: ROUTE,
      requestId: approval.requestId,
      decision: 'allow',
      answers: undefined,
      suggestions: undefined
    })

    // Store cleaned up
    expect(useSessionStore.getState().sessions[ROUTE].pendingApprovals).toHaveLength(0)
  })

  it('sends deny decision via IPC and removes approval from store', async () => {
    const approval = setup({ toolName: 'Read', input: { file_path: '/etc/passwd' } })

    await simulateApprovalResponse('deny')

    expect(lastApprovalResponse).toEqual({
      routingId: ROUTE,
      requestId: approval.requestId,
      decision: 'deny',
      answers: undefined,
      suggestions: undefined
    })

    expect(useSessionStore.getState().sessions[ROUTE].pendingApprovals).toHaveLength(0)
  })

  it('includes checked permission suggestions on allow', async () => {
    const suggestions: PermissionSuggestion[] = [
      {
        type: 'addRules',
        destination: 'projectSettings',
        rules: [{ toolName: 'Bash', ruleContent: 'echo *' }]
      },
      {
        type: 'addRules',
        destination: 'userSettings',
        rules: [{ toolName: 'Read', ruleContent: '/tmp/*' }]
      }
    ]
    setup({ toolName: 'Bash', input: { command: 'echo test' }, suggestions })

    await simulateApprovalResponse('allow', { checkedSuggestions: [false, true] })

    expect(lastApprovalResponse!.suggestions).toEqual([suggestions[1]])
  })

  it('omits suggestions when none are checked', async () => {
    const suggestions: PermissionSuggestion[] = [
      {
        type: 'addRules',
        destination: 'projectSettings',
        rules: [{ toolName: 'Bash', ruleContent: 'echo *' }]
      }
    ]
    setup({ toolName: 'Bash', input: { command: 'echo test' }, suggestions })

    await simulateApprovalResponse('allow', { checkedSuggestions: [false] })

    expect(lastApprovalResponse!.suggestions).toBeUndefined()
  })

  it('omits suggestions on deny even when checked', async () => {
    const suggestions: PermissionSuggestion[] = [
      {
        type: 'addRules',
        destination: 'projectSettings',
        rules: [{ toolName: 'Bash', ruleContent: 'echo *' }]
      }
    ]
    setup({ toolName: 'Bash', input: { command: 'echo test' }, suggestions })

    await simulateApprovalResponse('deny', { checkedSuggestions: [true] })

    expect(lastApprovalResponse!.suggestions).toBeUndefined()
  })

  it('adds command to sandbox exclusion list on allow with alwaysAllow for sandbox escape', async () => {
    setup({
      toolName: 'Bash',
      input: { command: 'dangerous-cmd', dangerouslyDisableSandbox: true }
    })

    await simulateApprovalResponse('allow', { alwaysAllow: true })

    const sandbox = useSessionStore.getState().engineConfig.sandbox
    expect(sandbox?.excludedCommands).toContain('dangerous-cmd')
  })

  it('does not add to sandbox exclusions on deny', async () => {
    setup({
      toolName: 'Bash',
      input: { command: 'dangerous-cmd', dangerouslyDisableSandbox: true }
    })

    await simulateApprovalResponse('deny', { alwaysAllow: true })

    const sandbox = useSessionStore.getState().engineConfig.sandbox
    expect(sandbox?.excludedCommands ?? []).not.toContain('dangerous-cmd')
  })

  it('does not add to sandbox exclusions when alwaysAllow is false', async () => {
    setup({
      toolName: 'Bash',
      input: { command: 'dangerous-cmd', dangerouslyDisableSandbox: true }
    })

    await simulateApprovalResponse('allow', { alwaysAllow: false })

    const sandbox = useSessionStore.getState().engineConfig.sandbox
    expect(sandbox?.excludedCommands ?? []).not.toContain('dangerous-cmd')
  })

  it('does not duplicate command in sandbox exclusion list', async () => {
    // Pre-populate exclusion list
    const store = useSessionStore.getState()
    const existing = store.engineConfig.sandbox
    store.setEngineConfig({
      ...store.engineConfig,
      sandbox: existing
        ? { ...existing, excludedCommands: ['dangerous-cmd'] }
        : {
            enabled: false,
            autoAllowBashIfSandboxed: false,
            allowUnsandboxedCommands: false,
            network: {
              restrictNetwork: false,
              allowLocalBinding: false,
              allowedDomains: [],
              allowManagedDomainsOnly: false,
              allowAllUnixSockets: false,
              allowUnixSockets: []
            },
            filesystem: { allowWrite: [], denyWrite: [], denyRead: [] },
            excludedCommands: ['dangerous-cmd']
          }
    })

    setup({
      toolName: 'Bash',
      input: { command: 'dangerous-cmd', dangerouslyDisableSandbox: true }
    })

    await simulateApprovalResponse('allow', { alwaysAllow: true })

    const sandbox = useSessionStore.getState().engineConfig.sandbox
    expect(
      (sandbox?.excludedCommands ?? []).filter((c: string) => c === 'dangerous-cmd')
    ).toHaveLength(1)
  })

  it('does not modify sandbox exclusions for non-sandbox-escape approvals', async () => {
    setup({
      toolName: 'Bash',
      input: { command: 'echo hello' } // no dangerouslyDisableSandbox
    })

    await simulateApprovalResponse('allow', { alwaysAllow: true })

    const sandbox = useSessionStore.getState().engineConfig.sandbox
    expect(sandbox?.excludedCommands ?? []).not.toContain('echo hello')
  })

  it('does nothing when no active session', async () => {
    setup({ toolName: 'Bash', input: { command: 'echo hello' } })
    useSessionStore.setState({ activeSessionId: null })

    await simulateApprovalResponse('allow')

    expect(lastApprovalResponse).toBeNull()
  })

  it('handles multiple approvals - responding to first leaves second intact', async () => {
    useSessionStore.getState().createNewSession(ROUTE, '/test')
    useSessionStore.setState({ activeSessionId: ROUTE })

    const approval1 = makePendingApproval({ toolName: 'Bash', input: { command: 'ls' } })
    const approval2 = makePendingApproval({ toolName: 'Read', input: { file_path: '/foo' } })
    seed.approvalRequest(ROUTE, approval1)
    seed.approvalRequest(ROUTE, approval2)

    // Respond to first only
    await simulateApprovalResponse('allow')

    const remaining = useSessionStore.getState().sessions[ROUTE].pendingApprovals
    expect(remaining).toHaveLength(1)
    expect(remaining[0].requestId).toBe(approval2.requestId)
  })
})

// ---------------------------------------------------------------------------
// Rendered component tests — exercises the real component DOM path
// ---------------------------------------------------------------------------

describe('FloatingApproval rendered component', () => {
  const ROUTE = 'route-render'

  function setup(approvalOverrides?: Partial<PendingApproval>): PendingApproval {
    useSessionStore.getState().createNewSession(ROUTE, '/test')
    useSessionStore.setState({ activeSessionId: ROUTE })

    const approval = makePendingApproval(approvalOverrides)
    seed.approvalRequest(ROUTE, approval)
    return approval
  }

  it('renders Allow and Deny buttons for a pending approval', () => {
    setup({ toolName: 'Bash', input: { command: 'echo hello' } })

    render(<FloatingApproval />)

    expect(screen.getByText('Allow')).toBeInTheDocument()
    expect(screen.getByText('Deny')).toBeInTheDocument()
  })

  it('renders nothing when there are no pending approvals', () => {
    useSessionStore.getState().createNewSession(ROUTE, '/test')
    useSessionStore.setState({ activeSessionId: ROUTE })

    const { container } = render(<FloatingApproval />)

    expect(container.firstChild).toBeNull()
  })

  it('clicking Allow calls respondApproval IPC and removes approval from store', async () => {
    const approval = setup({ toolName: 'Bash', input: { command: 'echo hello' } })

    render(<FloatingApproval />)

    await act(async () => {
      fireEvent.click(screen.getByText('Allow'))
    })

    expect(lastApprovalResponse).toEqual({
      routingId: ROUTE,
      requestId: approval.requestId,
      decision: 'allow',
      answers: undefined,
      suggestions: undefined
    })

    expect(useSessionStore.getState().sessions[ROUTE].pendingApprovals).toHaveLength(0)
  })

  it('clicking Deny calls respondApproval IPC and removes approval from store', async () => {
    const approval = setup({ toolName: 'Read', input: { file_path: '/etc/passwd' } })

    render(<FloatingApproval />)

    await act(async () => {
      fireEvent.click(screen.getByText('Deny'))
    })

    expect(lastApprovalResponse).toEqual({
      routingId: ROUTE,
      requestId: approval.requestId,
      decision: 'deny',
      answers: undefined,
      suggestions: undefined
    })

    expect(useSessionStore.getState().sessions[ROUTE].pendingApprovals).toHaveLength(0)
  })

  it('clicking Allow with checked suggestions forwards them via IPC', async () => {
    const suggestions: PermissionSuggestion[] = [
      {
        type: 'addRules',
        destination: 'projectSettings',
        rules: [{ toolName: 'Bash', ruleContent: 'echo *' }]
      },
      {
        type: 'addRules',
        destination: 'userSettings',
        rules: [{ toolName: 'Read', ruleContent: '/tmp/*' }]
      }
    ]
    setup({ toolName: 'Bash', input: { command: 'echo test' }, suggestions })

    render(<FloatingApproval />)

    // Check the second suggestion checkbox (index 1)
    const checkboxes = screen.getAllByRole('checkbox')
    await act(async () => {
      fireEvent.click(checkboxes[1])
    })

    await act(async () => {
      fireEvent.click(screen.getByText('Allow'))
    })

    expect(lastApprovalResponse!.suggestions).toEqual([suggestions[1]])
  })

  it('clicking Deny omits suggestions even when checkboxes are checked', async () => {
    const suggestions: PermissionSuggestion[] = [
      {
        type: 'addRules',
        destination: 'projectSettings',
        rules: [{ toolName: 'Bash', ruleContent: 'echo *' }]
      }
    ]
    setup({ toolName: 'Bash', input: { command: 'echo test' }, suggestions })

    render(<FloatingApproval />)

    const checkboxes = screen.getAllByRole('checkbox')
    await act(async () => {
      fireEvent.click(checkboxes[0])
    })

    await act(async () => {
      fireEvent.click(screen.getByText('Deny'))
    })

    expect(lastApprovalResponse!.suggestions).toBeUndefined()
  })

  it('renders both cards when two approvals are pending', () => {
    useSessionStore.getState().createNewSession(ROUTE, '/test')
    useSessionStore.setState({ activeSessionId: ROUTE })

    const approval1 = makePendingApproval({ toolName: 'Bash', input: { command: 'ls' } })
    const approval2 = makePendingApproval({ toolName: 'Read', input: { file_path: '/foo' } })
    seed.approvalRequest(ROUTE, approval1)
    seed.approvalRequest(ROUTE, approval2)

    render(<FloatingApproval />)

    // Two Allow and two Deny buttons
    expect(screen.getAllByText('Allow')).toHaveLength(2)
    expect(screen.getAllByText('Deny')).toHaveLength(2)
  })

  it('clicking Allow on first card leaves the second card visible', async () => {
    useSessionStore.getState().createNewSession(ROUTE, '/test')
    useSessionStore.setState({ activeSessionId: ROUTE })

    const approval1 = makePendingApproval({ toolName: 'Bash', input: { command: 'ls' } })
    const approval2 = makePendingApproval({ toolName: 'Read', input: { file_path: '/foo' } })
    seed.approvalRequest(ROUTE, approval1)
    seed.approvalRequest(ROUTE, approval2)

    render(<FloatingApproval />)

    // Click Allow on the first card
    const allowButtons = screen.getAllByText('Allow')
    await act(async () => {
      fireEvent.click(allowButtons[0])
    })

    // One card remains
    expect(screen.getAllByText('Allow')).toHaveLength(1)
    expect(screen.getAllByText('Deny')).toHaveLength(1)

    const remaining = useSessionStore.getState().sessions[ROUTE].pendingApprovals
    expect(remaining).toHaveLength(1)
    expect(remaining[0].requestId).toBe(approval2.requestId)
  })
})

// ---------------------------------------------------------------------------
// "Allow for session" button — not shown (no producer until opencode Phase 5)
// ---------------------------------------------------------------------------

describe('FloatingApproval "Allow for session" button', () => {
  it('does NOT render "Allow for session" button for a Claude session (no producer)', () => {
    useSessionStore.setState({ lastSelectedEngineId: 'claude' })
    useSessionStore.getState().createNewSession('route-claude', '/test')
    useSessionStore.setState({ activeSessionId: 'route-claude' })

    const approval = makePendingApproval({ toolName: 'Shell', input: { command: 'ls' } })
    seed.approvalRequest('route-claude', approval)

    render(<FloatingApproval />)

    expect(screen.queryByText('Allow for session')).toBeNull()
    // Normal Allow + Deny still present
    expect(screen.getByText('Allow')).toBeInTheDocument()
    expect(screen.getByText('Deny')).toBeInTheDocument()
  })
})

// ---------------------------------------------------------------------------
// AskUserQuestion floating card (child subagent question hang-fix)
//
// An unmatched AskUserQuestion approval must render the question UI (not
// ApprovalCard), and submit/dismiss must call respondApproval correctly.
// A non-question approval must still render ApprovalCard.
// ---------------------------------------------------------------------------

describe('FloatingApproval — AskUserQuestion floating card (child question)', () => {
  const ROUTE = 'route-float-q'

  function makeQuestionApproval(requestId = 'req-q-float'): PendingApproval {
    return {
      requestId,
      toolName: 'AskUserQuestion',
      toolUseId: 'child_q_call_float',
      input: {
        questions: [
          {
            question: 'Pick one',
            header: 'Choice',
            options: [
              { label: 'Option A', description: '' },
              { label: 'Option B', description: '' }
            ],
            multiSelect: false
          }
        ]
      }
    }
  }

  function setup(overrides?: Partial<PendingApproval>): PendingApproval {
    useSessionStore.getState().createNewSession(ROUTE, '/test')
    useSessionStore.setState({ activeSessionId: ROUTE })
    const approval = makeQuestionApproval()
    const merged = { ...approval, ...overrides }
    seed.approvalRequest(ROUTE, merged)
    return merged
  }

  it('renders question UI (Question label) for an AskUserQuestion approval, NOT ApprovalCard', () => {
    setup()
    render(<FloatingApproval />)
    // AskUserQuestionBlockView renders a "Question" heading — not "Permission" or "Allow"/"Deny"
    expect(screen.getByText('Question')).toBeInTheDocument()
    // ApprovalCard's "Permission" label must NOT appear
    expect(screen.queryByText('Permission')).toBeNull()
  })

  it('options are visible in the rendered question card', () => {
    setup()
    render(<FloatingApproval />)
    expect(screen.getByText('Option A')).toBeInTheDocument()
    expect(screen.getByText('Option B')).toBeInTheDocument()
  })

  it('submitting an answer calls respondApproval(allow, answers) and removes approval', async () => {
    const approval = setup()
    render(<FloatingApproval />)

    // Select Option A
    await act(async () => {
      fireEvent.click(screen.getByText('Option A'))
    })

    // Click Submit
    await act(async () => {
      fireEvent.click(screen.getByText('Submit'))
    })

    expect(lastApprovalResponse).toEqual({
      routingId: ROUTE,
      requestId: approval.requestId,
      decision: 'allow',
      answers: { 'Pick one': 'Option A' },
      suggestions: undefined
    })
    expect(useSessionStore.getState().sessions[ROUTE].pendingApprovals).toHaveLength(0)
  })

  it('clicking Dismiss calls respondApproval(deny) and removes approval', async () => {
    const approval = setup()
    render(<FloatingApproval />)

    await act(async () => {
      fireEvent.click(screen.getByText('Dismiss'))
    })

    expect(lastApprovalResponse).toEqual({
      routingId: ROUTE,
      requestId: approval.requestId,
      decision: 'deny',
      answers: undefined,
      suggestions: undefined
    })
    expect(useSessionStore.getState().sessions[ROUTE].pendingApprovals).toHaveLength(0)
  })

  it('a permission approval still renders ApprovalCard (Allow/Deny buttons, no Question label)', () => {
    useSessionStore.getState().createNewSession(ROUTE, '/test')
    useSessionStore.setState({ activeSessionId: ROUTE })
    const permApproval = makePendingApproval({ toolName: 'Bash', input: { command: 'ls' } })
    seed.approvalRequest(ROUTE, permApproval)
    render(<FloatingApproval />)
    expect(screen.getByText('Allow')).toBeInTheDocument()
    expect(screen.getByText('Deny')).toBeInTheDocument()
    expect(screen.queryByText('Question')).toBeNull()
  })
})
