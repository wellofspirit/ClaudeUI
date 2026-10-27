import type { ZodType } from 'zod'
import { createSdkMcpServer, tool } from '../sdk'
import type { SdkMcpServer } from '../sdk'
import {
  OWN_TEAMMATE_MESSAGE_TOOL,
  SESSION_TOOL_NAMES,
  SESSION_TOOLS_SERVER_NAME,
  sessionToolDescriptions,
  type SessionToolName
} from '../../shared/session-tools-description'
import { runSessionTool, type SessionToolCaller } from './session-tools'
import { SESSION_TOOL_SHAPES, X_AGENT_SESSION_MESSAGE_SHAPE } from './session-tool-specs'
import { X_AGENT_SESSION_MESSAGE_DESCRIPTION } from '../../shared/x-agent-message'
import type { SdkToolExtra } from '../sdk'

/** The server's name (shared with the other engines' renderers); its tools are `mcp__claude-ui-sessions__session_*`. */
export { SESSION_TOOLS_SERVER_NAME }
export const SESSION_TOOLS_PREFIX = `mcp__${SESSION_TOOLS_SERVER_NAME}__`

export interface SessionToolsServerContext {
  /** The calling session, read live at every call (the routing id is rekeyed after init). */
  getCaller: () => SessionToolCaller
  /**
   * The server of a dispatch target (ADR-105 §4): `session_message` alone, worded for an X-Agent
   * (the dispatcher is the only session it can reach). The same server name as a root session's,
   * so labels, the user's deny rules and the service all recognise the tool.
   */
  xAgent?: boolean
}

/**
 * In-process MCP server hosting the session tools for one Claude session (session
 * tools, slice 1c; the `createCollabServer` pattern, ADR-033).
 *
 * A SEPARATE server from `claude-ui` so the tools do not ride that server's
 * auto-allowed prefix, and from `claude-ui-collab` so dispatch keeps its own
 * approval path: every call goes through `canUseTool` and the session-tools gate.
 * The tools are marked `alwaysLoad` so Claude Code keeps them in the prompt from
 * the first turn instead of deferring them behind its tool search, where a model
 * that has never searched would not know they exist.
 */
export function createSessionToolsServer(ctx: SessionToolsServerContext): SdkMcpServer {
  const d = sessionToolDescriptions({ ownMessageTool: OWN_TEAMMATE_MESSAGE_TOOL.claude })
  const names: readonly SessionToolName[] = ctx.xAgent ? ['session_message'] : SESSION_TOOL_NAMES
  const description = (name: SessionToolName): string =>
    ctx.xAgent ? X_AGENT_SESSION_MESSAGE_DESCRIPTION : d[name]
  const shape = (name: SessionToolName): Record<string, ZodType> =>
    ctx.xAgent ? X_AGENT_SESSION_MESSAGE_SHAPE : SESSION_TOOL_SHAPES[name]
  const run = async (
    name: SessionToolName,
    input: Record<string, unknown>,
    extra?: SdkToolExtra
  ): Promise<{ content: { type: 'text'; text: string }[]; isError?: true }> => {
    // cli.js stamps the calling tool_use block's id on every MCP tools/call; it is
    // how the service learns whether the root agent or a subagent made the call.
    const id = extra?.meta?.['claudecode/toolUseId']
    const result = await runSessionTool(
      { ...ctx.getCaller(), ...(typeof id === 'string' ? { toolUseId: id } : {}) },
      name,
      input
    )
    return {
      content: [{ type: 'text' as const, text: result.text }],
      ...(result.isError ? { isError: true as const } : {})
    }
  }
  const load = { alwaysLoad: true }

  return createSdkMcpServer({
    name: SESSION_TOOLS_SERVER_NAME,
    version: '1.0.0',
    tools: names.map((name) =>
      tool(name, description(name), shape(name), (input, extra) => run(name, input, extra), load)
    )
  })
}
