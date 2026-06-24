/**
 * opencode engine tool map — maps opencode's tool names to ToolKinds and
 * normalizes their input/result shapes into the SAME engine-neutral ToolView
 * the kind bodies consume (so opencode renders through ClaudeUI's rich cards).
 *
 * See docs/v2/06-tool-rendering.md §6 for the canonical opencode→kind table.
 *
 * Hosted-tools MCP names: the in-process HTTP MCP server is named 'claudeui'.
 * opencode sanitizes tool names as `sanitize(serverName)_sanitize(toolName)`,
 * so our tools arrive prefixed: `claudeui_render_mermaid`, `claudeui_create_mockup`,
 * `claudeui_show_mockup`. hostedMcpKind (which matches `mcp__*`) does NOT catch
 * these — they have the claudeui_ prefix, not mcp__. opencode field names match
 * the MCP tool args (source/title, directory/title), so the diagram/mockup
 * normalizers are shared.
 */

import type { EngineToolMap, ToolKind, ToolView } from '../../../../../shared/tool-kinds'
import { hostedMcpKind } from '../../../../../shared/tool-kinds'
import type { AskUserQuestion, ContentBlock } from '../../../../../shared/types'

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
    case 'apply_patch':
      return 'fileEdit'
    case 'write':
      return 'fileWrite'
    case 'read':
      return 'fileRead'
    case 'glob':
    case 'grep':
      return 'search'
    case 'webfetch':
    case 'websearch':
      return 'web'
    case 'task':
      return 'task'
    case 'todowrite':
      return 'todo'
    case 'question':
      return 'question'
    case 'plan_exit':
      return 'plan'
    // Hosted-tools MCP names (claudeui_ prefixed — see file header). Their args
    // match the diagram/mockup normalizers, rendering the same engine-agnostic cards.
    case 'claudeui_render_mermaid':
      return 'diagram'
    case 'claudeui_create_mockup':
    case 'claudeui_show_mockup':
      return 'mockup'
    // skill/lsp/invalid → unknown (graceful; dedicated kinds are out of scope)
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
        prompt: inp.prompt != null ? String(inp.prompt) : '',
        subagent: inp.subagent_type != null ? String(inp.subagent_type) : undefined,
        model: inp.model != null ? String(inp.model) : undefined,
        background: inp.background != null ? Boolean(inp.background) : undefined
      }

    case 'todo': {
      const rawTodos = Array.isArray(inp.todos) ? inp.todos : []
      return {
        kind: 'todo',
        items: rawTodos.map((t: Record<string, unknown>) => ({
          status: String(t.status ?? 'pending'),
          text: String(t.content ?? '')
          // opencode todowrite has no activeForm — leave absent
        }))
      }
    }

    case 'question': {
      const rawQuestions = Array.isArray(inp.questions) ? inp.questions : []
      const questions: AskUserQuestion[] = rawQuestions.map((q: Record<string, unknown>) => ({
        question: q.question != null ? String(q.question) : '',
        header: q.header != null ? String(q.header) : '',
        options: Array.isArray(q.options)
          ? (q.options as Record<string, unknown>[]).map((o) => ({
              label: o.label != null ? String(o.label) : '',
              description: o.description != null ? String(o.description) : ''
            }))
          : [],
        // opencode uses `multiple`; AskUserQuestion uses `multiSelect` — map here
        multiSelect: !!q.multiple
      }))
      return { kind: 'question', questions }
    }

    case 'plan':
      return {
        kind: 'plan',
        plan: inp.plan != null ? String(inp.plan) : ''
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
