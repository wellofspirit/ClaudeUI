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

/**
 * The optional `name` and `description` inputs, worded once for the four
 * registrations (the pi bridge is import-free, so it carries these two strings as
 * literals and a test pins them to these). Same meaning as Claude Code's Agent
 * tool: `name` is a short handle, `description` a 3-5 word summary.
 */
export const DISPATCH_NAME_PARAM =
  'Optional short handle for this agent, e.g. "impl-e1". It labels the agent in the agent list; ' +
  'keep it short and distinct from your other agents.'
export const DISPATCH_DESCRIPTION_PARAM =
  'Optional 3-5 word summary of the task, shown on the agent card (e.g. "Review auth diff").'

/**
 * The optional `run_in_background` input (ADR-105 §2), worded once for the four
 * registrations (the pi bridge carries it as a literal and a test pins it to this).
 * Until results are delivered into the parent's conversation the default stays "wait";
 * a background agent's answer shows on its card.
 */
export const DISPATCH_BACKGROUND_PARAM =
  'Set true to start the agent and return at once instead of waiting for its answer. The answer of a ' +
  'background agent appears on its agent card in the UI; it is not returned to you. Default false: wait, ' +
  'and receive the answer as this tool result.'

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
    'The agent runs headless in the same working directory and the report it hands back is returned as ' +
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

// ── hand_back (ADR-105 §3) ─────────────────────────────────────────────────────────────────────

/** The tool every X-Agent is given to deliver its report (bare name; opencode prefixes `claudeui_`). */
export const HAND_BACK_TOOL = 'hand_back'

/** The one description of `hand_back`, for the four target engines' registrations. */
export const HAND_BACK_DESCRIPTION =
  'Deliver your final report to the agent that dispatched you. Call it once, as your last action; ' +
  'your run ends when it returns. Use it for the result, not for questions or progress updates: ' +
  'the report you pass is the only thing your dispatcher receives, and plain text you write at the ' +
  'end of your run is NOT delivered. Put everything your dispatcher needs in that one report.'

/** The `report` input's description. */
export const HAND_BACK_REPORT_PARAM = 'Your full final report for the agent that dispatched you'

/** The tool result of the call that delivered the report. */
export const HAND_BACK_DONE_TEXT =
  'Report delivered to your dispatcher. Your run is over: anything you write after this is not delivered.'

/** The tool result of a second call in the same run. */
export const HAND_BACK_REPEAT_TEXT = 'Your report was already delivered; your run has ended.'

/** The tool result of a call after the run it belongs to is over. */
export const HAND_BACK_ENDED_TEXT = 'Your run has ended; no report was taken.'

/** The tool result of a call a subagent of the X-Agent made (only the X-Agent itself reports). */
export const HAND_BACK_SUBAGENT_TEXT =
  'hand_back is for the X-Agent itself: a subagent it started cannot deliver the report. Pass ' +
  'what you found to the agent that started you.'

/** The tool result of a call that could not be attributed to the X-Agent itself. */
export const HAND_BACK_UNATTRIBUTED_TEXT =
  'hand_back could not tell which agent made this call, so no report was taken. Call it again ' +
  'from the main agent.'

/** The tool result of a call from anything that is not a running X-Agent. */
export const HAND_BACK_NOT_TARGET_TEXT =
  'hand_back is for dispatched agents delivering their final report; this session is not running as one.'

/** The tool result of a call with no report in it. */
export const HAND_BACK_EMPTY_TEXT = 'The report must not be empty: pass your full final report.'

/** The follow-up prompt a run that ended without a report gets (up to three times); `toolName` is what its engine calls the tool. */
export function handBackNudge(toolName: string = HAND_BACK_TOOL): string {
  return `[hand_back] Your report has not been delivered. Call ${toolName} with your final report now.`
}

/** Appended to the task an X-Agent is given, so it knows how to finish; `toolName` is what its engine calls the tool. */
export function handBackTaskSuffix(toolName: string = HAND_BACK_TOOL): string {
  return (
    `\n\nWhen your work is complete, deliver your final report by calling the ${toolName} tool ` +
    'with the whole report. The call ends your run; plain text at the end of your run is not delivered.'
  )
}

/** What a run that never delivered a report ends as (the card, a waiting dispatcher). */
export function handBackWithheldText(name: string): string {
  return `X-Agent ${name} ended without delivering a report.`
}

/** The warning above a report taken from an agent's last message, because its run had no `hand_back` tool. */
export const HAND_BACK_FALLBACK_WARNING =
  'This X-Agent has no hand_back tool (it was started before reports were delivered that way), so ' +
  'its last message is shown as the report. It is not a report the agent chose to hand over.'
