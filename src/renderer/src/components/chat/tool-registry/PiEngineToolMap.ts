/**
 * pi engine tool map — maps pi's built-in tool names to ToolKinds and
 * normalizes their input/result shapes into the SAME engine-neutral ToolView
 * the kind bodies consume.
 *
 * The kindOf switch below IS the canonical pi→kind table. Tool names + input
 * schemas verified from the pinned pi source
 * (`packages/coding-agent/src/core/tools/*.ts`) and the M1 kickoff spec's wire
 * facts: `bash {command, timeout?}`, `read {path, offset?, limit?}`,
 * `write {path, content}`, `edit {path, edits: [{oldText, newText}]}`,
 * `grep {pattern, path?, glob?, ignoreCase?, literal?, context?, limit?}`,
 * `find {pattern, path?, limit?}`, `ls {path?, limit?}`.
 *
 * M2: rich diff — the live event-mapper (src/main/pi/event-mapper.ts) threads
 * the ORIGINAL `edit`/`write` toolCall's `arguments.path` through to the
 * matching toolResult and attaches `fileDiffs: [{path, patch, ...}]` (from
 * pi's ready-made `details.patch` unified diff) to the `tool_result` content
 * block. This fileEdit normalize case surfaces that AS `files` on the
 * ToolView — mirroring OpencodeEngineToolMap's identical `fileDiffs → files`
 * pass-through verbatim — so FileEditBody renders one real diff card per file
 * (works for multi-edit calls too, since the whole turn's edits land in ONE
 * ready-made patch). The single-pair before/after view (below) is only the
 * INPUT-side fallback: it still renders while the result (and its fileDiffs)
 * hasn't arrived yet, or for a call whose result never carries a usable
 * patch. The stored-history converter (src/main/services/pi-session-list.ts)
 * does NOT yet get the same treatment — replayed/resumed sessions still show
 * the before/after fallback for edits; out of scope for this fix (see its own
 * M2 note).
 *
 * M4a+b: hosted tools (render_mermaid/create_mockup/show_mockup) + cross-engine
 * dispatch (dispatch_agent) are registered by the bridge extension via
 * `pi.registerTool()` with BARE names (no `mcp__` prefix) — hostedMcpKind
 * below only matches `mcp__*`-prefixed names, so these four need explicit
 * `kindOf` cases, mirroring src/main/pi/permission-engine.ts's `piToolKind`
 * IDENTICAL cases (the single-source guard test asserts the two tables
 * agree). `dispatch_agent`'s input shape/normalize output mirrors
 * OpencodeEngineToolMap's `claudeui_dispatch_agent` case (same field names —
 * only the bare-vs-prefixed tool name differs across engines).
 *
 * M5a: plan mode's `exit_plan` (also a bare-name `pi.registerTool()`
 * registration, gated on CLAUDEUI_PI_PLAN_TOOLS) maps to the SAME 'plan' kind
 * Claude's ExitPlanMode does, with the SAME `{plan}` input shape — it's a
 * lifted kind (MessageBubble.renderToolBlock routes it to ExitPlanModeCard
 * before ever consulting displayName), engine-agnostic by design.
 *
 * ADR-089: host-run pi subagents — the bridge's `agent` tool (v9, gated on
 * CLAUDEUI_PI_AGENT_TOOL) maps to 'task', reusing TaskCard alongside
 * dispatch_agent. `subagent` (legacy M5b transcripts from the retired in-pi
 * extension, and pi's upstream example extension) maps to 'task' too.
 * piNormalize does not receive the tool name, so its 'task' case
 * disambiguates by input shape: dispatch_agent always carries `engine`;
 * `agent` carries `prompt`+`description` and none of `engine`/`agent`/`tasks`;
 * subagent carries `agent`+`task` (single) or `tasks: [...]` (parallel).
 */

import type { EngineToolMap, ToolKind, ToolView } from '../../../../../shared/tool-kinds'
import { hostedMcpKind } from '../../../../../shared/tool-kinds'
import type { ContentBlock } from '../../../../../shared/types'
import { isPiAsyncLaunchResult, piAgentResultModel } from '../../../../../shared/pi-agent-result'

type ToolResultBlock = Extract<ContentBlock, { type: 'tool_result' }>

/** pi has no internal tools to suppress in M1 (mirrors opencode's empty set). */
const HIDDEN_TOOLS: ReadonlySet<string> = new Set()

function piKindOf(toolName: string): ToolKind {
  // Hosted-tools MCP names resolve engine-independently first (harmless
  // no-op for pi today — covers any real mcp__ tools a future pi MCP bridge
  // adds; pi's OWN hosted tools use bare names, handled by the explicit
  // cases below instead).
  const mcpKind = hostedMcpKind(toolName)
  if (mcpKind !== null) return mcpKind

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
    // Plan mode (M5a) — the bridge extension's locally-executed exit_plan
    // tool (registered via pi.registerTool(), gated on
    // CLAUDEUI_PI_PLAN_TOOLS). Reuses the SAME 'plan' kind Claude's
    // ExitPlanMode maps to — MessageBubble's renderToolBlock lifts it to
    // ExitPlanModeCard regardless of engine. Mirrors permission-engine.ts's
    // piToolKind IDENTICAL case (single-source guard test).
    case 'exit_plan':
      return 'plan'
    // Hosted tools (M4a+b) — pi.registerTool() uses BARE names (see file
    // header). Mirrors permission-engine.ts's piToolKind IDENTICAL cases.
    case 'render_mermaid':
      return 'diagram'
    case 'create_mockup':
    case 'show_mockup':
      return 'mockup'
    case 'dispatch_agent':
      return 'task'
    // Host-run pi subagents (ADR-089) — the bridge's own `agent` tool. Reuses
    // the SAME 'task' kind dispatch_agent does — TaskCard is engine-neutral
    // and disambiguates by input shape (see piNormalize's 'task' case below).
    // Mirrors permission-engine.ts's piToolKind IDENTICAL case (single-source
    // guard test).
    case 'agent':
      return 'task'
    // `subagent`: legacy M5b transcripts and pi's upstream example subagent
    // extension. Mirrors permission-engine.ts's piToolKind IDENTICAL case.
    case 'subagent':
      return 'task'
    // ADR-089 S3b: the bridge's `send_message` / `task_stop` (Claude's
    // SendMessage / TaskStop rows). Mirrors permission-engine.ts's piToolKind.
    case 'send_message':
      return 'detail'
    case 'task_stop':
      return 'note'
    // The bridge's read-only `list_models`: a one-line note. Mirrors
    // permission-engine.ts's piToolKind.
    case 'list_models':
      return 'note'
    default:
      return 'unknown'
  }
}

interface PiEditEntry {
  oldText?: unknown
  newText?: unknown
}

function piNormalize(
  kind: ToolKind,
  input: Record<string, unknown> | undefined,
  result?: ToolResultBlock
): ToolView {
  const inp = input ?? {}

  switch (kind) {
    case 'command':
      return {
        kind: 'command',
        command: inp.command != null ? String(inp.command) : '',
        output: result?.toolResult
      }

    case 'fileEdit': {
      // pi's edit is always a MULTI-edit call: {path, edits: [{oldText, newText}]}.
      // A single-edit call still fits the before/after ToolView exactly as an
      // INPUT-side fallback; 2+ edits leave before/after empty (no sane single
      // pair) — but `files` below (from the RESULT's fileDiffs, when present)
      // supersedes both cases with a real per-file diff, same as
      // OpencodeEngineToolMap's identical pattern (see the file header).
      const edits = Array.isArray(inp.edits) ? (inp.edits as PiEditEntry[]) : []
      const single = edits.length === 1 ? edits[0] : undefined
      const fileDiffs = result?.fileDiffs
      return {
        kind: 'fileEdit',
        path: inp.path != null ? String(inp.path) : '',
        before: single?.oldText != null ? String(single.oldText) : '',
        after: single?.newText != null ? String(single.newText) : '',
        ...(fileDiffs && fileDiffs.length > 0 ? { files: fileDiffs } : {})
      }
    }

    case 'fileWrite':
      return {
        kind: 'fileWrite',
        path: inp.path != null ? String(inp.path) : '',
        content: inp.content != null ? String(inp.content) : ''
      }

    case 'fileRead':
      return {
        kind: 'fileRead',
        path: inp.path != null ? String(inp.path) : '',
        content: result?.toolResult ?? ''
      }

    case 'search':
      // grep/find carry `pattern`; ls has no pattern (only an optional `path`).
      return {
        kind: 'search',
        query:
          inp.pattern != null
            ? String(inp.pattern)
            : inp.path != null
              ? String(inp.path)
              : JSON.stringify(inp)
      }

    case 'plan':
      // exit_plan args: { plan } — same field name as Claude's ExitPlanMode
      // (ClaudeEngineToolMap's identical 'plan' case).
      return {
        kind: 'plan',
        plan: inp.plan != null ? String(inp.plan) : ''
      }

    case 'diagram':
      // render_mermaid args: { source, title? } — same field names as Claude/opencode.
      return {
        kind: 'diagram',
        source: inp.source != null ? String(inp.source) : '',
        title: inp.title != null ? String(inp.title) : undefined
      }

    case 'mockup':
      // create_mockup args: { html, title? } (no `directory` on input — extracted
      // from the tool RESULT text below). show_mockup args: { directory }.
      return {
        kind: 'mockup',
        directory: inp.directory != null ? String(inp.directory) : extractMockupDirectory(result),
        title: inp.title != null ? String(inp.title) : undefined
      }

    case 'task': {
      // Cross-engine dispatch (M4b) — dispatch_agent's `engine` field is the
      // discriminator, mirroring Claude/OpencodeEngineToolMap's identical
      // dispatch branch verbatim. Checked FIRST since dispatch_agent's input
      // shape never overlaps with subagent's (below).
      if (typeof inp.engine === 'string') {
        return {
          kind: 'task',
          description: `Dispatch: ${inp.engine}`,
          prompt: inp.prompt != null ? String(inp.prompt) : '',
          subagent: inp.model != null ? `${inp.engine} · ${String(inp.model)}` : String(inp.engine)
        }
      }
      // Host-run subagents (ADR-089) — the `agent` tool: { description,
      // prompt, subagent_type?, name?, model?, run_in_background? }. Keyed on the shape (prompt +
      // description, none of engine/agent/tasks): piNormalize never sees the
      // tool name. Checked BEFORE the legacy `subagent` shapes below.
      if (
        typeof inp.prompt === 'string' &&
        typeof inp.description === 'string' &&
        inp.agent === undefined &&
        inp.tasks === undefined
      ) {
        const type =
          typeof inp.subagent_type === 'string' && inp.subagent_type !== ''
            ? inp.subagent_type
            : undefined
        const name = typeof inp.name === 'string' && inp.name !== '' ? inp.name : type
        const resolvedModel =
          (result ? piAgentResultModel(result) : undefined) ||
          (typeof inp.model === 'string' && inp.model !== '' ? inp.model : undefined)
        return {
          kind: 'task',
          description: inp.description,
          prompt: inp.prompt,
          subagent: type ?? 'general-purpose',
          ...(name ? { name } : {}),
          // The model the host resolved the request to (an alias or bare id is
          // not what runs), once the result says; until then, and for a refused
          // call, what was asked for.
          ...(resolvedModel ? { model: resolvedModel } : {}),
          // Once a result exists it decides (ADR-089 S3): only the host's
          // launch acknowledgement means a background run. A call refused
          // before any spawn (validation, start failure, a deny) is settled,
          // not "running" forever, and a definition that forced background
          // reads as one on reload. Until then the input says: background is
          // the default (D2), only an explicit false is foreground.
          background: result ? isPiAsyncLaunchResult(result) : inp.run_in_background !== false
        }
      }
      // Legacy `subagent` tool (M5b transcripts; pi's upstream example).
      // Parallel form: { tasks: [{agent, task}, ...] }.
      if (Array.isArray(inp.tasks)) {
        const list = inp.tasks as Array<{ agent?: unknown; task?: unknown }>
        const names = list.map((t) => (t.agent != null ? String(t.agent) : '?'))
        return {
          kind: 'task',
          description: `Subagents: ${names.join(', ')}`,
          // One tool_use id spawns N agents here, so the row names its members
          // rather than pretending to be one agent (ADR-073 §3).
          name: names.length > 1 ? `${names.length} subagents` : names[0],
          prompt: list
            .map(
              (t) =>
                `[${t.agent != null ? String(t.agent) : '?'}] ${t.task != null ? String(t.task) : ''}`
            )
            .join('\n\n'),
          subagent: names.join(', ')
        }
      }
      // Single form: { agent, task }.
      if (typeof inp.agent === 'string') {
        return {
          kind: 'task',
          description: `Subagent: ${inp.agent}`,
          prompt: inp.task != null ? String(inp.task) : '',
          name: inp.agent,
          subagent: inp.agent
        }
      }
      // Defensive fallback (unreachable for pi today — dispatch_agent always
      // supplies `engine`, subagent always supplies `agent`/`tasks`), kept for
      // structural parity with Claude/opencode's task normalizer.
      return {
        kind: 'task',
        description: '',
        prompt: inp.prompt != null ? String(inp.prompt) : ''
      }
    }

    // send_message (ADR-089 S3b): who and the preview as fields, the message
    // itself as the text — the shape Claude's SendMessage row takes.
    case 'detail': {
      const fields: { label: string; value: string }[] = []
      if (typeof inp.to === 'string' && inp.to !== '') fields.push({ label: 'to', value: inp.to })
      if (typeof inp.summary === 'string' && inp.summary !== '') {
        fields.push({ label: 'summary', value: inp.summary })
      }
      // A refused send_message shows WHY (the host's answer); the message it
      // tried to send moves into the fields.
      if (result?.isError === true) {
        if (typeof inp.message === 'string' && inp.message !== '') {
          fields.push({ label: 'message', value: inp.message })
        }
        return { kind: 'detail', fields, text: result.toolResult }
      }
      const text = typeof inp.message === 'string' ? inp.message : result?.toolResult
      return { kind: 'detail', fields, ...(text !== undefined ? { text } : {}) }
    }

    // Both pi 'note' tools, told apart by input shape (piNormalize never sees
    // the tool name): task_stop always carries `task_id`; list_models takes at
    // most a `query`.
    case 'note': {
      // list_models: the result is a long list the model reads — the row says
      // only what was asked (a FAILED call still shows what came back, as
      // every note row does).
      if (!('task_id' in inp)) {
        const query = typeof inp.query === 'string' ? inp.query.trim() : ''
        return {
          kind: 'note',
          icon: 'search',
          text: query ? `Listed models matching "${query}"` : 'Listed the available models'
        }
      }
      // task_stop (ADR-089 S3b): the host's own answer once there is one — a
      // refusal or "not running" must not read as a stop.
      return {
        kind: 'note',
        icon: 'stop',
        text:
          result && result.toolResult
            ? result.toolResult
            : `Stopped agent ${typeof inp.task_id === 'string' ? inp.task_id : ''}`.trim()
      }
    }

    case 'mcp':
      return { kind: 'mcp', input: inp }

    case 'unknown':
    default:
      return { kind: 'unknown', input: inp }
  }
}

/** create_mockup's INPUT carries no `directory` field — extract it from the tool RESULT text ("Directory: <id>"), mirroring OpencodeEngineToolMap's identical helper (each EngineToolMap file is self-contained, no cross-imports between them, per the existing convention). */
function extractMockupDirectory(result?: ToolResultBlock): string | undefined {
  if (!result?.toolResult) return undefined
  const match = result.toolResult.match(/Directory:\s*(\S+)/)
  return match ? match[1] : undefined
}

/** Prettify pi's lowercase built-in tool names for the card header. */
const PI_DISPLAY_NAMES: Record<string, string> = {
  bash: 'Bash',
  read: 'Read',
  write: 'Write',
  edit: 'Edit',
  grep: 'Grep',
  find: 'Find',
  ls: 'Ls',
  render_mermaid: 'Mermaid',
  create_mockup: 'Mockup',
  show_mockup: 'Mockup',
  dispatch_agent: 'Dispatch',
  agent: 'Agent',
  subagent: 'Subagent',
  list_models: 'Models'
}

function piDisplayName(toolName: string): string {
  return PI_DISPLAY_NAMES[toolName] ?? toolName
}

export const PiEngineToolMap: EngineToolMap = {
  kindOf: piKindOf,
  normalize: piNormalize,
  displayName: piDisplayName,
  hidden: HIDDEN_TOOLS
}
