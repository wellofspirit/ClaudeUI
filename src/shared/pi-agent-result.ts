/**
 * The first line of the `agent` tool result ClaudeUI's host returns for a pi
 * subagent launched in the background (ADR-088 S3; Claude Code's wording).
 * Shared so the renderer can tell a launched background run from a call that
 * was refused before any spawn: the tool_result block carries no `details`
 * (`cuiAgent` stays on disk), and this text is written only by the host
 * (pi-subagents.ts `asyncLaunchedText`), never by the model.
 */
export const PI_ASYNC_LAUNCHED_PREFIX = 'Async agent launched successfully.'

/** Whether an `agent` result is the host's background-launch acknowledgement. */
export function isPiAsyncLaunchResult(result: { toolResult: string; isError?: boolean }): boolean {
  return result.isError !== true && result.toolResult.startsWith(PI_ASYNC_LAUNCHED_PREFIX)
}
