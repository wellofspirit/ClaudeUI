/**
 * The one description of the cross-engine `dispatch_agent` tool (ADR-033,
 * amended by ADR-089's messaging v2). Every engine registers its own copy of
 * the tool (Claude's collab MCP server, opencode's and Codex's hosted tools,
 * pi's bridge extension) and each used to carry its own prose. The prose lives
 * here once; a caller supplies only what differs: the target engines, its OWN
 * built-in subagent tool, and the per-target model hints it builds from its
 * config snapshot (`dispatch-model-hint.ts`).
 *
 * The point of the shared steer: a model with a native subagent tool should
 * use it for ordinary delegation, and reach for `dispatch_agent` only when the
 * user wants another engine or model vendor.
 *
 * Pure strings, no imports beyond a type: usable from main, the pi bridge's
 * env and the Claude system prompt alike.
 */
import type { EngineId } from './types'

/** Engines a session can dispatch to (a session never dispatches to its own). */
export type DispatchTargetEngine = Extract<EngineId, 'claude' | 'opencode' | 'pi' | 'codex'>

/** What each target is, in the description's own words. */
export const DISPATCH_TARGET_BLURBS: Record<DispatchTargetEngine, string> = {
  claude: "Anthropic's models",
  opencode: 'fronts non-Anthropic model vendors, e.g. GPT or Gemini models',
  pi: 'an alternative coding-agent harness',
  codex: "OpenAI's own coding agent"
}

/**
 * Each engine's own built-in subagent tool, as the model sees it (verified:
 * Claude Code's `Agent`; pi's bridge `agent`; opencode's
 * `vendor/opencode-src/packages/opencode/src/tool/task.ts` id `task`; Codex's
 * `vendor/codex-src/codex-rs/core/src/tools/handlers/multi_agents_spec.rs`
 * `spawn_agent`).
 */
export const OWN_SUBAGENT_TOOL: Record<'claude' | 'pi' | 'opencode' | 'codex', string> = {
  claude: 'Agent',
  pi: 'agent',
  opencode: 'task',
  codex: 'spawn_agent'
}

/** `a (blurb), b (blurb) or c (blurb)` */
function targetBlurbs(targets: readonly DispatchTargetEngine[]): string {
  const parts = targets.map((t) => `${t} (${DISPATCH_TARGET_BLURBS[t]})`)
  return parts.length <= 1
    ? parts.join('')
    : `${parts.slice(0, -1).join(', ')} or ${parts[parts.length - 1]}`
}

/** When to use dispatch_agent, and when NOT to: the steer toward the engine's own subagent tool. */
export function dispatchUsageGuidance(ownSubagentTool: string): string {
  return (
    'Use this only when the user asks for a different engine or model vendor, or wants an ' +
    'independent second opinion from a different model family. For ordinary delegation ' +
    '(research, exploration, parallel or background work, implementation) use your own ' +
    `${ownSubagentTool} tool instead: it is cheaper, starts faster and stays inside this session.`
  )
}

/** The continuation contract every dispatch result carries. */
export const DISPATCH_SESSION_ID_GUIDANCE =
  'The result includes a session_id — pass it back as `session_id` to continue the same agent ' +
  'with its context intact.'

/** `For opencode: <long> For pi: <long>` — the callers' per-target model hints, in order. */
export function joinDispatchHints(
  hints: readonly { targetEngine: string; long: string }[]
): string {
  return hints.map((hint) => `For ${hint.targetEngine}: ${hint.long}`).join(' ')
}

/** The `dispatch_agent` tool description. `hints` is the callers' own per-target model prose. */
export function dispatchAgentDescription(opts: {
  targets: readonly DispatchTargetEngine[]
  /** The calling engine's own subagent tool name. */
  ownSubagentTool: string
  hints: string
}): string {
  return (
    `Delegate a task to an agent on a DIFFERENT engine — ${targetBlurbs(opts.targets)}. ` +
    `${dispatchUsageGuidance(opts.ownSubagentTool)} ` +
    'The agent runs headless in the same working directory and its final answer is returned as ' +
    `this tool result. ${DISPATCH_SESSION_ID_GUIDANCE} ` +
    'The available model list is user-configured per target engine; omit `model` to use that ' +
    "engine's configured default." +
    (opts.hints ? ` ${opts.hints}` : '')
  )
}

/**
 * The same facts as a short system-prompt section (Claude's `claude-ui-collab`
 * tool): what it is, the targets, when to prefer the built-in tool, and the
 * `session_id` continuation. Built from the constants above, so it can never
 * drift from the tool description.
 */
export function dispatchAgentPromptSection(opts: {
  /** The tool's full name in the prompt, e.g. `mcp__claude-ui-collab__dispatch_agent`. */
  toolName: string
  targets: readonly DispatchTargetEngine[]
  ownSubagentTool: string
}): string {
  return (
    `You have a \`${opts.toolName}\` tool that delegates a task to an agent on a different ` +
    `engine: ${targetBlurbs(opts.targets)}. ${dispatchUsageGuidance(opts.ownSubagentTool)} ` +
    `${DISPATCH_SESSION_ID_GUIDANCE} The model list is user-configured.`
  )
}
