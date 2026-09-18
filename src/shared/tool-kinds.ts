/**
 * Tool-kind taxonomy — the semantic classification for renderer dispatch.
 *
 * Each engine maps its tool names onto these kinds via EngineToolMap. Renderers
 * are keyed on kind, so Claude's Bash and opencode's bash both render through
 * the 'command' kind renderer. The per-engine name→kind tables live in
 * renderer/src/components/chat/tool-registry/{Claude,Opencode}EngineToolMap.ts.
 */

import type { AskUserQuestion, ContentBlock, FileDiff } from './types'

type ToolResultBlock = Extract<ContentBlock, { type: 'tool_result' }>

export type ToolKind =
  | 'command' //   shell/exec     — Claude Bash · opencode bash
  | 'fileEdit' //  modify a file  — Claude Edit/MultiEdit · opencode edit/patch
  | 'fileWrite' // create a file  — Claude Write · opencode write
  | 'fileRead' //  read a file    — Claude Read · opencode read
  | 'search' //    glob/grep/list — Claude Glob/Grep · opencode glob/grep/list
  | 'web' //       fetch/search   — Claude WebFetch/WebSearch · opencode webfetch
  | 'image' //     picture made   — Codex imageGeneration
  | 'sleep' //     timed wait     — Codex sleep  (lifted — routes to SleepRow)
  | 'todo' //      checklist      — Claude TodoWrite  (lifted — routes to TodoToolBlock)
  | 'task' //      subagent       — Claude Task/Agent · opencode task
  | 'plan' //      plan approval  — Claude ExitPlanMode (lifted — routes to ExitPlanModeCard)
  | 'question' //  ask-user       — Claude AskUserQuestion (lifted — routes to AskUserQuestionBlock)
  | 'diagram' //   hosted MCP     — mcp__claude-ui__render_mermaid
  | 'mockup' //    hosted MCP     — mcp__claude-ui-mockup__*
  | 'mcp' //       other MCP      — generic render
  | 'detail' //    a field list   — Claude Skill/Cron*/worktree/… (see claude-tool-specs)
  | 'findings' //  review rows    — Claude ReportFindings
  | 'note' //      one-line row   — Claude ToolSearch/TaskStop/… (lifted — routes to ToolNoteRow)
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
  // `files` is set when the engine's tool result carries real per-file unified
  // diffs (opencode apply_patch/edit — see FileDiff). When present, the body
  // renders one diff card per file instead of the single before/after pair.
  | {
      kind: 'fileEdit'
      path: string
      before: string
      after: string
      language?: string
      files?: FileDiff[]
    }
  | { kind: 'fileWrite'; path: string; content: string; language?: string }
  | { kind: 'fileRead'; path: string; content: string; language?: string; truncated?: boolean }
  // search/web render through the generic body (JSON dump of block.toolInput +
  // result). The semantic fields (query/target) are kept for future coverage
  // polish (§9) but unused by the current generic renderer.
  | { kind: 'search'; query: string }
  // `action` and `results` are present only when the engine's wire carries them
  // (Codex `webSearch.action`/`results`, Claude's `Links:` trailer). The body
  // falls back to the result text when they are absent, so an engine that
  // reports neither renders exactly as it did before.
  | {
      kind: 'web'
      target: string
      action?: 'search' | 'fetch' | 'find' | 'other'
      results?: { title: string; url: string; snippet?: string }[]
    }
  | {
      kind: 'task'
      description: string
      prompt: string
      subagent?: string
      model?: string
      background?: boolean
    }
  | { kind: 'todo'; items: { status: string; text: string; activeForm?: string }[] }
  | { kind: 'plan'; plan: string }
  | { kind: 'question'; questions: AskUserQuestion[] }
  | { kind: 'diagram'; source: string; title?: string }
  | { kind: 'mockup'; directory?: string; title?: string }
  // `server`/`tool` are the two halves of `mcp__<server>__<tool>`; `readOnly`
  // is the server's own `readOnlyHint`. All three are optional: an engine whose
  // MCP names are not splittable (opencode's `server_tool`) supplies none.
  | { kind: 'mcp'; input: unknown; server?: string; tool?: string; readOnly?: boolean }
  | { kind: 'image'; prompt?: string; savedPath?: string }
  /**
   * A tool whose call is a handful of named facts — a schedule, a worktree, a
   * wake-up, a message and its recipient. `fields` is what the call SAID (its
   * input, named and ordered by the engine's spec); `text` is what came back,
   * rendered as output rather than as another field.
   */
  | {
      kind: 'detail'
      fields: { label: string; value: string }[]
      /** Rendered through the output view when the result is worth showing whole. */
      text?: string
    }
  /**
   * Structured review findings — Claude's `ReportFindings`, and any engine that
   * later reports a review the same way. `verdict` and `severity` are optional
   * because a harness may report neither.
   */
  | {
      kind: 'findings'
      findings: {
        file?: string
        line?: number
        summary: string
        detail?: string
        category?: string
        verdict?: string
        outcome?: string
      }[]
      level?: string
    }
  /**
   * A call whose whole meaning is one sentence. Rendered as a row, not a card:
   * a header, a chevron and an empty body would be chrome around nothing.
   */
  | { kind: 'note'; icon?: string; text: string }
  | { kind: 'sleep'; durationMs: number }
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
 * - `displayName(toolName)`: human-readable display name for the card header.
 *   For Claude this is a passthrough (names are already display-ready). For
 *   opencode this prettifies lowercase/underscore names (bash→Bash, etc.).
 * - `hidden`: names that should be suppressed entirely (no rendering).
 */
export interface EngineToolMap {
  kindOf(toolName: string): ToolKind
  /**
   * `toolName` is OPTIONAL and every engine but Codex ignores it: the MCP body
   * needs the server and tool, and `mcp__<server>__<tool>` is the only place
   * they exist. Callers that do not have the name (a synthetic view) may omit
   * it and get today's answer.
   */
  normalize(
    kind: ToolKind,
    input: Record<string, unknown> | undefined,
    result?: ToolResultBlock,
    toolName?: string
  ): ToolView
  displayName(toolName: string): string
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
  // Cross-engine dispatch (ADR-033 M3) — Claude's dispatch_agent lives on its
  // own 'claude-ui-collab' MCP server (collab-tool.ts, deliberately NOT the
  // auto-allowed 'claude-ui' prefix). Reuses TaskCard via the 'task' kind so
  // dispatched work gets the same live-streaming/progress/stop UX as a native
  // subagent. Checked BEFORE the generic 'mcp__' fallback below.
  if (toolName === 'mcp__claude-ui-collab__dispatch_agent') return 'task'
  if (toolName.startsWith('mcp__')) return 'mcp'
  return null
}
