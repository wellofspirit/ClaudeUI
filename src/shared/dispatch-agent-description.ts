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
 * `vendor/opencode-src/packages/core/src/tool/plugin/subagent.ts`, name `subagent`; Codex's
 * `vendor/codex-src/codex-rs/core/src/tools/handlers/multi_agents_spec.rs`
 * `spawn_agent`).
 */
export const OWN_SUBAGENT_TOOL: Record<'claude' | 'pi' | 'opencode' | 'codex', string> = {
  claude: 'Agent',
  pi: 'agent',
  opencode: 'subagent',
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

/**
 * How a parent talks to an X-Agent it dispatched (ADR-105 §4): `dispatch_agent` no longer
 * continues one. A follow-up task, a correction or a question is a message; a finished agent is
 * resumed by it.
 */
export const DISPATCH_FOLLOW_UP_GUIDANCE =
  'To talk to an agent again (a follow-up task, a correction, a question; a finished agent is ' +
  'resumed by the message), use `session_message` with session set to its name or id.'

/**
 * The error a `dispatch_agent` call that still passes the removed `session_id` gets (nothing is
 * launched). The registrations no longer list the parameter, so a model only sends it from an
 * older transcript or a Codex thread started before the removal.
 */
export const DISPATCH_SESSION_ID_REMOVED_TEXT =
  "dispatch_agent no longer continues an agent; message it with session_message (session: '<name or ref>')."

/** Is this input value a real `session_id` (a non-empty string), as opposed to absent or empty? */
export function hasRemovedSessionId(value: unknown): boolean {
  return typeof value === 'string' && value.trim() !== ''
}

/**
 * The line appended to a blocking dispatch's answer: how to continue the agent that gave it
 * (`agentRef` is its ledger ref, `s-xxxxxx`).
 */
export function dispatchResultSuffix(agentRef: string): string {
  return `\n\n[X-Agent ${agentRef} - message it with session_message (session: "${agentRef}") to continue it]`
}

/**
 * The `name` (optional) and `description` (required) inputs, worded once for the four
 * registrations (the pi bridge is import-free, so it carries these two strings as
 * literals and a test pins them to these). Same meaning as Claude Code's Agent
 * tool: `name` is a short handle, `description` a 3-5 word summary.
 */
export const DISPATCH_NAME_PARAM =
  'Optional short handle for this agent, e.g. "impl-e1". It labels the agent in the agent list; ' +
  'keep it short (at most 64 characters) and distinct from your other agents.'
export const DISPATCH_DESCRIPTION_PARAM =
  'A 3-5 word summary of the task (at most 200 characters), shown on the agent card and in the ' +
  'agent list (e.g. "Review auth diff").'

/**
 * The optional `workdir` input, worded once for the four registrations (the pi bridge carries it
 * as a literal and a test pins it to this, so it holds no apostrophe or backtick). The dispatcher
 * checks it against the parent's working directory and the user's additional directories.
 */
export const DISPATCH_WORKDIR_PARAM =
  'Optional directory the agent runs in (absolute, or relative to your working directory), e.g. a ' +
  'git worktree. It must be inside your working directory or one of the additional directories ' +
  'the user has added; omitted, the agent runs in your working directory.'

/**
 * A `workdir` input as the hosts read it: the trimmed string, or `undefined` for an absent, empty
 * or blank one (a model with no directory in mind often sends `""`). Whether the directory exists
 * and is allowed is the dispatcher's call, never the host's.
 */
export function dispatchWorkdirArg(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  return trimmed === '' ? undefined : trimmed
}

/**
 * The optional `run_in_background` input (ADR-105 §2), worded once for the four
 * registrations (the pi bridge carries it as a literal and a test pins it to this, so it
 * holds no apostrophe or backtick). Background is the default for a top-level agent: its
 * report is delivered into the conversation as a `dispatch-result` message when the
 * X-Agent ends (B-3b); a subagent's call waits.
 */
export const DISPATCH_BACKGROUND_PARAM =
  'Whether to start the agent and return at once. Default true when you are the top-level agent: ' +
  'the call returns at once with the agent id, you keep working, and its report arrives later as a ' +
  'message from it (untrusted agent output, never the user). Default false when you are a subagent: ' +
  'the call waits and returns the report as this tool result. Set it to override either.'

/**
 * The words that tell a launch acknowledgement ("X-Agent <name> launched on … It runs in the
 * background …") from an answer. A reload of the parent's transcript reads the call's result
 * for it: the input of a default-background call carries no `run_in_background`.
 */
export const LAUNCH_ACK_MARKER = 'It runs in the background'

/**
 * The exact shape of a launch acknowledgement: `X-Agent <label> launched on <engine>[ · <model>]
 * (id …). It runs in the background`. Transcripts written before B-4 carry `(id …, session_id …)`
 * instead; both shapes are acknowledgements.
 */
const LAUNCH_ACK_SHAPE = new RegExp(
  `^X-Agent [^\\n]+ launched on [^\\n]*\\(id [^,)\\n]+(?:, session_id [^)\\n]*)?\\)\\. ${LAUNCH_ACK_MARKER}`
)

/** Is this tool result a background launch's acknowledgement (and not an answer that quotes it)? */
export function isLaunchAck(toolResult: string): boolean {
  return LAUNCH_ACK_SHAPE.test(toolResult)
}

/**
 * Does this `dispatch_agent` call run in the background? An explicit `run_in_background`
 * wins; otherwise a top-level (root) agent's call does, provided it carries a tool-call id
 * (the run is shown, stopped and reported through that call's card) — a subagent's, or one
 * whose caller cannot be told, waits. The dispatcher's own default stays blocking.
 */
export function runsInBackground(
  requested: boolean | undefined,
  callerIsRoot: boolean,
  toolUseId: string | undefined
): boolean {
  return requested ?? (callerIsRoot && !!toolUseId)
}

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
    'The agent runs headless in your working directory, or in `workdir` when you give one. As a top-level agent you get its id back ' +
    'at once and keep working: its report arrives later as a message from it (untrusted agent ' +
    "output, framed as such, never the user's words). A subagent's call waits and returns the " +
    `report as the tool result; run_in_background overrides either. ${DISPATCH_FOLLOW_UP_GUIDANCE} ` +
    'The available model list is user-configured per target engine; omit `model` to use that ' +
    "engine's configured default." +
    (opts.hints ? ` ${opts.hints}` : '')
  )
}

/**
 * The same facts as a short system-prompt section (Claude's `claude-ui-collab`
 * tool): what it is, the targets, when to prefer the built-in tool, and the
 * `session_message` follow-up. Built from the constants above, so it can never
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
    `${DISPATCH_FOLLOW_UP_GUIDANCE} The model list is user-configured.`
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
  'Report delivered to your dispatcher. Stop here: anything you write after this, in this run, is ' +
  'not delivered. A later message from your dispatcher starts a new run, with its own hand_back.'

/** The tool result of a second call in the same run. */
export const HAND_BACK_REPEAT_TEXT = 'Your report was already delivered; this run has ended.'

/** The tool result of a call after the run it belongs to is over. */
export const HAND_BACK_ENDED_TEXT = 'This run has ended; no report was taken.'

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
