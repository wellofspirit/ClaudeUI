/**
 * Display names for ClaudeUI's own tools (dispatch, the session tools, diagrams,
 * mockups). Each engine spells them differently on the wire — Claude's
 * `mcp__claude-ui-collab__dispatch_agent`, opencode's `claudeui_dispatch_agent`,
 * pi's and Codex's bare `dispatch_agent` — and none of those spellings belongs in
 * a card header or the roster. The table is keyed by the bare name; each engine
 * tool map strips its own prefix and asks here. A name that is not ours (any other
 * `mcp__x__y`) answers `undefined`, so the engine keeps its own display for it.
 *
 * Pure strings, no imports beyond the session tool list: usable from the renderer
 * and from core alike.
 */
import { isSessionToolName, SESSION_TOOLS_SERVER_NAME } from './session-tools-description'

const OPENCODE_PREFIX = 'claudeui_'

/** The product label for a cross-engine dispatch (matches the orange X engine tile). */
export const DISPATCH_LABEL = 'X-Agent'

const FIXED_LABELS: Readonly<Record<string, string>> = {
  dispatch_agent: DISPATCH_LABEL,
  render_mermaid: 'Diagram',
  create_mockup: 'Mockup',
  show_mockup: 'Mockup',
  // A dispatch target's report (ADR-105 §3), as Claude Code's own `SubagentHandback` is shown.
  hand_back: 'Hand back'
}

/**
 * The first-party MCP servers Claude names them under, and the tools each one
 * hosts. A tool on the wrong server (`mcp__claude-ui__dispatch_agent`) is not ours.
 */
const FIRST_PARTY_MCP_SERVERS: Readonly<Record<string, (tool: string) => boolean>> = {
  'claude-ui-collab': (tool) => tool === 'dispatch_agent',
  [SESSION_TOOLS_SERVER_NAME]: isSessionToolName,
  'claude-ui': (tool) => tool === 'render_mermaid',
  'claude-ui-mockup': (tool) => tool === 'create_mockup' || tool === 'show_mockup',
  'claude-ui-handback': (tool) => tool === 'hand_back'
}

/** How an engine spells a first-party tool: Claude's MCP name, opencode's `claudeui_`, or bare (pi, Codex). */
export type FirstPartyToolSpelling = 'mcp' | 'claudeui_' | 'bare'

/** The label of a BARE first-party tool name, or undefined for any other name. */
export function firstPartyToolLabel(bareName: string): string | undefined {
  if (isSessionToolName(bareName)) {
    return `Session · ${bareName.slice('session_'.length).replace(/_/g, ' ')}`
  }
  return Object.hasOwn(FIXED_LABELS, bareName) ? FIXED_LABELS[bareName] : undefined
}

/** `mcp__<first-party server>__<its tool>` → the bare tool name; null for anything else. */
function bareNameFromMcp(toolName: string): string | null {
  const [prefix, server, tool, ...rest] = toolName.split('__')
  if (prefix !== 'mcp' || !server || !tool || rest.length > 0) return null
  const owns = Object.hasOwn(FIRST_PARTY_MCP_SERVERS, server)
    ? FIRST_PARTY_MCP_SERVERS[server]
    : undefined
  return owns?.(tool) ? tool : null
}

/**
 * The display name of `toolName` when it is one of ClaudeUI's own tools in the
 * engine's spelling, else undefined (the caller keeps its own display).
 */
export function firstPartyDisplayName(
  toolName: string,
  spelling: FirstPartyToolSpelling
): string | undefined {
  let bare: string | null
  if (spelling === 'mcp') bare = bareNameFromMcp(toolName)
  else if (spelling === 'claudeui_')
    bare = toolName.startsWith(OPENCODE_PREFIX) ? toolName.slice(OPENCODE_PREFIX.length) : null
  else bare = toolName
  return bare === null ? undefined : firstPartyToolLabel(bare)
}
