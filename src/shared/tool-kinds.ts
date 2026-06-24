/**
 * Tool-kind taxonomy — the semantic classification for renderer dispatch.
 *
 * Each engine maps its tool names onto these kinds via EngineToolMap. Renderers
 * are keyed on kind, so Claude's Bash and opencode's bash both render through
 * the 'command' kind renderer. See docs/v2/06-tool-rendering.md §3.
 */

import type { ContentBlock } from './types'

type ToolResultBlock = Extract<ContentBlock, { type: 'tool_result' }>

export type ToolKind =
  | 'command' //   shell/exec     — Claude Bash · opencode bash
  | 'fileEdit' //  modify a file  — Claude Edit/MultiEdit · opencode edit/patch
  | 'fileWrite' // create a file  — Claude Write · opencode write
  | 'fileRead' //  read a file    — Claude Read · opencode read
  | 'search' //    glob/grep/list — Claude Glob/Grep · opencode glob/grep/list
  | 'web' //       fetch/search   — Claude WebFetch/WebSearch · opencode webfetch
  | 'todo' //      checklist      — Claude TodoWrite  (lifted — routes to TodoToolBlock)
  | 'task' //      subagent       — Claude Task/Agent · opencode task
  | 'plan' //      plan approval  — Claude ExitPlanMode (lifted — routes to ExitPlanModeCard)
  | 'question' //  ask-user       — Claude AskUserQuestion (lifted — routes to AskUserQuestionBlock)
  | 'diagram' //   hosted MCP     — mcp__claude-ui__render_mermaid
  | 'mockup' //    hosted MCP     — mcp__claude-ui-mockup__*
  | 'mcp' //       other MCP      — generic render
  | 'unknown' //   fallback       — anything not mapped

// ---------------------------------------------------------------------------
// Neutral view shapes per kind
// ---------------------------------------------------------------------------

export type ToolView =
  | { kind: 'command'; command: string; output?: string; exitCode?: number }
  // `before`/`after` are empty when the engine emits a multi-edit shape that has
  // no single old/new pair (e.g. Claude MultiEdit). The body falls back to the
  // generic JSON view (dumping block.toolInput) in that case — preserving today's
  // behavior where MultiEdit hit no special branch.
  | { kind: 'fileEdit'; path: string; before: string; after: string; language?: string }
  | { kind: 'fileWrite'; path: string; content: string; language?: string }
  | { kind: 'fileRead'; path: string; content: string; language?: string; truncated?: boolean }
  // search/web render through the generic body (JSON dump of block.toolInput +
  // result). The semantic fields (query/target) are kept for future coverage
  // polish (§9) but unused by the current generic renderer.
  | { kind: 'search'; query: string }
  | { kind: 'web'; target: string }
  | { kind: 'task'; description: string; prompt: string }
  | { kind: 'todo'; items: { status: string; text: string }[] }
  | { kind: 'plan'; plan: string }
  | { kind: 'question'; questions: unknown[] }
  | { kind: 'diagram'; source: string; title?: string }
  | { kind: 'mockup'; directory?: string; title?: string }
  | { kind: 'mcp'; input: unknown }
  | { kind: 'unknown'; input: unknown }

// ---------------------------------------------------------------------------
// EngineToolMap interface
// ---------------------------------------------------------------------------

/**
 * Per-engine mapping from tool names → ToolKind + neutral ToolView normalization.
 *
 * - `kindOf(toolName)`: classify a tool name. Unknown names return 'unknown'.
 * - `normalize(kind, input, result?)`: map engine-specific field names to the
 *   engine-neutral ToolView for the given kind.
 * - `hidden`: names that should be suppressed entirely (no rendering).
 */
export interface EngineToolMap {
  kindOf(toolName: string): ToolKind
  normalize(kind: ToolKind, input: Record<string, unknown> | undefined, result?: ToolResultBlock): ToolView
  hidden: ReadonlySet<string>
}

// ---------------------------------------------------------------------------
// hostedMcpKind — engine-independent MCP tool name classification
// ---------------------------------------------------------------------------

/**
 * Classify hosted-MCP tool names that ClaudeUI injects at the engine level.
 * These are engine-independent: both Claude and opencode receive the same MCP
 * tools when our plugin is loaded.
 *
 * Returns `null` for names that are not hosted-MCP tools (let the engine's
 * kindOf handle them).
 */
export function hostedMcpKind(toolName: string): ToolKind | null {
  if (toolName === 'mcp__claude-ui__render_mermaid') return 'diagram'
  if (
    toolName === 'mcp__claude-ui-mockup__create_mockup' ||
    toolName === 'mcp__claude-ui-mockup__show_mockup'
  )
    return 'mockup'
  if (toolName.startsWith('mcp__')) return 'mcp'
  return null
}
