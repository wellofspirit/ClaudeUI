/**
 * @vitest-environment node
 *
 * Headless automations must fail closed: no user is present to resolve an
 * approval, so canUseTool denies everything except our own in-process UI-MCP
 * tools. This is the SAME callback for 'auto' and 'default' automations — in
 * 'auto', cli.js's native auto classifier (see runOneShotQuery's
 * setPermissionMode('auto') upgrade) allows the routine stuff before it ever
 * reaches this callback, so only residual asks land here and are denied.
 */
import { describe, it, expect } from 'vitest'
import { buildCanUseTool, type CanUseToolResult } from '../../../core/services/automation-manager'

describe('buildCanUseTool', () => {
  it('allows mcp__claude-ui__-prefixed tools', async () => {
    const canUseTool = buildCanUseTool()
    const result = await canUseTool('mcp__claude-ui__render_mermaid', { source: 'graph TD' })

    expect(result.behavior).toBe('allow')
    expect((result as Extract<CanUseToolResult, { behavior: 'allow' }>).updatedInput).toEqual({
      source: 'graph TD'
    })
  })

  it('denies any other tool with a clear "no user present" message', async () => {
    const canUseTool = buildCanUseTool()

    for (const tool of ['Read', 'Bash', 'Edit', 'Write', 'Grep', 'WebFetch']) {
      const result = await canUseTool(tool, {})
      expect(result.behavior).toBe('deny')
      expect((result as Extract<CanUseToolResult, { behavior: 'deny' }>).message).toContain(
        'no user is present'
      )
    }
  })

  it('denies a destructive tool call the same way as a benign one — no classifier, fail closed', async () => {
    const canUseTool = buildCanUseTool()
    const result = await canUseTool('Bash', { command: 'rm -rf /' })

    expect(result.behavior).toBe('deny')
    expect((result as Extract<CanUseToolResult, { behavior: 'deny' }>).message).toContain(
      'no user is present'
    )
  })

  it('is the same callback regardless of automation mode — the caller no longer branches on auto/default', async () => {
    const canUseTool = buildCanUseTool()

    const allowed = await canUseTool('mcp__claude-ui__render_mermaid', {})
    expect(allowed.behavior).toBe('allow')

    const denied = await canUseTool('Read', {})
    expect(denied.behavior).toBe('deny')
  })
})
