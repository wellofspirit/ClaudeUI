/**
 * In-process MCP server hosting Claude's `generate_image` / `generate_video` (the media job service).
 *
 * A SEPARATE server (`claude-ui-media`), outside `allowedTools` and the auto-allowed `mcp__claude-ui__`
 * prefix, so a call reaches `canUseTool` (the approval card with the normal suggestions; auto mode is
 * cli.js's own classifier). cli.js skips `canUseTool` for a tool the user allowed by rule, so the handler
 * itself refuses in plan mode. The job is never tied to the call's abort signal: Esc must not kill it.
 */
import { createSdkMcpServer, tool } from '../sdk'
import type { SdkMcpServer } from '../sdk'
import {
  CLAUDE_MEDIA_MCP_SERVER,
  MEDIA_TOOL_NAMES,
  type MediaKind
} from '../../shared/media-generation'
import { MEDIA_TOOL_DESCRIPTIONS } from '../../shared/media-tools-description'
import type { EngineId } from '../../shared/types'
import { mediaJobs } from './media-jobs'
import {
  MEDIA_PLAN_MODE_REFUSAL,
  mediaZodShape,
  runMediaTool,
  type MediaStartFn
} from './media-tool-handler'
import type { ToolCallOwner } from './tool-use-owners'

export interface MediaServerContext {
  engineId: EngineId
  /** The session's live routing id (it is rekeyed to its UUID after init), read at each call. */
  getRoutingId: () => string
  /** The directory the session works in now (a worktree it entered, else its spawn directory). */
  getWorkingDirectory: () => string
  /** Live permission mode, read at each call: plan mode refuses. */
  getAutonomyMode: () => string
  /** Who made the call (`ToolUseOwners.ownerOf`): only the root agent's call is a background job. */
  callOwner: (toolUseId: string | undefined) => Promise<ToolCallOwner>
  /** The kinds registered: only those offered at spawn (toggle on and a model resolves; Off registers nothing). */
  kinds: readonly MediaKind[]
  /** Default: the job service. */
  start?: MediaStartFn
}

export function createMediaServer(ctx: MediaServerContext): SdkMcpServer {
  const start: MediaStartFn = ctx.start ?? ((args) => mediaJobs.start(args))
  const mediaTool = (kind: MediaKind): SdkMcpServer['tools'][number] =>
    tool(
      MEDIA_TOOL_NAMES[kind],
      MEDIA_TOOL_DESCRIPTIONS[kind],
      mediaZodShape(kind),
      async (input, extra) => {
        // The mode is read now: cli.js does not ask `canUseTool` for a tool the user allowed by rule.
        if (ctx.getAutonomyMode() === 'plan') {
          return {
            content: [{ type: 'text' as const, text: MEDIA_PLAN_MODE_REFUSAL }],
            isError: true
          }
        }
        // cli.js stamps `_meta["claudecode/toolUseId"]` on every MCP tools/call.
        const meta = extra?.meta?.['claudecode/toolUseId']
        const toolUseId = typeof meta === 'string' ? meta : undefined
        // A subagent's call, or one that cannot be attributed, waits for the outcome.
        const owner = await ctx.callOwner(toolUseId)
        const reply = await runMediaTool(start, {
          routingId: ctx.getRoutingId(),
          cwd: ctx.getWorkingDirectory(),
          engineId: ctx.engineId,
          toolUseId: toolUseId ?? null,
          kind,
          foreground: owner !== 'root',
          input: input as Record<string, unknown>
        })
        return {
          content: [{ type: 'text' as const, text: reply.text }],
          ...(reply.isError ? { isError: true } : {})
        }
      }
    )
  return createSdkMcpServer({
    name: CLAUDE_MEDIA_MCP_SERVER,
    version: '1.0.0',
    tools: ctx.kinds.map(mediaTool)
  })
}
