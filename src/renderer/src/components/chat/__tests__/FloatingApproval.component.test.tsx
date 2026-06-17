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
  // Reset sandbox exclusions (mutated by sandbox escape tests)
  useSessionStore.getState().updateSettings({
    sandbox: { ...useSessionStore.getState().settings.sandbox, excludedCommands: [] }
  })
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
  const { activeSessionId, sessions, removePendingApproval, updateSettings, settings } =
    useSessionStore.getState()
  if (!activeSessionId) return

  const session = sessions[activeSessionId]
  if (!session || session.pendingApprovals.length === 0) return

  const approval = session.pendingApprovals[0]
  const alwaysAllow = opts.alwaysAllow ?? false
  const checkedSuggestions =
    opts.checkedSuggestions ?? (approval.suggestions || []).map(() => false)
  const sandboxSettings = settings.sandbox
  const isSandboxEscape = !!approval.input?.dangerouslyDisableSandbox

  // Sandbox exclusion logic
  if (decision === 'allow' && alwaysAllow && isSandboxEscape && approval.input?.command) {
    const cmd = String(approval.input.command)
    if (!sandboxSettings.excludedCommands.includes(cmd)) {
      updateSettings({
        sandbox: {
          ...sandboxSettings,
          excludedCommands: [...sandboxSettings.excludedCommands, cmd]
        }
      })
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
  removePendingApproval(activeSessionId, approval.requestId)
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
    useSessionStore.getState().addPendingApproval(ROUTE, approval)
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

    const sandbox = useSessionStore.getState().settings.sandbox
    expect(sandbox.excludedCommands).toContain('dangerous-cmd')
  })

  it('does not add to sandbox exclusions on deny', async () => {
    setup({
      toolName: 'Bash',
      input: { command: 'dangerous-cmd', dangerouslyDisableSandbox: true }
    })

    await simulateApprovalResponse('deny', { alwaysAllow: true })

    const sandbox = useSessionStore.getState().settings.sandbox
    expect(sandbox.excludedCommands).not.toContain('dangerous-cmd')
  })

  it('does not add to sandbox exclusions when alwaysAllow is false', async () => {
    setup({
      toolName: 'Bash',
      input: { command: 'dangerous-cmd', dangerouslyDisableSandbox: true }
    })

    await simulateApprovalResponse('allow', { alwaysAllow: false })

    const sandbox = useSessionStore.getState().settings.sandbox
    expect(sandbox.excludedCommands).not.toContain('dangerous-cmd')
  })

  it('does not duplicate command in sandbox exclusion list', async () => {
    // Pre-populate exclusion list
    const store = useSessionStore.getState()
    store.updateSettings({
      sandbox: { ...store.settings.sandbox, excludedCommands: ['dangerous-cmd'] }
    })

    setup({
      toolName: 'Bash',
      input: { command: 'dangerous-cmd', dangerouslyDisableSandbox: true }
    })

    await simulateApprovalResponse('allow', { alwaysAllow: true })

    const sandbox = useSessionStore.getState().settings.sandbox
    expect(sandbox.excludedCommands.filter((c: string) => c === 'dangerous-cmd')).toHaveLength(1)
  })

  it('does not modify sandbox exclusions for non-sandbox-escape approvals', async () => {
    setup({
      toolName: 'Bash',
      input: { command: 'echo hello' } // no dangerouslyDisableSandbox
    })

    await simulateApprovalResponse('allow', { alwaysAllow: true })

    const sandbox = useSessionStore.getState().settings.sandbox
    expect(sandbox.excludedCommands).not.toContain('echo hello')
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
    useSessionStore.getState().addPendingApproval(ROUTE, approval1)
    useSessionStore.getState().addPendingApproval(ROUTE, approval2)

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
    useSessionStore.getState().addPendingApproval(ROUTE, approval)
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
    useSessionStore.getState().addPendingApproval(ROUTE, approval1)
    useSessionStore.getState().addPendingApproval(ROUTE, approval2)

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
    useSessionStore.getState().addPendingApproval(ROUTE, approval1)
    useSessionStore.getState().addPendingApproval(ROUTE, approval2)

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
// "Allow for session" button — Codex-only gating
// ---------------------------------------------------------------------------

describe('FloatingApproval "Allow for session" button gating', () => {
  const ROUTE_CODEX = 'route-codex'
  const ROUTE_CLAUDE = 'route-claude'

  function setupWithProvider(routingId: string, provider: 'claude' | 'codex'): PendingApproval {
    // Set the provider before creating the session so createNewSession picks it up.
    useSessionStore.setState({ lastSelectedProvider: provider })
    useSessionStore.getState().createNewSession(routingId, '/test')
    useSessionStore.setState({ activeSessionId: routingId })

    const approval = makePendingApproval({ toolName: 'Shell', input: { command: 'ls' } })
    useSessionStore.getState().addPendingApproval(routingId, approval)
    return approval
  }

  it('renders "Allow for session" button when the active session is Codex', () => {
    setupWithProvider(ROUTE_CODEX, 'codex')

    render(<FloatingApproval />)

    expect(screen.getByText('Allow for session')).toBeInTheDocument()
  })

  it('does NOT render "Allow for session" button for a Claude session', () => {
    setupWithProvider(ROUTE_CLAUDE, 'claude')

    render(<FloatingApproval />)

    expect(screen.queryByText('Allow for session')).toBeNull()
    // Normal Allow + Deny still present
    expect(screen.getByText('Allow')).toBeInTheDocument()
    expect(screen.getByText('Deny')).toBeInTheDocument()
  })

  it('clicking "Allow for session" sends allowForSession decision via IPC', async () => {
    const approval = setupWithProvider(ROUTE_CODEX, 'codex')

    render(<FloatingApproval />)

    await act(async () => {
      fireEvent.click(screen.getByText('Allow for session'))
    })

    expect(lastApprovalResponse).toEqual({
      routingId: ROUTE_CODEX,
      requestId: approval.requestId,
      decision: 'allowForSession',
      answers: undefined,
      suggestions: undefined
    })

    expect(useSessionStore.getState().sessions[ROUTE_CODEX].pendingApprovals).toHaveLength(0)
  })
})
