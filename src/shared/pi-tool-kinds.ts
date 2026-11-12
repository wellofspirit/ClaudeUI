/**
 * pi's tool name -> kind: the one function both sides call. The renderer's
 * `PiEngineToolMap.kindOf` is it, and the permission ladder reads its answer
 * (`decideWithSource` in `src/core/pi/permission-engine.ts`), so a kind change is a
 * permission change, pinned by `tool-kind-matrix.test.ts`.
 */
import { hostedToolKind } from './hosted-tools'
import type { ToolKind } from './tool-kinds'
import { hostedMcpKind } from './tool-kinds'

export function piToolKind(toolName: string): ToolKind {
  // Real `mcp__*` names resolve engine-independently first; pi's own hosted tools
  // (and the session tools) are registered under their bare names.
  const hosted = hostedMcpKind(toolName) ?? hostedToolKind(toolName, 'bare')
  if (hosted !== null) return hosted

  switch (toolName) {
    case 'bash':
      return 'command'
    case 'edit':
      return 'fileEdit'
    case 'write':
      return 'fileWrite'
    case 'read':
      return 'fileRead'
    case 'grep':
    case 'find':
    case 'ls':
      return 'search'
    // Plan mode (M5a): the bridge extension's locally-executed exit_plan tool
    // (gated on CLAUDEUI_PI_PLAN_TOOLS), the same 'plan' kind Claude's ExitPlanMode takes.
    case 'exit_plan':
      return 'plan'
    // Host-run pi subagents (ADR-089): the bridge's own `agent` tool, the same
    // 'task' kind dispatch_agent uses (TaskCard is engine-neutral).
    case 'agent':
      return 'task'
    // `subagent`: legacy M5b transcripts (the retired in-pi extension) and pi's
    // upstream example subagent extension a user may load themselves.
    case 'subagent':
      return 'task'
    // ADR-089 S3b: the bridge's `send_message` / `task_stop` — Claude's
    // SendMessage / TaskStop row kinds.
    case 'send_message':
      return 'detail'
    case 'task_stop':
      return 'note'
    // The bridge's `list_models` (read-only; a one-line note row).
    case 'list_models':
      return 'note'
    default:
      return 'unknown'
  }
}
