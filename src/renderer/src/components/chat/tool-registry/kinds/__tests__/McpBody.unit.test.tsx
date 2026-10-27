/**
 * Layer 1 (unit) for `McpBody` — props in, DOM out.
 *
 * The rule it carries is that server RESULT text is untrusted third-party
 * output: it renders verbatim and never through the markdown pipeline.
 */

import { describe, expect, it } from 'vitest'
import { render, screen } from '@testing-library/react'
import { McpBody } from '../McpBody'
import type { KindBodyProps } from '../types'
import type { ContentBlock } from '../../../../../../../shared/types'
import type { ToolView } from '../../../../../../../shared/tool-kinds'

type McpView = Extract<ToolView, { kind: 'mcp' }>
type ToolResultBlock = Extract<ContentBlock, { type: 'tool_result' }>

function renderBody(view: McpView, result?: ToolResultBlock, isError = false): void {
  render(
    <McpBody
      {...({
        view,
        block: {
          type: 'tool_use',
          toolUseId: 'tu',
          toolName: 'mcp__verify-stub__ping',
          toolInput: {}
        },
        result,
        expanded: true,
        hideToolInput: false,
        isError
      } as unknown as KindBodyProps)}
    />
  )
}

describe('McpBody', () => {
  it('splits the server and the tool in the header and dumps the arguments', () => {
    renderBody({
      kind: 'mcp',
      input: { query: 'repo:x is:open' },
      server: 'github',
      tool: 'search_issues'
    })
    expect(screen.getByTestId('McpBody.server').textContent).toBe('github')
    expect(screen.getByTestId('McpBody.tool').textContent).toBe('search_issues')
    expect(screen.getByTestId('McpBody').textContent).toContain('"query": "repo:x is:open"')
  })

  it('shows the read-only chip only when the server declared the hint', () => {
    renderBody({ kind: 'mcp', input: {}, server: 's', tool: 't', readOnly: true })
    expect(screen.getByTestId('McpBody.readOnly').textContent).toBe('read-only')
    render(<div />)
  })

  it('omits the chip when the hint is absent or false', () => {
    renderBody({ kind: 'mcp', input: {}, server: 's', tool: 't', readOnly: false })
    expect(screen.queryByTestId('McpBody.readOnly')).toBeNull()
  })

  it('renders the server result verbatim, markdown syntax included', () => {
    // Untrusted server output: `# heading` must stay literal text, never an <h1>.
    renderBody(
      { kind: 'mcp', input: {}, server: 's', tool: 't' },
      {
        type: 'tool_result',
        toolUseId: 'tu',
        toolResult: '# heading\n**bold**'
      }
    )
    expect(screen.getByTestId('McpBody').parentElement?.querySelector('h1')).toBeNull()
    expect(screen.getByTestId('McpBody').parentElement?.querySelector('strong')).toBeNull()
    expect(document.body.textContent).toContain('# heading')
    expect(document.body.textContent).toContain('**bold**')
  })

  describe('a session_message to an X-Agent (ADR-105 §4)', () => {
    const view = {
      kind: 'mcp',
      input: {},
      server: 'claude-ui-sessions',
      tool: 'session_message'
    } as const
    const delivered = (text: string) =>
      ({ type: 'tool_result', toolUseId: 'tu', toolResult: text }) as never

    it('names the X-Agent it reached, from the call’s own result', () => {
      renderBody(
        view,
        delivered(
          'delivered to X-Agent worker (it is running: it takes the message into its current turn) (message m-1)'
        )
      )
      expect(screen.getByTestId('McpBody.xAgent').textContent).toBe('To X-Agent worker')
    })

    it('a run it started names it too', () => {
      renderBody(
        view,
        delivered(
          'delivered to X-Agent impl-e1 (it was not running: a new run started on your message) (message m-2)'
        )
      )
      expect(screen.getByTestId('McpBody.xAgent').textContent).toBe('To X-Agent impl-e1')
    })

    it('says nothing for a message to a session, a refusal, no result yet, or another tool', () => {
      for (const [v, r] of [
        [view, delivered('delivered (it started a turn on your message) (message m-3)')],
        [view, delivered('Refused: the cost cap is reached')],
        [view, undefined],
        [{ ...view, tool: 'session_get' }, delivered('delivered to X-Agent worker (it is running')],
        [{ ...view, server: 'other' }, delivered('delivered to X-Agent worker (it is running')]
      ] as const) {
        const { unmount } = render(
          <McpBody
            {...({
              view: v,
              block: { type: 'tool_use', toolUseId: 'tu', toolName: 'x', toolInput: {} },
              result: r,
              expanded: true,
              hideToolInput: false,
              isError: false
            } as unknown as KindBodyProps)}
          />
        )
        expect(screen.queryByTestId('McpBody.xAgent')).toBeNull()
        unmount()
      }
    })
  })

  it('renders a failed call through the error branch', () => {
    renderBody(
      { kind: 'mcp', input: {}, server: 'github', tool: 'create_issue' },
      {
        type: 'tool_result',
        toolUseId: 'tu',
        toolResult: 'Resource not accessible by integration (HTTP 403)',
        isError: true
      },
      true
    )
    expect(screen.getByTestId('McpBody.error').textContent).toContain('HTTP 403')
  })

  it('falls back to the block input when the view carries none', () => {
    render(
      <McpBody
        {...({
          view: { kind: 'mcp', input: undefined },
          block: {
            type: 'tool_use',
            toolUseId: 'tu',
            toolName: 'mcp__s__t',
            toolInput: { fallback: true }
          },
          expanded: true,
          hideToolInput: false,
          isError: false
        } as unknown as KindBodyProps)}
      />
    )
    expect(screen.getByTestId('McpBody').textContent).toContain('"fallback": true')
  })

  it('renders nothing at all for a view of the wrong kind', () => {
    const { container } = render(
      <McpBody
        {...({
          view: { kind: 'unknown', input: {} },
          block: { type: 'tool_use', toolUseId: 'tu', toolName: 'x' },
          expanded: true,
          hideToolInput: false,
          isError: false
        } as unknown as KindBodyProps)}
      />
    )
    expect(container.innerHTML).toBe('')
  })
})
