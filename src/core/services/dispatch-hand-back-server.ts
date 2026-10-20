import { createSdkMcpServer, tool } from '../sdk'
import type { SdkMcpServer, SdkToolExtra } from '../sdk'
import { z } from 'zod'
import {
  HAND_BACK_DESCRIPTION,
  HAND_BACK_REPORT_PARAM,
  HAND_BACK_TOOL
} from '../../shared/dispatch-agent-description'

/** The server's name; its one tool is `mcp__claude-ui-handback__hand_back`. */
export const HAND_BACK_SERVER_NAME = 'claude-ui-handback'
export const CLAUDE_HAND_BACK_TOOL = `mcp__${HAND_BACK_SERVER_NAME}__${HAND_BACK_TOOL}`

export interface HandBackAnswer {
  text: string
  isError: boolean
}

/**
 * In-process MCP server carrying `hand_back` for ONE Claude dispatch target (ADR-105 §3):
 * the way the agent delivers its final report. Built per spawn by the dispatcher, with
 * the target's entry in its closure, so a call needs no identity lookup: the process IS
 * the X-Agent. A SEPARATE server from `claude-ui-collab` / `claude-ui-sessions` for the
 * same reason they are separate: the prefix is the target's alone (it is listed in
 * `allowedTools` only in `dontAsk`/`bypassPermissions`, `claudeOwnToolsPreAllowed`), and `alwaysLoad` keeps the tool in the prompt
 * from the first turn instead of behind tool search.
 */
export function createHandBackServer(
  onHandBack: (
    report: unknown,
    callId: string | undefined
  ) => HandBackAnswer | Promise<HandBackAnswer>
): SdkMcpServer {
  return createSdkMcpServer({
    name: HAND_BACK_SERVER_NAME,
    version: '1.0.0',
    tools: [
      tool(
        HAND_BACK_TOOL,
        HAND_BACK_DESCRIPTION,
        { report: z.string().describe(HAND_BACK_REPORT_PARAM) },
        async ({ report }, extra?: SdkToolExtra) => {
          // cli.js stamps the calling tool_use block's id on every MCP tools/call; the
          // dispatcher ends the turn when this call's tool_result goes by on the stream.
          const id = extra?.meta?.['claudecode/toolUseId']
          const answer = await onHandBack(report, typeof id === 'string' ? id : undefined)
          return {
            content: [{ type: 'text' as const, text: answer.text }],
            ...(answer.isError ? { isError: true as const } : {})
          }
        },
        { alwaysLoad: true }
      )
    ]
  })
}
