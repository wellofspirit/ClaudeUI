/**
 * opencode engine tool map — maps opencode's tool names to ToolKinds and
 * normalizes their input/result shapes into the SAME engine-neutral ToolView
 * the kind bodies consume (so opencode renders through ClaudeUI's rich cards).
 *
 * See docs/v2/06-tool-rendering.md §6 for the canonical opencode→kind table.
 *
 * Hosted-tools plugin names: this map classifies the BARE plugin tool names
 * (`render_mermaid` / `create_mockup` / `show_mockup`) directly to diagram/mockup
 * — the 5c event-mapper name-normalization hack (OPENCODE_TOOL_NAME_MAP) is
 * retired, so these arrive un-prefixed and hostedMcpKind (which only matches
 * `mcp__*`) won't catch them. opencode field names match the plugin's args
 * (source/title, directory/title), so the diagram/mockup normalizers are shared.
 */

import type { EngineToolMap, ToolKind, ToolView } from '../../../../../shared/tool-kinds'
import { hostedMcpKind } from '../../../../../shared/tool-kinds'
import type { ContentBlock } from '../../../../../shared/types'

type ToolResultBlock = Extract<ContentBlock, { type: 'tool_result' }>

/** opencode has no internal tools we suppress (yet). */
const HIDDEN_TOOLS: ReadonlySet<string> = new Set()

function opencodeKindOf(toolName: string): ToolKind {
  // Real MCP tools (mcp__*) resolve engine-independently first.
  const mcpKind = hostedMcpKind(toolName)
  if (mcpKind !== null) return mcpKind

  switch (toolName) {
    case 'bash':
      return 'command'
    case 'edit':
    case 'patch':
      return 'fileEdit'
    case 'write':
      return 'fileWrite'
    case 'read':
      return 'fileRead'
    case 'glob':
    case 'grep':
    case 'list':
      return 'search'
    case 'webfetch':
      return 'web'
    case 'task':
      return 'task'
    // Hosted-tools plugin names (bare — see file header). Their args match the
    // diagram/mockup normalizers, so they render the same engine-agnostic cards.
    case 'render_mermaid':
      return 'diagram'
    case 'create_mockup':
    case 'show_mockup':
      return 'mockup'
    default:
      return 'unknown'
  }
}

function opencodeNormalize(
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

    case 'fileEdit':
      // opencode edit input: { filePath, oldString, newString }. patch differs
      // (it carries a `patch` string, no old/new pair) → empty before/after, so
      // the body falls back to the generic JSON view.
      return {
        kind: 'fileEdit',
        path: inp.filePath != null ? String(inp.filePath) : '',
        before: inp.oldString != null ? String(inp.oldString) : '',
        after: inp.newString != null ? String(inp.newString) : ''
      }

    case 'fileWrite':
      // opencode write input: { filePath, content }.
      return {
        kind: 'fileWrite',
        path: inp.filePath != null ? String(inp.filePath) : '',
        content: inp.content != null ? String(inp.content) : ''
      }

    case 'fileRead':
      // opencode read input: { filePath }.
      return {
        kind: 'fileRead',
        path: inp.filePath != null ? String(inp.filePath) : '',
        content: result?.toolResult ?? ''
      }

    case 'search':
      return {
        kind: 'search',
        query: inp.pattern != null ? String(inp.pattern) : JSON.stringify(inp)
      }

    case 'web':
      return {
        kind: 'web',
        target: inp.url != null ? String(inp.url) : JSON.stringify(inp)
      }

    case 'task':
      return {
        kind: 'task',
        description: inp.description != null ? String(inp.description) : '',
        prompt: inp.prompt != null ? String(inp.prompt) : ''
      }

    case 'diagram':
      // plugin render_mermaid args: { source, title? } — same as Claude.
      return {
        kind: 'diagram',
        source: inp.source != null ? String(inp.source) : '',
        title: inp.title != null ? String(inp.title) : undefined
      }

    case 'mockup':
      // plugin create_mockup/show_mockup args: { directory? / html, title? }.
      return {
        kind: 'mockup',
        directory: inp.directory != null ? String(inp.directory) : extractMockupDirectory(result),
        title: inp.title != null ? String(inp.title) : undefined
      }

    case 'mcp':
      return { kind: 'mcp', input: inp }

    case 'unknown':
    default:
      return { kind: 'unknown', input: inp }
  }
}

function extractMockupDirectory(result?: ToolResultBlock): string | undefined {
  if (!result?.toolResult) return undefined
  const match = result.toolResult.match(/Directory:\s*(\S+)/)
  return match ? match[1] : undefined
}

export const OpencodeEngineToolMap: EngineToolMap = {
  kindOf: opencodeKindOf,
  normalize: opencodeNormalize,
  hidden: HIDDEN_TOOLS
}
