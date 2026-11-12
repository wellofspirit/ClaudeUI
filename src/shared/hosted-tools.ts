/**
 * ClaudeUI's own tools (dispatch, the session tools, diagrams, mockups, hand back):
 * the one table of which MCP server hosts each, its kind and its header label. Each
 * engine spells them differently on the wire — Claude's
 * `mcp__claude-ui-collab__dispatch_agent`, opencode's `claudeui_dispatch_agent`,
 * pi's bare `dispatch_agent` — and none of those spellings belongs in
 * a card header or the roster. The table is keyed by the bare name; each engine
 * tool map asks here with its own spelling. A name that is not ours (any other
 * `mcp__x__y`) answers `undefined` / `null`, so the engine keeps its own answer for it.
 *
 * Pure strings, no imports beyond the session tool list and types: usable from the
 * renderer and from core alike.
 */
import {
  isSessionToolName,
  SESSION_TOOL_NAMES,
  SESSION_TOOLS_SERVER_NAME
} from './session-tools-description'
import type { ToolKind, ToolView } from './tool-kinds'
import type { ContentBlock } from './types'

type ToolResultBlock = Extract<ContentBlock, { type: 'tool_result' }>

const OPENCODE_PREFIX = 'claudeui_'

/** The product label for a cross-engine dispatch (matches the orange X engine tile). */
export const DISPATCH_LABEL = 'X-Agent'

interface HostedTool {
  /** The MCP server Claude names it under: `mcp__<claudeServer>__<name>`. */
  claudeServer: string
  /**
   * The kind on every engine; absent: no kind of its own. The permission ladder reads
   * this answer (`decideWithSource` in `src/core/pi/permission-engine.ts`), so a kind
   * change is a permission change, pinned by `tool-kind-matrix.test.ts`.
   */
  kind?: ToolKind
  /** The header label. A session tool's is derived from its name. */
  label?: string
}

const HOSTED_TOOLS: Readonly<Record<string, HostedTool>> = {
  render_mermaid: { claudeServer: 'claude-ui', kind: 'diagram', label: 'Diagram' },
  create_mockup: { claudeServer: 'claude-ui-mockup', kind: 'mockup', label: 'Mockup' },
  show_mockup: { claudeServer: 'claude-ui-mockup', kind: 'mockup', label: 'Mockup' },
  // Cross-engine dispatch (ADR-033) is on its own server, not the auto-allowed `claude-ui`
  // one, so Claude gates it like any tool (collab-tool.ts). The 'task' kind gives it TaskCard.
  dispatch_agent: { claudeServer: 'claude-ui-collab', kind: 'task', label: DISPATCH_LABEL },
  // A dispatch target's report (ADR-105 §3), as Claude Code's own `SubagentHandback` is shown.
  hand_back: { claudeServer: 'claude-ui-handback', label: 'Hand back' },
  ...Object.fromEntries(
    SESSION_TOOL_NAMES.map((name): [string, HostedTool] => [
      name,
      { claudeServer: SESSION_TOOLS_SERVER_NAME, kind: 'mcp' }
    ])
  )
}

/** Every hosted tool's bare name. */
export const HOSTED_TOOL_NAMES: readonly string[] = Object.keys(HOSTED_TOOLS)

function hostedRow(bareName: string): HostedTool | undefined {
  return Object.hasOwn(HOSTED_TOOLS, bareName) ? HOSTED_TOOLS[bareName] : undefined
}

/** How an engine spells a first-party tool: Claude's MCP name, opencode's `claudeui_`, or bare (pi). */
export type FirstPartyToolSpelling = 'mcp' | 'claudeui_' | 'bare'

/** The label of a BARE first-party tool name, or undefined for any other name. */
export function firstPartyToolLabel(bareName: string): string | undefined {
  if (isSessionToolName(bareName)) {
    return `Session · ${bareName.slice('session_'.length).replace(/_/g, ' ')}`
  }
  return hostedRow(bareName)?.label
}

/**
 * The bare tool name when `toolName` is one of ClaudeUI's own tools in the engine's
 * spelling, else null. `mcp` is exactly `mcp__<its server>__<tool>`.
 */
export function hostedToolName(toolName: string, spelling: FirstPartyToolSpelling): string | null {
  if (spelling === 'bare') return hostedRow(toolName) ? toolName : null
  if (spelling === 'claudeui_') {
    if (!toolName.startsWith(OPENCODE_PREFIX)) return null
    const bare = toolName.slice(OPENCODE_PREFIX.length)
    return hostedRow(bare) ? bare : null
  }
  const [prefix, server, tool, ...rest] = toolName.split('__')
  if (prefix !== 'mcp' || !server || !tool || rest.length > 0) return null
  return hostedRow(tool)?.claudeServer === server ? tool : null
}

/** The kind of one of ClaudeUI's own tools in the engine's spelling; null when not ours or it has none. */
export function hostedToolKind(
  toolName: string,
  spelling: FirstPartyToolSpelling
): ToolKind | null {
  const bare = hostedToolName(toolName, spelling)
  return (bare === null ? undefined : hostedRow(bare)?.kind) ?? null
}

/**
 * The display name of `toolName` when it is one of ClaudeUI's own tools in the
 * engine's spelling, else undefined (the caller keeps its own display).
 */
export function firstPartyDisplayName(
  toolName: string,
  spelling: FirstPartyToolSpelling
): string | undefined {
  const bare = hostedToolName(toolName, spelling)
  return bare === null ? undefined : firstPartyToolLabel(bare)
}

/** create_mockup's INPUT carries no `directory` field — extract it from the tool RESULT text ("Directory: <id>"). */
function extractMockupDirectory(result?: ToolResultBlock): string | undefined {
  if (!result?.toolResult) return undefined
  const match = result.toolResult.match(/Directory:\s*(\S+)/)
  return match ? match[1] : undefined
}

/**
 * The `diagram` and `mockup` views, the same on every engine (their args match:
 * `{ source, title? }`, `{ directory? | html, title? }`); null for any other kind.
 */
export function hostedToolView(
  kind: ToolKind,
  input: Record<string, unknown>,
  result?: ToolResultBlock
): ToolView | null {
  if (kind === 'diagram') {
    return {
      kind: 'diagram',
      source: input.source != null ? String(input.source) : '',
      title: input.title != null ? String(input.title) : undefined
    }
  }
  if (kind === 'mockup') {
    return {
      kind: 'mockup',
      directory: input.directory != null ? String(input.directory) : extractMockupDirectory(result),
      title: input.title != null ? String(input.title) : undefined
    }
  }
  return null
}
