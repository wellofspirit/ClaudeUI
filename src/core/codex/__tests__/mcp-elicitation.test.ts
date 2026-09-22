// @vitest-environment node
import { describe, expect, it } from 'vitest'
import {
  MCP_ELICITATION_ACCEPT,
  MCP_ELICITATION_DECLINE,
  mcpRuleToolName,
  readMcpToolApproval
} from '../mcp-elicitation'
import recorded from './fixtures/mcp-tool-approval-elicitation.json'

/**
 * Slice 4b — reading `mcpServer/elicitation/request`. The happy path and the
 * gate around it live in `codex-session.test.ts`; this file covers the shapes
 * that file cannot reach through the session, and pins the two reply bodies.
 */
describe('readMcpToolApproval', () => {
  const form = (extra: Record<string, unknown> = {}): Record<string, unknown> => ({
    ...recorded,
    ...extra
  })

  it('reads the recorded request as the tool approval', () => {
    expect(readMcpToolApproval(recorded)).toEqual({
      server: 'verify-stub',
      tool: 'ping',
      params: {}
    })
  })

  it('prefers an explicit tool_name over the message', () => {
    // Connector-originated forms set `tool_name` (`mcp_approval_meta.rs`
    // TOOL_NAME_KEY); the core's own builder does not, which is why the message
    // is the fallback and not the other way round.
    expect(
      readMcpToolApproval(
        form({
          _meta: { ...(recorded._meta as Record<string, unknown>), tool_name: 'from_meta' },
          message: 'Allow the verify-stub MCP server to run tool "from_message"?'
        })
      )
    ).toMatchObject({ tool: 'from_meta' })
  })

  it('carries the model arguments through for display', () => {
    expect(
      readMcpToolApproval(
        form({
          _meta: {
            ...(recorded._meta as Record<string, unknown>),
            tool_params: { path: 'README.md' }
          }
        })
      )
    ).toMatchObject({ params: { path: 'README.md' } })
  })

  it('does not let a quoted tool name steal the capture', () => {
    // The message is anchored on the server name the PARAMS carry, so a tool
    // whose name contains a quote fails to parse into a name instead of
    // producing a wrong one — and an unnamed tool narrows to the server.
    expect(
      readMcpToolApproval(
        form({ message: 'Allow the verify-stub MCP server to run tool "a" or "b"?' })
      )
    ).toMatchObject({ server: 'verify-stub', tool: null })
  })

  it('rejects everything that is not the privileged approval form', () => {
    for (const value of [
      null,
      undefined,
      'string',
      [],
      // A different elicitation mode entirely.
      form({ mode: 'url' }),
      // An ordinary server question: no privileged meta.
      form({ _meta: null }),
      form({ _meta: {} }),
      // A meta whose kind is some OTHER privileged approval.
      form({ _meta: { codex_approval_kind: 'tool_suggestion' } }),
      form({ serverName: 42 })
    ])
      expect(readMcpToolApproval(value)).toBeNull()
  })
})

describe('the reply bodies', () => {
  it('spells the tool name in Claude rule vocabulary, with a server-only fallback', () => {
    expect(mcpRuleToolName('verify-stub', 'ping')).toBe('mcp__verify-stub__ping')
    expect(mcpRuleToolName('verify-stub', null)).toBe('mcp__verify-stub')
  })

  it('never carries Codex own persistence key', () => {
    // `persist` on the response `_meta` is what
    // `parse_mcp_tool_approval_elicitation_response` reads as
    // ApprovedForSession / ApprovedMcpPolicyAmendment. ClaudeUI owns rules and
    // session allows (ADR-067), so neither body has a `_meta` at all.
    expect(MCP_ELICITATION_ACCEPT).toEqual({ action: 'accept', content: {} })
    expect(MCP_ELICITATION_DECLINE).toEqual({ action: 'decline', content: null })
  })
})
