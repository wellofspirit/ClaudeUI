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
 * M2: rich diff — pi's `edit` tool result carries a ready-made unified diff at
 * `details.patch`, but (unlike opencode's apply_patch/edit) it carries no file
 * path of its own — the live event-mapper (src/main/pi/event-mapper.ts) and the
 * stored-history converter (src/main/services/pi-session-list.ts) both defer
 * wiring `ToolResultBlock.fileDiffs` for this reason (see their identical
 * notes). Until then, fileEdit falls back to the single-pair before/after view
 * when the call has exactly one edit (the common case), or the generic JSON
 * view for a true multi-edit call.
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
    // Hosted tools (M4a+b) — pi.registerTool() uses BARE names (see file
    // header). Mirrors permission-engine.ts's piToolKind IDENTICAL cases.
    case 'render_mermaid':
      return 'diagram'
    case 'create_mockup':
    case 'show_mockup':
      return 'mockup'
    case 'dispatch_agent':
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
      // A single-edit call still fits the before/after ToolView exactly; 2+
      // edits fall back to the generic JSON view (before/after left empty) —
      // see the file header for the M2 rich-diff plan.
      const edits = Array.isArray(inp.edits) ? (inp.edits as PiEditEntry[]) : []
      const single = edits.length === 1 ? edits[0] : undefined
      return {
        kind: 'fileEdit',
        path: inp.path != null ? String(inp.path) : '',
        before: single?.oldText != null ? String(single.oldText) : '',
        after: single?.newText != null ? String(single.newText) : ''
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
      // Cross-engine dispatch (M4b) — dispatch_agent is the ONLY producer of
      // 'task' kind for pi (no native subagent-spawning tool of its own to
      // disambiguate from, unlike Claude's Task/opencode's task). `engine` is
      // the discriminator, mirroring Claude/OpencodeEngineToolMap's identical
      // dispatch branch verbatim.
      if (typeof inp.engine === 'string') {
        return {
          kind: 'task',
          description: `Dispatch: ${inp.engine}`,
          prompt: inp.prompt != null ? String(inp.prompt) : '',
          subagent: inp.model != null ? `${inp.engine} · ${String(inp.model)}` : String(inp.engine)
        }
      }
      // Defensive fallback (unreachable for pi today — dispatch_agent always
      // supplies `engine`), kept for structural parity with Claude/opencode's
      // task normalizer.
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
  dispatch_agent: 'Dispatch'
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
