/**
 * Make a live cli.js re-read its MCP config after a native `claude mcp add-json` /
 * `remove`, deterministically.
 *
 * cli.js keeps `~/.claude.json` (user and local scope) in an in-memory cache that a
 * file watcher refreshes (`freshnessWatcherStarted`, poll/settle timers in cli.js
 * 2.1.317), so a `reload_plugins` right after the write can still read the old
 * file; probed lag 0.25 to 0.9 s. A project `.mcp.json` is read fresh. The
 * protocol has no "refresh the global config" request, so: reload, check
 * `mcp_status` for the expected outcome, and retry after a short wait. Bounded: on
 * giving up the next session start picks the change up anyway.
 */

export interface McpReloadExpectation {
  /** The name Claude Code knows the server by. */
  name: string
  /** true after an add (must be listed), false after a remove (must be gone). */
  present: boolean
}

export interface McpReloadHandle {
  reloadPlugins(): Promise<unknown>
  mcpServerStatus(): Promise<unknown>
}

/** Waits before retry 1, 2, 3 (about 1.6 s in all, against a measured 0.9 s worst case). */
export const RELOAD_RETRY_DELAYS_MS = [300, 500, 800]

function listed(status: unknown, name: string): boolean {
  return (
    Array.isArray(status) && status.some((s) => (s as { name?: unknown } | null)?.name === name)
  )
}

/** Resolves true when the expectation held (or none was given), false when it gave up. */
export async function reloadMcpUntil(
  handle: McpReloadHandle,
  expect?: McpReloadExpectation,
  delaysMs: readonly number[] = RELOAD_RETRY_DELAYS_MS,
  sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms))
): Promise<boolean> {
  for (let attempt = 0; ; attempt++) {
    await handle.reloadPlugins()
    if (!expect) return true
    const status = await handle.mcpServerStatus()
    if (listed(status, expect.name) === expect.present) return true
    if (attempt >= delaysMs.length) return false
    await sleep(delaysMs[attempt])
  }
}
