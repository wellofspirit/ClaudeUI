/**
 * Single McpServer ('claudeui') that exposes all three hosted tools:
 *   render_mermaid, create_mockup, show_mockup
 *
 * Reuses the real tool handler logic from mermaid-tool.ts and
 * mockup-tool.ts — no duplication. Tool definitions are extracted from
 * the SdkMcpServer wrappers returned by those factories and re-registered
 * on one unified McpServer so opencode sees a single MCP server.
 *
 * opencode sanitizes tool names as `sanitize(serverName)_sanitize(toolName)`
 * where sanitize = `s.replace(/[^a-zA-Z0-9_-]/g, "_")`. With server name
 * 'claudeui' the resulting names are:
 *   claudeui_render_mermaid, claudeui_create_mockup, claudeui_show_mockup
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { z } from 'zod'
import { createMermaidServer } from '../services/mermaid-tool'
import { createMockupServer } from '../services/mockup-tool'
import type { SdkMcpTool } from '../sdk/types'

/**
 * Create a single McpServer (name 'claudeui') that exposes all three hosted
 * tools. Cwd is baked into the mockup tool's path resolution at creation time
 * (mockups land under `<cwd>/.claude/ui/mockups`).
 */
export function createOpencodeHostedToolsServer(cwd: string): McpServer {
  const server = new McpServer(
    { name: 'claudeui', version: '1.0.0' },
    { capabilities: { tools: {} } }
  )

  // Extract tool definitions from the canonical implementations.
  const mermaidTools: SdkMcpTool[] = createMermaidServer().tools
  const mockupTools: SdkMcpTool[] = createMockupServer(cwd).tools

  for (const t of [...mermaidTools, ...mockupTools]) {
    server.registerTool(
      t.name,
      {
        description: t.description,
        inputSchema: t.inputSchema as unknown as Record<string, z.ZodTypeAny>
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      t.handler as unknown as (...args: any[]) => any
    )
  }

  return server
}
