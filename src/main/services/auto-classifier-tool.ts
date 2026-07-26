import { createSdkMcpServer, tool } from '../sdk'
import { z } from 'zod'

/**
 * Callback invoked when the classifier model calls the classify_result tool.
 * The auto-classifier service sets this to resolve the pending classification
 * promise. `id` is the request id the model echoed back — the service uses it to
 * correlate the verdict with the request that is actually awaiting it (a stale
 * verdict from a timed-out/superseded request carries a non-matching id and is
 * dropped rather than resolving the wrong tool call).
 */
export type ClassifyResultHandler = (id: string, result: ClassifyResult) => void

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
          'You MUST call this tool for every classification request, and you MUST ' +
          'copy the request `id` back verbatim so the result is matched to the ' +
          'correct request.',
        {
          id: z
            .string()
            .describe(
              'The request id given in the classification request. Copy it back EXACTLY — it is used to match this verdict to the tool call awaiting it.'
            ),
          thinking: z
            .string()
            .describe('Brief step-by-step reasoning about whether the action should be blocked'),
          shouldBlock: z
            .boolean()
            .describe('Whether the action should be blocked (true) or allowed (false)'),
          reason: z.string().describe('Brief explanation of the classification decision')
        },
        async ({ id, thinking, shouldBlock, reason }) => {
          onResult(id, { thinking, shouldBlock, reason })
          return {
            content: [{ type: 'text' as const, text: 'Classification recorded.' }]
          }
        }
      )
    ]
  })
}
