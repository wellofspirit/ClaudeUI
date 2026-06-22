/**
 * Test stub for `@opencode-ai/plugin`.
 *
 * The real package is provided by the opencode binary at plugin-load time and is
 * NOT a ClaudeUI dependency (see Phase 5c Part B). vitest runs in plain Node and
 * can't resolve it, so vitest.config.ts aliases `@opencode-ai/plugin` → this stub.
 *
 * Mirrors the real `tool.js` exactly (verified vs opencode 1.17.9):
 *   export function tool(input) { return input }
 *   tool.schema = z
 * This lets plugin tests import the real plugin module and call each tool's
 * execute() directly with a fake ToolContext.
 */
import { z } from 'zod'

export function tool<T>(input: T): T {
  return input
}
// Attach the zod schema builder the same way the real package does.
;(tool as unknown as { schema: typeof z }).schema = z
