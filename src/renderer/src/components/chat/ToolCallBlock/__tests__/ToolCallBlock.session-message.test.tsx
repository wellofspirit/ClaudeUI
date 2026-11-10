/**
 * A `session_message` card through the REAL stack (ToolCallBlock → engine tool map → ToolCard →
 * McpBody), nothing hand-built below the block: the parent's card says which X-Agent the message
 * reached (Claude names the call `mcp__claude-ui-sessions__session_message`, and the tool map must
 * carry that server and tool to the view), and an X-Agent's own card for the same tool reads like
 * it, on every engine, with the first-party header and not the server and tool name again.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import { useSessionStore } from '../../../../stores/session-store'
import { makeSessionStatus, resetFactoryCounter } from '@test/factories/messages'
import { ToolCallBlock } from '../ToolCallBlock'
import type { ContentBlock, EngineId } from '../../../../../../shared/types'

type ToolUseBlock = Extract<ContentBlock, { type: 'tool_use' }>
type ToolResultBlock = Extract<ContentBlock, { type: 'tool_result' }>

const ROUTE = 'route-session-message'
const DELIVERED =
  'delivered to X-Agent reader (it is running: the message goes into its current turn) (message m-1)'

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

function setUpSession(engineId: EngineId, hideToolInput = false): void {
  useSessionStore.getState().createNewSession(ROUTE, '/test')
  useSessionStore.setState((state) => ({
    activeSessionId: ROUTE,
    settings: { ...state.settings, expandToolCalls: true, hideToolInput },
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
        })
      }
    }
  }))
}

const call = (toolName: string): ToolUseBlock => ({
  type: 'tool_use',
  toolUseId: 'tu-sm',
  toolName,
  toolInput: { session: 'reader', message: 'also count README.md' }
})
const delivered = (text = DELIVERED): ToolResultBlock => ({
  type: 'tool_result',
  toolUseId: 'tu-sm',
  toolResult: text
})

describe('a session_message card, through the real tool map', () => {
  it('claude parent: "To X-Agent <name>" is shown (the name carries the server and the tool)', () => {
    setUpSession('claude')
    render(
      <ToolCallBlock
        block={call('mcp__claude-ui-sessions__session_message')}
        result={delivered()}
      />
    )
    expect(screen.getByTestId('McpBody.xAgent').textContent).toBe('To X-Agent reader')
    expect(screen.getByTestId('McpBody.server').textContent).toBe('claude-ui-sessions')
    expect(screen.getByTestId('McpBody.tool').textContent).toBe('session_message')
  })

  it('claude parent: "To X-Agent <name>" is shown with the tool input hidden too (it is part of the outcome)', () => {
    setUpSession('claude', true)
    render(
      <ToolCallBlock
        block={call('mcp__claude-ui-sessions__session_message')}
        result={delivered()}
      />
    )
    expect(screen.getByTestId('McpBody.xAgent').textContent).toBe('To X-Agent reader')
    expect(screen.queryByTestId('McpBody.server')).toBeNull()
  })

  it('claude parent: a message to a session (no X-Agent in the result) says nothing of one', () => {
    setUpSession('claude')
    render(
      <ToolCallBlock
        block={call('mcp__claude-ui-sessions__session_message')}
        result={delivered('delivered (it started a turn on your message) (message m-2)')}
      />
    )
    expect(screen.queryByTestId('McpBody.xAgent')).toBeNull()
  })

  it("claude: another MCP server's tool named like it is not the session tool", () => {
    setUpSession('claude')
    render(<ToolCallBlock block={call('mcp__other__session_message')} result={delivered()} />)
    expect(screen.queryByTestId('McpBody.xAgent')).toBeNull()
  })

  // An X-Agent's own session_message (its target engine's spelling, the card rendered inside the
  // parent's session): the first-party header, and the summary is what it was asked — not the raw
  // "claude-ui-sessions / session_message" the engine's MCP naming would give.
  it.each([
    ['pi', 'session_message'],
    ['opencode', 'claudeui_session_message'],
    ['claude', 'mcp__claude-ui-sessions__session_message']
  ] as const)('%s X-Agent: first-party header, no raw server / tool summary', (engine, name) => {
    setUpSession('claude')
    render(<ToolCallBlock block={call(name)} result={delivered()} engineId={engine} />)
    const card = screen.getByTestId('ToolCard')
    expect(card.textContent).toContain('Session · message')
    expect(card.textContent).toContain('also count README.md')
    // The body still names the server and tool once, in McpBody; the header summary does not.
    expect(card.querySelector('[data-testid="McpBody.server"]')?.textContent).toBe(
      'claude-ui-sessions'
    )
    const header = card.querySelector('button')!
    expect(header.textContent).not.toContain('claude-ui-sessions / session_message')
  })
})
