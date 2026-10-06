/**
 * The first line of the `agent` tool result ClaudeUI's host returns for a pi
 * subagent launched in the background (ADR-089 S3; Claude Code's wording).
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

/** The host-written line carrying the model an agent actually runs on (after alias / bare-id resolution). */
export const piAgentModelLine = (model: string): string => `model: ${model}`

const FOREGROUND_MODEL_TAIL =
  /\nmodel: (\S+)\n<usage>total_tokens: \d+\ntool_uses: \d+\nduration_ms: \d+<\/usage>$/

/**
 * The model a pi `agent` call RESOLVED to (an alias or bare id in the call's
 * input is not what runs), read from the result the host wrote — the
 * tool_result block carries no `details`, so the host puts the line in the
 * text, where the renderer and a reloaded history read it alike. Only the two
 * places the host owns count: the launch acknowledgement's own lines, and the
 * trailer the host appends AFTER a foreground report (a report is
 * model-authored and cannot forge the end of the text). Undefined for an
 * error result or any other shape.
 */
export function piAgentResultModel(result: {
  toolResult: string
  isError?: boolean
}): string | undefined {
  if (result.isError === true) return undefined
  const text = result.toolResult
  if (text.startsWith(PI_ASYNC_LAUNCHED_PREFIX)) {
    return /^model: (\S+)$/m.exec(text.split('\n').slice(0, 4).join('\n'))?.[1]
  }
  return FOREGROUND_MODEL_TAIL.exec(text)?.[1]
}
