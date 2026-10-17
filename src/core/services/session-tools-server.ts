import { createSdkMcpServer, tool } from '../sdk'
import type { SdkMcpServer } from '../sdk'
import { z } from 'zod'
import {
  OWN_TEAMMATE_MESSAGE_TOOL,
  sessionToolDescriptions,
  type SessionToolName
} from '../../shared/session-tools-description'
import { runSessionTool, type SessionToolCaller } from './session-tools'
import type { SdkToolExtra } from '../sdk'

/** The server's name; its tools are `mcp__claude-ui-sessions__session_*`. */
export const SESSION_TOOLS_SERVER_NAME = 'claude-ui-sessions'
export const SESSION_TOOLS_PREFIX = `mcp__${SESSION_TOOLS_SERVER_NAME}__`

export interface SessionToolsServerContext {
  /** The calling session, read live at every call (the routing id is rekeyed after init). */
  getCaller: () => SessionToolCaller
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
  const engine = z.enum(['claude', 'opencode', 'pi', 'codex'])
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
    tools: [
      tool(
        'session_list',
        d.session_list,
        {
          scope: z.enum(['linked', 'project', 'all']).optional(),
          limit: z.number().int().optional(),
          include_archived: z.boolean().optional()
        },
        (input, extra) => run('session_list', input, extra),
        load
      ),
      tool(
        'session_get',
        d.session_get,
        { session: z.string().describe('A session ref, self, parent or an exact unique title') },
        (input, extra) => run('session_get', input, extra),
        load
      ),
      tool(
        'session_read',
        d.session_read,
        {
          session: z.string().describe('A session ref, self, parent or an exact unique title'),
          before: z
            .number()
            .int()
            .optional()
            .describe('A message number: return the ones before it'),
          limit: z.number().int().optional()
        },
        (input, extra) => run('session_read', input, extra),
        load
      ),
      tool(
        'session_message',
        d.session_message,
        {
          session: z.string().describe('A session ref, parent or an exact unique title'),
          message: z.string().describe('What to tell that session')
        },
        (input, extra) => run('session_message', input, extra),
        load
      ),
      tool(
        'session_start',
        d.session_start,
        {
          mode: z.enum(['start']).optional(),
          title: z.string().describe('A short name for the new session (under 60 characters)'),
          prompt: z.string().describe('The task: the area, and what done looks like'),
          background: z
            .string()
            .describe('Everything the new session cannot see and needs (at least 80 characters)'),
          engine: engine.optional(),
          model: z.string().optional(),
          effort: z.string().optional(),
          permission_mode: z
            .enum(['plan', 'default', 'acceptEdits', 'auto', 'bypassPermissions'])
            .optional(),
          cwd: z.string().optional().describe('Inside your own working tree'),
          worktree: z.string().optional().describe('A name: start it in a new git worktree'),
          wake_when_done: z.boolean().optional()
        },
        (input, extra) => run('session_start', input, extra),
        load
      ),
      tool(
        'session_hand_off',
        d.session_hand_off,
        {
          title: z
            .string()
            .describe('A short name for the continuing session (under 60 characters)'),
          handoff: z
            .string()
            .describe(
              'The complete write-up: goal, state, decisions, remaining plan, files touched, how to verify'
            ),
          engine: engine.optional(),
          model: z.string().optional(),
          effort: z.string().optional()
        },
        (input, extra) => run('session_hand_off', input, extra),
        load
      ),
      tool(
        'session_usage',
        d.session_usage,
        { session: z.string().optional().describe('Default: self') },
        (input, extra) => run('session_usage', input, extra),
        load
      ),
      tool(
        'session_stop',
        d.session_stop,
        { session: z.string().describe('A session ref or an exact unique title') },
        (input, extra) => run('session_stop', input, extra),
        load
      )
    ]
  })
}
