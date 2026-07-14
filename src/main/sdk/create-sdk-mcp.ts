/**
 * Drop-in replacements for the SDK's `createSdkMcpServer()` and `tool()`
 * helpers, now backed by the real `@modelcontextprotocol/sdk` so we get
 * proper MCP protocol support (version negotiation, notifications,
 * progress, resources, prompts) for free.
 *
 * Callers (mermaid-tool, mockup-tool, auto-classifier-tool) keep the same
 * import and signatures.
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { RequestHandlerExtra } from '@modelcontextprotocol/sdk/shared/protocol.js'
import type { ServerNotification, ServerRequest } from '@modelcontextprotocol/sdk/types.js'
import type { z } from 'zod'
import type { SdkMcpServer, SdkMcpTool, SdkToolExtra, ToolResultContent } from './types'

type ToolInput<Shape extends Record<string, z.ZodTypeAny>> = {
  [K in keyof Shape]: z.infer<Shape[K]>
}

export function createSdkMcpServer(opts: {
  name: string
  version?: string
  tools: SdkMcpTool[]
}): SdkMcpServer {
  const instance = new McpServer(
    { name: opts.name, version: opts.version ?? '0.0.0' },
    { capabilities: { tools: {} } }
  )

  for (const t of opts.tools) {
    // registerTool uses the Zod raw shape object directly for input schema.
    instance.registerTool(
      t.name,
      {
        description: t.description,
        inputSchema: t.inputSchema as unknown as Record<string, z.ZodTypeAny>
      },
      // MCP's ToolCallback receives parsed-validated args as the first param,
      // and a RequestHandlerExtra (abort signal, progress notifications) as
      // the second — we narrow that down to SdkToolExtra for our handlers.
      async (
        args: Record<string, unknown>,
        extra: RequestHandlerExtra<ServerRequest, ServerNotification>
      ) => {
        const toolExtra: SdkToolExtra = {
          signal: extra.signal,
          progressToken: extra._meta?.progressToken,
          sendNotification: (notification) =>
            extra.sendNotification(notification as ServerNotification)
        }
        const result = await t.handler(args, toolExtra)
        return result as Parameters<Parameters<typeof instance.registerTool>[2]>[0] extends never
          ? never
          : { content: ToolResultContent['content']; isError?: boolean }
      }
    )
  }

  return {
    type: 'sdk',
    name: opts.name,
    version: opts.version,
    tools: opts.tools,
    instance
  }
}

/**
 * Build a tool definition. Signature matches upstream:
 *   tool(name, description, zodShape, handler)
 *
 * `zodShape` is an object of field → Zod schema (NOT a wrapping z.object()).
 */
export function tool<Shape extends Record<string, z.ZodTypeAny>>(
  name: string,
  description: string,
  inputSchema: Shape,
  handler: (input: ToolInput<Shape>, extra?: SdkToolExtra) => Promise<ToolResultContent>
): SdkMcpTool {
  return {
    name,
    description,
    inputSchema: inputSchema as unknown as SdkMcpTool['inputSchema'],
    handler: handler as unknown as SdkMcpTool['handler']
  }
}

/**
 * Emit a `notifications/progress` for a long-running tool call. No-ops when
 * the caller didn't request progress (`extra.progressToken` unset) — MCP
 * clients aren't obligated to set one, and callers that never pass `extra`
 * (legacy one-arg handlers, or unit tests) get a harmless no-op too.
 */
export async function sendProgress(
  extra: SdkToolExtra | undefined,
  progress: { progress: number; total?: number; message?: string }
): Promise<void> {
  // undefined check only — `0` is a legitimate token (the MCP TS SDK client
  // derives tokens from its message-ID counter, which starts at 0).
  if (extra?.progressToken === undefined) return
  await extra.sendNotification({
    method: 'notifications/progress',
    params: { progressToken: extra.progressToken, ...progress }
  })
}
