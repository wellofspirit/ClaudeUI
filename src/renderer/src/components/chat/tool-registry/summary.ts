/**
 * summarizeTool — engine-neutral one-line summary for a ToolCard header.
 *
 * Maps ToolKind + ToolView → a concise summary string, reproducing getSummary's
 * output exactly for every Claude kind (regression-tested). opencode now gets
 * real summaries (bash→command, todowrite→"3/5 tasks") instead of JSON blobs.
 *
 * Replaces the Claude-name-switch in getSummary(block) for the ToolCard header.
 */

import { shorten } from '../ToolCallBlock/utils'
import type { ToolKind, ToolView } from '../../../../../shared/tool-kinds'

/**
 * Claude's `SendUserFile` has no ToolKind of its own (it lands on 'unknown',
 * whose default summary is the raw input JSON). Rather than mint a kind for a
 * single Claude-only tool, special-case its summary here: the floating Files
 * widget owns the rich presentation, the card header just needs a readable line.
 */
function summarizeSendUserFile(rawInput: unknown): string {
  const input = (rawInput ?? {}) as Record<string, unknown>
  const raw = input.files
  const files = (Array.isArray(raw) ? raw : [raw]).filter(
    (f): f is string => typeof f === 'string' && f.length > 0
  )
  if (files.length === 0) return JSON.stringify(input)
  const names = files.map((f) => f.split(/[\\/]/).filter(Boolean).pop() || f)
  const head = `Sent ${files.length} file${files.length !== 1 ? 's' : ''}: ${names.join(', ')}`
  const caption = typeof input.caption === 'string' && input.caption ? ` — ${input.caption}` : ''
  return head + caption
}

export function summarizeTool(kind: ToolKind, view: ToolView, toolName?: string): string {
  if (kind === 'unknown' && view.kind === 'unknown' && toolName === 'SendUserFile') {
    return summarizeSendUserFile(view.input)
  }

  switch (kind) {
    case 'command':
      return view.kind === 'command' ? view.command : ''

    case 'fileRead':
    case 'fileWrite':
    case 'fileEdit':
      return view.kind === 'fileRead' || view.kind === 'fileWrite' || view.kind === 'fileEdit'
        ? shorten(view.path)
        : ''

    case 'search':
      return view.kind === 'search' ? view.query : ''

    case 'web':
      return view.kind === 'web' ? view.target : ''

    case 'todo': {
      if (view.kind !== 'todo') return ''
      const completed = view.items.filter((t) => t.status === 'completed').length
      const total = view.items.length
      return `${completed}/${total} tasks`
    }

    case 'task':
      return view.kind === 'task' ? view.description : ''

    case 'question': {
      if (view.kind !== 'question') return ''
      const n = view.questions.length
      return `${n} question${n !== 1 ? 's' : ''}`
    }

    case 'diagram':
      return view.kind === 'diagram' ? (view.title ?? 'diagram') : ''

    case 'mockup':
      // Minor wording drift from old getSummary's `show <dir8>` for show_mockup:
      // now always "show mockup" when no title. Acceptable per spec §2(e).
      return view.kind === 'mockup'
        ? (view.title ?? (view.directory ? 'show mockup' : 'new mockup'))
        : ''

    case 'plan':
      return ''

    case 'detail': {
      if (view.kind !== 'detail') return ''
      // The first field is the spec's own headline for the call — the skill that
      // ran, the schedule that was set, the agent a message went to.
      const first = view.fields[0]
      return first ? first.value : ''
    }

    case 'findings': {
      if (view.kind !== 'findings') return ''
      const n = view.findings.length
      const confirmed = view.findings.filter((f) => f.verdict?.toUpperCase() === 'CONFIRMED').length
      const head = `${n} finding${n === 1 ? '' : 's'}`
      return confirmed > 0 ? `${head} · ${confirmed} confirmed` : head
    }

    // A note never reaches a card header (it is lifted to its own row), but the
    // subagent view renders every kind through ToolCard, so it needs an answer.
    case 'note':
      return view.kind === 'note' ? view.text : ''

    case 'mcp':
      // `server / tool` when the engine's name was splittable (Codex's
      // `mcp__<server>__<tool>`, F20). Engines whose MCP names carry neither —
      // opencode's underscore-joined `server_tool`, and any caller that
      // normalized without a tool name — keep today's JSON dump.
      if (view.kind === 'mcp' && view.server)
        return view.tool ? `${view.server} / ${view.tool}` : view.server
      return view.kind === 'mcp' ? JSON.stringify(view.input) : ''

    case 'unknown':
    default:
      return view.kind === 'unknown' ? JSON.stringify(view.input) : ''
  }
}
