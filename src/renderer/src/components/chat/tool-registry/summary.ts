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

export function summarizeTool(kind: ToolKind, view: ToolView): string {
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
      return view.kind === 'mockup' ? (view.title ?? (view.directory ? 'show mockup' : 'new mockup')) : ''

    case 'plan':
      return ''

    case 'mcp':
    case 'unknown':
    default:
      return view.kind === 'mcp' || view.kind === 'unknown' ? JSON.stringify(view.input) : ''
  }
}
