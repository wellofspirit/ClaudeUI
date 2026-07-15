/**
 * Claude engine tool map — maps Claude's tool names to ToolKinds and normalizes
 * their input/result shapes into engine-neutral ToolView objects.
 *
 * See docs/v2/06-tool-rendering.md §6 for the canonical Claude→kind table.
 */

import type { EngineToolMap, ToolKind, ToolView } from '../../../../../shared/tool-kinds'
import { hostedMcpKind } from '../../../../../shared/tool-kinds'
import { isAgentTool } from '../../../../../shared/types'
import type { AskUserQuestion, ContentBlock } from '../../../../../shared/types'

type ToolResultBlock = Extract<ContentBlock, { type: 'tool_result' }>

/**
 * Tools Claude emits internally that should be suppressed in the renderer.
 * Mirrors MessageBubble's HIDDEN_TOOLS set.
 */
const HIDDEN_TOOLS: ReadonlySet<string> = new Set([
  'EnterPlanMode',
  'TaskCreate',
  'TaskUpdate',
  'TaskList',
  'TaskGet'
])

function claudeKindOf(toolName: string): ToolKind {
  // Check hosted MCP first (engine-independent)
  const mcpKind = hostedMcpKind(toolName)
  if (mcpKind !== null) return mcpKind

  switch (toolName) {
    case 'Bash':
      return 'command'
    case 'Edit':
    case 'MultiEdit':
      return 'fileEdit'
    case 'Write':
      return 'fileWrite'
    case 'Read':
      return 'fileRead'
    case 'Glob':
    case 'Grep':
      return 'search'
    case 'WebFetch':
    case 'WebSearch':
      return 'web'
    case 'ExitPlanMode':
      return 'plan'
    case 'AskUserQuestion':
      return 'question'
    case 'TodoWrite':
      return 'todo'
    default:
      if (isAgentTool(toolName)) return 'task'
      return 'unknown'
  }
}

function claudeNormalize(
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
      return {
        kind: 'fileEdit',
        path: inp.file_path != null ? String(inp.file_path) : '',
        before: inp.old_string != null ? String(inp.old_string) : '',
        after: inp.new_string != null ? String(inp.new_string) : ''
      }

    case 'fileWrite':
      return {
        kind: 'fileWrite',
        path: inp.file_path != null ? String(inp.file_path) : '',
        content: inp.content != null ? String(inp.content) : ''
      }

    case 'fileRead':
      return {
        kind: 'fileRead',
        path: inp.file_path != null ? String(inp.file_path) : '',
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
        target: inp.url != null ? String(inp.url) : inp.query != null ? String(inp.query) : JSON.stringify(inp)
      }

    case 'task': {
      // Cross-engine dispatch (ADR-033 M3) shares the 'task' kind (via
      // hostedMcpKind's mcp__claude-ui-collab__dispatch_agent mapping) but has
      // a DIFFERENT input shape than Claude's native Task tool:
      // { engine, prompt, model?, session_id? } — no description/subagent_type.
      // `engine` is the reliable discriminator (native Task never has it).
      // The badge slot (TaskCard's `subagent`) carries "<engine> · <model>"
      // instead of extending ToolView with dispatch-specific fields.
      if (typeof inp.engine === 'string') {
        return {
          kind: 'task',
          description: `Dispatch: ${inp.engine}`,
          prompt: inp.prompt != null ? String(inp.prompt) : '',
          subagent: inp.model != null ? `${inp.engine} · ${String(inp.model)}` : String(inp.engine)
        }
      }
      return {
        kind: 'task',
        description: inp.description != null ? String(inp.description) : '',
        prompt: inp.prompt != null ? String(inp.prompt) : '',
        // Claude uses snake_case subagent_type; fall back to camelCase for older transcripts
        subagent: inp.subagent_type != null
          ? String(inp.subagent_type)
          : inp.subagentType != null
            ? String(inp.subagentType)
            : undefined,
        model: inp.model != null ? String(inp.model) : undefined,
        background: inp.run_in_background != null ? Boolean(inp.run_in_background) : undefined
      }
    }

    case 'todo': {
      const rawTodos = Array.isArray(inp.todos) ? inp.todos : []
      return {
        kind: 'todo',
        items: rawTodos.map((t: Record<string, unknown>) => ({
          status: String(t.status ?? 'pending'),
          text: String(t.content ?? ''),
          activeForm: t.activeForm != null ? String(t.activeForm) : undefined
        }))
      }
    }

    case 'plan':
      return {
        kind: 'plan',
        plan: inp.plan != null ? String(inp.plan) : ''
      }

    case 'question': {
      // Claude's AskUserQuestion already uses `multiSelect` — pass through typed
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
        multiSelect: !!q.multiSelect
      }))
      return { kind: 'question', questions }
    }

    case 'diagram':
      return {
        kind: 'diagram',
        source: inp.source != null ? String(inp.source) : '',
        title: inp.title != null ? String(inp.title) : undefined
      }

    case 'mockup':
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

/**
 * Claude's tool names are already display-ready — passthrough.
 * For hosted MCP tools (mcp__*) and agent tools (Agent/Task/…), return as-is.
 * This must be byte-identical to the old `block.toolName` header for every Claude tool.
 */
function claudeDisplayName(toolName: string): string {
  return toolName
}

export const ClaudeEngineToolMap: EngineToolMap = {
  kindOf: claudeKindOf,
  normalize: claudeNormalize,
  displayName: claudeDisplayName,
  hidden: HIDDEN_TOOLS
}
