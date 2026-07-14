import { createSdkMcpServer, tool } from '../sdk'
import type { SdkMcpServer } from '../sdk'
import { z } from 'zod'
import { crossEngineDispatcher } from './cross-engine-dispatcher'
import type { EngineId } from '../../shared/types'

export interface CollabServerContext {
  engineId: EngineId
  /** Live routingId lookup — the session is rekeyed to its UUID after init. */
  getRoutingId: () => string
  cwd: string
  getAutonomyMode: () => string
  /** BaseSession.send — re-emits under the dispatching session's routing. */
  emit: (channel: string, data: unknown) => void
}

/**
 * In-process MCP server hosting the `dispatch_agent` tool (ADR-033).
 *
 * Registered as a SEPARATE server (`claude-ui-collab`) so it does NOT ride
 * the auto-allowed `mcp__claude-ui__` prefix — dispatch_agent goes through
 * canUseTool like an ordinary tool.
 */
export function createCollabServer(ctx: CollabServerContext): SdkMcpServer {
  return createSdkMcpServer({
    name: 'claude-ui-collab',
    version: '1.0.0',
    tools: [
      tool(
        'dispatch_agent',
        'Delegate a task to an agent running on a DIFFERENT engine (opencode, which fronts ' +
          'non-Anthropic model vendors — e.g. GPT or Gemini models). The agent runs headless in ' +
          'the same working directory and its final answer is returned as this tool result. ' +
          'The result includes a session_id — pass it back as `session_id` to continue the same ' +
          'agent with its context intact (multi-turn collaboration). The available model list is ' +
          'user-configured; omit `model` to use the configured default.',
        {
          engine: z.enum(['opencode']).describe('Target engine to dispatch to'),
          prompt: z.string().describe('Task for the dispatched agent'),
          model: z
            .string()
            .optional()
            .describe(
              'Target model as "providerID/modelID" (must be user-allowed). Omit for the configured default.'
            ),
          session_id: z
            .string()
            .optional()
            .describe('session_id from a previous dispatch_agent result — continues that agent')
        },
        async ({ engine, prompt, model, session_id }, extra) => {
          const result = await crossEngineDispatcher.dispatch(
            { engine, prompt, model, sessionId: session_id },
            {
              fromEngine: ctx.engineId,
              fromRoutingId: ctx.getRoutingId(),
              cwd: ctx.cwd,
              autonomyMode: ctx.getAutonomyMode(),
              emit: ctx.emit,
              extra
            }
          )
          const text = result.isError
            ? result.text
            : `${result.text}\n\n[dispatch session_id: ${result.sessionId} — pass it as session_id to continue this agent]`
          return {
            content: [{ type: 'text' as const, text }],
            ...(result.isError ? { isError: true } : {})
          }
        }
      )
    ]
  })
}
