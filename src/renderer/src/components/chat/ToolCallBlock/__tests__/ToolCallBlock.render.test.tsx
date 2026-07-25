/**
 * Regression tests: live bash-output streaming renders end-to-end for BOTH
 * engines through the real component stack.
 *
 * Renders the real ToolCallBlock → ToolCard → CommandBody → LiveBashOutput —
 * nothing below ToolCallBlock is mocked, unlike ToolCallBlock.component.test.ts
 * (which mocks ToolCard to isolate the container's IPC/store side effects).
 * That's deliberate: the bug this guards against lived in the *visual state*
 * computation shared by ToolCard/utils.ts, which a mocked ToolCard can't
 * exercise.
 *
 * Bug: opencode tool_use blocks carry the raw (lowercase) tool name 'bash',
 * while resolveToolVisualState's foreground-bash-running gate checked
 * `toolName === 'Bash'` (Claude's capitalized name). A running opencode bash
 * with no result yet therefore resolved to visualState 'idle' instead of
 * 'running', which suppressed CommandBody's LiveBashOutput branch and the
 * "streaming" footer even though bashOutputs[toolUseId] was populated. The
 * fix keys the gate on the tool's kind ('command'), which both engines'
 * bash tools map to.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import { useSessionStore } from '../../../../stores/session-store'
import { makeSessionStatus, resetFactoryCounter } from '@test/factories/messages'
import { ToolCallBlock } from '../ToolCallBlock'
import type { ContentBlock, EngineId } from '../../../../../../shared/types'

type ToolUseBlock = Extract<ContentBlock, { type: 'tool_use' }>

const ROUTE = 'route-live-bash'

beforeEach(() => {
  resetFactoryCounter()
  ;(globalThis as any).window.api = {
    logError: vi.fn(),
    respondApproval: vi.fn(),
    backgroundTask: vi.fn(),
    stopTask: vi.fn(),
    watchBackground: vi.fn(),
    unwatchBackground: vi.fn(),
    readBackgroundRange: vi.fn(),
    saveSessionConfig: vi.fn(),
    saveSlashCommands: vi.fn(),
    fetchAccountUsage: () => Promise.resolve(null),
    fetchBlockUsage: () => Promise.resolve(null),
    getPluginViews: () => Promise.resolve([])
  }
})

function setUpSession(engineId: EngineId, toolUseId: string): void {
  useSessionStore.getState().createNewSession(ROUTE, '/test')
  useSessionStore.setState((state) => ({
    activeSessionId: ROUTE,
    sessions: {
      ...state.sessions,
      [ROUTE]: {
        ...state.sessions[ROUTE],
        status: makeSessionStatus({
          state: 'idle',
          sessionId: null,
          model: null,
          cwd: null,
          engineId
        }),
        bashOutputs: {
          [toolUseId]: { output: 'building...\n', totalLines: 1, totalBytes: 11 }
        }
      }
    }
  }))
}

function makeBlock(toolName: string, toolUseId: string): ToolUseBlock {
  return { type: 'tool_use', toolUseId, toolName, toolInput: { command: 'npm run build' } }
}

describe('ToolCallBlock — live bash output (real ToolCard/CommandBody, unmocked)', () => {
  it('opencode: lowercase "bash" tool_use with no result renders LiveBashOutput', () => {
    setUpSession('opencode', 'tu-oc-1')
    render(<ToolCallBlock block={makeBlock('bash', 'tu-oc-1')} />)

    expect(screen.getByTestId('LiveBashOutput')).toBeInTheDocument()
    expect(screen.getByText('streaming')).toBeInTheDocument()
  })

  it('claude: "Bash" tool_use with no result still renders LiveBashOutput', () => {
    setUpSession('claude', 'tu-cl-1')
    render(<ToolCallBlock block={makeBlock('Bash', 'tu-cl-1')} />)

    expect(screen.getByTestId('LiveBashOutput')).toBeInTheDocument()
    expect(screen.getByText('streaming')).toBeInTheDocument()
  })
})
