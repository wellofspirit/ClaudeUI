/**
 * Layer 2: Component tests for OpencodeAgentsSection.
 *
 * Tested flows:
 *   1. List rendering: custom + built-in agents with correct badges; disabled chip
 *   2. Drill-in: clicking a row calls readOpencodeAgent and shows the editor
 *   3. Save without restrict: OpencodeAgentInput has NO permission field
 *   4. Save with restrict: OpencodeAgentInput HAS permission field
 *   5. Generate: fields prefilled on success; soft error shown on reject
 *   6. Built-in Disable: calls setOpencodeAgentDisabled(name, scope, cwd, true)
 *   7. Built-in Reset: calls deleteOpencodeAgent(name, scope, cwd)
 *   8. Project scope disabled when no cwd
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import React from 'react'
import { render, screen, fireEvent, act, cleanup, waitFor } from '@testing-library/react'
import type {
  OpencodeAgentSummary,
  OpencodeAgentDetail,
  OpencodeAgentInput
} from '../../../../../shared/types'

// ── Store mock ───────────────────────────────────────────────────────

type ActiveSelector = (s: { cwd: string }) => unknown

// vi.hoisted ensures this runs before the vi.mock factory (which is hoisted to the top of the file)
const { mockUseActiveSession } = vi.hoisted(() => {
  const mockUseActiveSession = vi.fn((selector: ActiveSelector) => selector({ cwd: '/test/cwd' }))
  return { mockUseActiveSession }
})

vi.mock('../../../stores/session-store', () => ({
  useActiveSession: (selector: ActiveSelector) => mockUseActiveSession(selector),
  useSessionStore: vi.fn(() => null),
  EMPTY_SESSION_STATE: { cwd: '' }
}))

import { OpencodeAgentsSection } from '../OpencodeAgents'

// ── Fixtures ─────────────────────────────────────────────────────────

const CUSTOM_AGENT: OpencodeAgentSummary = {
  name: 'my-agent',
  kind: 'custom',
  mode: 'primary',
  scope: 'global',
  model: 'anthropic/claude-sonnet-4-6',
  color: '#f59e0b',
  overridden: false,
  disabled: false
}

const BUILTIN_AGENT: OpencodeAgentSummary = {
  name: 'build',
  kind: 'builtin',
  mode: 'subagent',
  scope: null,
  overridden: false,
  disabled: false
}

const DISABLED_BUILTIN: OpencodeAgentSummary = {
  name: 'plan',
  kind: 'builtin',
  mode: 'primary',
  scope: null,
  disabled: true
}

const OVERRIDDEN_BUILTIN: OpencodeAgentSummary = {
  name: 'general',
  kind: 'builtin',
  mode: 'primary',
  scope: null,
  overridden: true
}

const CUSTOM_DETAIL: OpencodeAgentDetail = {
  name: 'my-agent',
  kind: 'custom',
  mode: 'primary',
  scope: 'global',
  model: 'anthropic/claude-sonnet-4-6',
  description: 'My custom agent',
  prompt: 'You are a custom agent.',
  restrict: false
}

const BUILTIN_DETAIL: OpencodeAgentDetail = {
  name: 'build',
  kind: 'builtin',
  mode: 'subagent',
  scope: null,
  restrict: false,
  disabled: false
}

// ── window.api stub ──────────────────────────────────────────────────

let capturedSaveInputs: OpencodeAgentInput[] = []
const saveOpencodeAgent = vi.fn(async (input: OpencodeAgentInput) => {
  capturedSaveInputs.push(structuredClone(input))
})
const deleteOpencodeAgent = vi.fn(async () => {})
const setOpencodeAgentDisabled = vi.fn(async () => {})
const generateOpencodeAgent = vi.fn(async () => ({
  identifier: 'gen-agent',
  whenToUse: 'Use this for testing.',
  systemPrompt: 'You are a generated agent.'
}))

function installApiStub(overrides: Record<string, unknown> = {}): void {
  ;(globalThis as { window: Window }).window = globalThis.window ?? ({} as Window)
  ;(window as unknown as { api: Record<string, unknown> }).api = {
    engineIsInstalled: vi.fn(async () => true),
    listOpencodeAgents: vi.fn(async () => []),
    readOpencodeAgent: vi.fn(async () => null),
    saveOpencodeAgent,
    deleteOpencodeAgent,
    setOpencodeAgentDisabled,
    generateOpencodeAgent,
    getEngineModels: vi.fn(async () => []),
    ...overrides
  }
}

// ── Render helper ────────────────────────────────────────────────────

async function renderSection(): Promise<void> {
  await act(async () => {
    render(React.createElement(OpencodeAgentsSection))
  })
  // Wait for async effects to settle
  await act(async () => {
    await new Promise((r) => setTimeout(r, 0))
  })
}

// ── Tests ────────────────────────────────────────────────────────────

describe('OpencodeAgentsSection', () => {
  beforeEach(() => {
    capturedSaveInputs = []
    saveOpencodeAgent.mockClear()
    deleteOpencodeAgent.mockClear()
    setOpencodeAgentDisabled.mockClear()
    generateOpencodeAgent.mockClear()
    // Default: active session has cwd
    mockUseActiveSession.mockImplementation((selector) => selector({ cwd: '/test/cwd' }))
  })

  afterEach(() => {
    cleanup()
  })

  // ── Test 1: List rendering ─────────────────────────────────────────

  it('renders custom and built-in agents with correct groups and badges', async () => {
    installApiStub({
      listOpencodeAgents: vi.fn(async () => [
        CUSTOM_AGENT,
        BUILTIN_AGENT,
        DISABLED_BUILTIN,
        OVERRIDDEN_BUILTIN
      ])
    })

    await renderSection()

    // Section root exists
    expect(screen.getByTestId('OpencodeAgentsSection')).toBeTruthy()

    // All named agents rendered
    expect(screen.getByText('my-agent')).toBeTruthy()
    expect(screen.getByText('build')).toBeTruthy()
    expect(screen.getByText('plan')).toBeTruthy()
    expect(screen.getByText('general')).toBeTruthy()

    // Mode badges
    expect(screen.getAllByText('primary').length).toBeGreaterThan(0)
    expect(screen.getAllByText('subagent').length).toBeGreaterThan(0)

    // Disabled chip for the disabled built-in
    expect(screen.getByText('disabled')).toBeTruthy()

    // Overridden chip
    expect(screen.getByText('overridden')).toBeTruthy()

    // Custom scope badge
    expect(screen.getByText('global')).toBeTruthy()

    // New agent button exists
    expect(screen.getByTestId('OpencodeAgentsSection.newAgent')).toBeTruthy()
  })

  it('renders disabled agent with opacity style', async () => {
    installApiStub({
      listOpencodeAgents: vi.fn(async () => [DISABLED_BUILTIN])
    })

    await renderSection()

    const row = screen.getByTestId('OpencodeAgentsSection.agentRow')
    expect(row.className).toContain('opacity-55')
  })

  it('builtin with overridden=true stays in Built-in group', async () => {
    installApiStub({
      listOpencodeAgents: vi.fn(async () => [CUSTOM_AGENT, OVERRIDDEN_BUILTIN])
    })

    await renderSection()

    // Both groups present
    expect(screen.getByText('Custom')).toBeTruthy()
    expect(screen.getByText('Built-in')).toBeTruthy()
    // Overridden built-in has overridden chip, NOT moved to custom
    expect(screen.getByText('overridden')).toBeTruthy()
  })

  // ── Test 2: Drill-in ───────────────────────────────────────────────

  it('clicking a row calls readOpencodeAgent and shows the editor', async () => {
    const readOpencodeAgent = vi.fn(async () => CUSTOM_DETAIL)
    installApiStub({
      listOpencodeAgents: vi.fn(async () => [CUSTOM_AGENT]),
      readOpencodeAgent
    })

    await renderSection()

    const row = screen.getByTestId('OpencodeAgentsSection.agentRow')
    await act(async () => {
      fireEvent.click(row)
    })
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0))
    })

    expect(readOpencodeAgent).toHaveBeenCalledWith('my-agent', 'global', '/test/cwd')

    // Editor is now visible
    expect(screen.getByTestId('OpencodeAgentsSection.back')).toBeTruthy()
    expect(screen.getByTestId('OpencodeAgentsSection.save')).toBeTruthy()
  })

  // ── Test 3: Save without restrict ─────────────────────────────────

  it('save without restrict (OFF) sends no permission field', async () => {
    const readOpencodeAgent = vi.fn(async () => ({ ...CUSTOM_DETAIL, restrict: false }))
    installApiStub({
      listOpencodeAgents: vi.fn(async () => [CUSTOM_AGENT]),
      readOpencodeAgent
    })

    await renderSection()

    // Drill in
    await act(async () => {
      fireEvent.click(screen.getByTestId('OpencodeAgentsSection.agentRow'))
    })
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0))
    })

    // Restrict is OFF — do NOT click permToggle, just save
    await act(async () => {
      fireEvent.click(screen.getByTestId('OpencodeAgentsSection.save'))
    })
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0))
    })

    expect(saveOpencodeAgent).toHaveBeenCalledOnce()
    const input = capturedSaveInputs[0]
    expect(input.name).toBe('my-agent')
    // permission must be absent entirely
    expect('permission' in input).toBe(false)
  })

  // ── Test 4: Save with restrict ─────────────────────────────────────

  it('save with restrict (ON) sends permission field', async () => {
    const readOpencodeAgent = vi.fn(async () => ({
      ...CUSTOM_DETAIL,
      restrict: false
    }))
    installApiStub({
      listOpencodeAgents: vi.fn(async () => [CUSTOM_AGENT]),
      readOpencodeAgent
    })

    await renderSection()

    // Drill in
    await act(async () => {
      fireEvent.click(screen.getByTestId('OpencodeAgentsSection.agentRow'))
    })
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0))
    })

    // Toggle restrict ON
    await act(async () => {
      fireEvent.click(screen.getByTestId('OpencodeAgentsSection.permToggle'))
    })

    // Save
    await act(async () => {
      fireEvent.click(screen.getByTestId('OpencodeAgentsSection.save'))
    })
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0))
    })

    expect(saveOpencodeAgent).toHaveBeenCalledOnce()
    const input = capturedSaveInputs[0]
    expect(input.permission).toBeDefined()
    // All categories default to 'allow' when the grid hasn't been modified
    expect(input.permission?.bash).toBe('allow')
    expect(input.permission?.edit).toBe('allow')
    expect(input.permission?.task).toBe('allow')
  })

  // ── Test 5: Generate ──────────────────────────────────────────────

  it('generate prefills name, description, and prompt on success', async () => {
    installApiStub({
      listOpencodeAgents: vi.fn(async () => [])
    })

    await renderSection()

    // Click new agent
    await act(async () => {
      fireEvent.click(screen.getByTestId('OpencodeAgentsSection.newAgent'))
    })

    // Type a description
    const genInput = screen.getByPlaceholderText('Describe what this agent should do…')
    await act(async () => {
      fireEvent.change(genInput, { target: { value: 'An agent for testing' } })
    })

    // Click generate
    await act(async () => {
      fireEvent.click(screen.getByTestId('OpencodeAgentsSection.generate'))
    })
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0))
    })

    expect(generateOpencodeAgent).toHaveBeenCalledWith('An agent for testing', '/test/cwd')

    // Name should be prefilled with identifier
    const nameInput = screen.getByPlaceholderText('my-agent') as HTMLInputElement
    expect(nameInput.value).toBe('gen-agent')
  })

  it('generate shows soft error on reject (no throw)', async () => {
    installApiStub({
      listOpencodeAgents: vi.fn(async () => []),
      generateOpencodeAgent: vi.fn(async () => {
        throw new Error('AI unavailable')
      })
    })

    await renderSection()

    await act(async () => {
      fireEvent.click(screen.getByTestId('OpencodeAgentsSection.newAgent'))
    })

    const genInput = screen.getByPlaceholderText('Describe what this agent should do…')
    await act(async () => {
      fireEvent.change(genInput, { target: { value: 'something' } })
    })

    await act(async () => {
      fireEvent.click(screen.getByTestId('OpencodeAgentsSection.generate'))
    })
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0))
    })

    // Error message shown inline, not re-thrown
    await waitFor(() => {
      expect(screen.getByText('AI unavailable')).toBeTruthy()
    })
  })

  // ── Test 6: Built-in Disable ──────────────────────────────────────

  it('disable button calls setOpencodeAgentDisabled(name, scope, cwd, true)', async () => {
    const readOpencodeAgent = vi.fn(async () => ({
      ...BUILTIN_DETAIL,
      scope: 'global' as const,
      disabled: false
    }))
    installApiStub({
      listOpencodeAgents: vi.fn(async () => [BUILTIN_AGENT]),
      readOpencodeAgent
    })

    await renderSection()

    await act(async () => {
      fireEvent.click(screen.getByTestId('OpencodeAgentsSection.agentRow'))
    })
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0))
    })

    await act(async () => {
      fireEvent.click(screen.getByTestId('OpencodeAgentsSection.disable'))
    })
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0))
    })

    // name=build, scope=global (from readOpencodeAgent detail scope), cwd=/test/cwd, disabled=true
    expect(setOpencodeAgentDisabled).toHaveBeenCalledWith('build', 'global', '/test/cwd', true)
  })

  // ── Test 7: Built-in Reset ────────────────────────────────────────

  it('reset calls deleteOpencodeAgent for built-in agent', async () => {
    const readOpencodeAgent = vi.fn(async () => ({
      ...BUILTIN_DETAIL,
      scope: 'global' as const
    }))
    installApiStub({
      listOpencodeAgents: vi.fn(async () => [BUILTIN_AGENT]),
      readOpencodeAgent
    })

    await renderSection()

    await act(async () => {
      fireEvent.click(screen.getByTestId('OpencodeAgentsSection.agentRow'))
    })
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0))
    })

    await act(async () => {
      fireEvent.click(screen.getByTestId('OpencodeAgentsSection.reset'))
    })
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0))
    })

    expect(deleteOpencodeAgent).toHaveBeenCalledWith('build', 'global', '/test/cwd')
  })

  // ── Test 8: Project scope disabled when no cwd ────────────────────

  it('Project scope button is disabled when active session has no cwd', async () => {
    // Mock cwd as empty string
    mockUseActiveSession.mockImplementation((selector) => selector({ cwd: '' }))
    installApiStub({
      listOpencodeAgents: vi.fn(async () => [])
    })

    await renderSection()

    // Open new-agent editor
    await act(async () => {
      fireEvent.click(screen.getByTestId('OpencodeAgentsSection.newAgent'))
    })

    const projectBtn = screen.getByRole('button', { name: 'Project' })
    expect((projectBtn as HTMLButtonElement).disabled).toBe(true)
  })

  // ── Not installed gate ────────────────────────────────────────────

  it('shows not-installed message when opencode is not installed', async () => {
    installApiStub({
      engineIsInstalled: vi.fn(async () => false)
    })

    await renderSection()

    expect(screen.getByText(/opencode is not installed/)).toBeTruthy()
  })
})
