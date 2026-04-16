import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk'
import { z } from 'zod'

/**
 * Callback invoked when the classifier model calls the classify_result tool.
 * The auto-classifier service sets this to resolve the pending classification promise.
 */
export type ClassifyResultHandler = (result: ClassifyResult) => void

export interface ClassifyResult {
  thinking: string
  shouldBlock: boolean
  reason: string
}

/**
 * Creates an in-process MCP server for the auto-mode classifier.
 *
 * Exposes a single `classify_result` tool that the Haiku classifier session
 * calls to report its security classification decision. The handler callback
 * bridges the MCP tool call back to the promise awaited by canUseTool.
 */
export function createClassifierServer(
  onResult: ClassifyResultHandler
): ReturnType<typeof createSdkMcpServer> {
  return createSdkMcpServer({
    name: 'auto-classifier',
    version: '1.0.0',
    tools: [
      tool(
        'classify_result',
        'Report the security classification result for the agent action. ' +
          'You MUST call this tool for every classification request.',
        {
          thinking: z
            .string()
            .describe('Brief step-by-step reasoning about whether the action should be blocked'),
          shouldBlock: z
            .boolean()
            .describe('Whether the action should be blocked (true) or allowed (false)'),
          reason: z.string().describe('Brief explanation of the classification decision')
        },
        async ({ thinking, shouldBlock, reason }) => {
          onResult({ thinking, shouldBlock, reason })
          return {
            content: [{ type: 'text' as const, text: 'Classification recorded.' }]
          }
        }
      )
    ]
  })
}
