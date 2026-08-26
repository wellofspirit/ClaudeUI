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
 * M5b: in-pi subagents — a SECOND bare-name `pi.registerTool()` registration
 * (`subagent`, from the separate pi-subagent-source.ts extension, gated on
 * CLAUDEUI_PI_SUBAGENTS) also maps to 'task', reusing TaskCard alongside
 * dispatch_agent. Disambiguated by input shape in piNormalize's 'task' case:
 * dispatch_agent always carries `engine`; subagent carries `agent`+`task`
 * (single) or `tasks: [...]` (parallel) — never `engine`.
 */

import type { EngineToolMap, ToolKind, ToolView } from '../../../../../shared/tool-kinds'
import { hostedMcpKind } from '../../../../../shared/tool-kinds'
import type { ContentBlock } from '../../../../../shared/types'

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
    // In-pi subagents (M5b) — the subagent-discovery extension's OWN
    // registered tool (pi-subagent-source.ts, gated on CLAUDEUI_PI_SUBAGENTS).
    // Reuses the SAME 'task' kind dispatch_agent does — TaskCard is
    // engine-neutral and disambiguates by input shape (see piNormalize's
    // 'task' case below). Mirrors permission-engine.ts's piToolKind IDENTICAL
    // case (single-source guard test).
    case 'subagent':
      return 'task'
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
      // In-pi subagents (M5b) — pi-subagent-source.ts's `subagent` tool.
      // Parallel form: { tasks: [{agent, task}, ...] }.
      if (Array.isArray(inp.tasks)) {
        const list = inp.tasks as Array<{ agent?: unknown; task?: unknown }>
        const names = list.map((t) => (t.agent != null ? String(t.agent) : '?'))
        return {
          kind: 'task',
          description: `Subagents: ${names.join(', ')}`,
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
  subagent: 'Subagent'
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
