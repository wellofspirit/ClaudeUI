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
 */

import type { EngineToolMap, ToolKind, ToolView } from '../../../../../shared/tool-kinds'
import { hostedMcpKind } from '../../../../../shared/tool-kinds'
import type { ContentBlock } from '../../../../../shared/types'

type ToolResultBlock = Extract<ContentBlock, { type: 'tool_result' }>

/** pi has no internal tools to suppress in M1 (mirrors opencode's empty set). */
const HIDDEN_TOOLS: ReadonlySet<string> = new Set()

function piKindOf(toolName: string): ToolKind {
  // Hosted-tools MCP names resolve engine-independently first (M4 — pi doesn't
  // host them yet, but checking here mirrors Claude/opencode's precedent so
  // this map needs no changes once the M4 bridge lands).
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

    case 'mcp':
      return { kind: 'mcp', input: inp }

    case 'unknown':
    default:
      return { kind: 'unknown', input: inp }
  }
}

/** Prettify pi's lowercase built-in tool names for the card header. */
const PI_DISPLAY_NAMES: Record<string, string> = {
  bash: 'Bash',
  read: 'Read',
  write: 'Write',
  edit: 'Edit',
  grep: 'Grep',
  find: 'Find',
  ls: 'Ls'
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
