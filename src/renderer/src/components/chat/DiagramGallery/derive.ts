/**
 * Diagram gallery derivation — turns a `ChatMessage[]` into the ordered list of
 * mermaid diagrams the full-screen viewer pages through.
 *
 * Same posture as `shared/ImageViewer/gallery.ts`: the gallery is derived from the
 * **messages**, not from the diagram cards that happen to be mounted. A card deep
 * in a collapsed tool group, or one scrolled far out of the virtualized window,
 * still has to be reachable by paging.
 *
 * Classification goes through the canonical two-step every other renderer uses —
 * `hostedMcpKind(name) ?? toolMap.kindOf(name)`, then `toolMap.normalize(...)` —
 * so the three engines' different tool names (`mcp__claude-ui__render_mermaid`,
 * `claudeui_render_mermaid`, `render_mermaid`) are matched by their own maps
 * rather than by a duplicated name list in here.
 */

import type { ChatMessage, ContentBlock } from '../../../../../shared/types'
import type { EngineToolMap } from '../../../../../shared/tool-kinds'
import { hostedMcpKind } from '../../../../../shared/tool-kinds'

type ToolResultBlock = Extract<ContentBlock, { type: 'tool_result' }>

/** One diagram in the gallery, in transcript order. */
export interface DiagramDescriptor {
  /** The tool call that produced it — what a card passes to `openDiagram`. */
  toolUseId: string
  /** Mermaid source, as the engine received it. */
  source: string
  /** Tool-call title, shown as the entry's name in the viewer. */
  title?: string
}

export function deriveDiagrams(
  messages: ChatMessage[],
  toolMap: EngineToolMap
): DiagramDescriptor[] {
  const diagrams: DiagramDescriptor[] = []

  for (const message of messages) {
    // The tool_result is passed to `normalize` because that is the canonical
    // signature; the diagram normalizers happen to ignore it today.
    let results: Map<string, ToolResultBlock> | null = null

    for (const block of message.content) {
      if (block.type !== 'tool_use' || !block.toolName) continue
      const kind = hostedMcpKind(block.toolName) ?? toolMap.kindOf(block.toolName)
      if (kind !== 'diagram') continue

      if (results === null) {
        results = new Map()
        for (const b of message.content) {
          if (b.type === 'tool_result') results.set(b.toolUseId, b)
        }
      }

      const view = toolMap.normalize(kind, block.toolInput, results.get(block.toolUseId))
      // A diagram whose validation failed engine-side (`result.isError`) is
      // deliberately KEPT: the engine's validator and the renderer's mermaid build
      // do not always agree, and the card that shows it renders fine. Sources that
      // genuinely do not render are dropped later, at render time, where the
      // failure is a fact rather than a guess.
      if (view.kind !== 'diagram' || !view.source || !block.toolUseId) continue
      diagrams.push({ toolUseId: block.toolUseId, source: view.source, title: view.title })
    }
  }

  return diagrams
}
