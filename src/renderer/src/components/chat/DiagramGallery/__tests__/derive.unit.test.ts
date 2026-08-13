/**
 * Layer 1: diagram gallery derivation.
 *
 * The whole point of deriving from messages rather than from mounted cards is that
 * the answer must not depend on the renderer, so this is where the interesting
 * rules live: transcript order, per-engine tool names, and what is deliberately
 * NOT dropped.
 */

import { describe, it, expect } from 'vitest'
import { deriveDiagrams } from '../derive'
import { ClaudeEngineToolMap } from '../../tool-registry/ClaudeEngineToolMap'
import { OpencodeEngineToolMap } from '../../tool-registry/OpencodeEngineToolMap'
import { PiEngineToolMap } from '../../tool-registry/PiEngineToolMap'
import type { ChatMessage, ContentBlock } from '../../../../../../shared/types'

function diagramCall(toolUseId: string, toolName: string, source: string, title?: string): ContentBlock {
  return { type: 'tool_use', toolUseId, toolName, toolInput: { source, ...(title ? { title } : {}) } }
}

function assistant(id: string, content: ContentBlock[]): ChatMessage {
  return { id, role: 'assistant', content, timestamp: 1 }
}

describe('deriveDiagrams', () => {
  it('collects diagram tool calls in transcript order, with their titles', () => {
    const diagrams = deriveDiagrams(
      [
        assistant('a1', [
          diagramCall('tu-1', 'mcp__claude-ui__render_mermaid', 'graph TD; A-->B', 'First')
        ]),
        assistant('a2', [
          { type: 'text', text: 'and another' },
          diagramCall('tu-2', 'mcp__claude-ui__render_mermaid', 'sequenceDiagram', 'Second'),
          diagramCall('tu-3', 'mcp__claude-ui__render_mermaid', 'pie title P')
        ])
      ],
      ClaudeEngineToolMap
    )

    expect(diagrams).toEqual([
      { toolUseId: 'tu-1', source: 'graph TD; A-->B', title: 'First' },
      { toolUseId: 'tu-2', source: 'sequenceDiagram', title: 'Second' },
      { toolUseId: 'tu-3', source: 'pie title P', title: undefined }
    ])
  })

  it('matches each engine map’s own diagram tool name', () => {
    // Three different names for the same hosted tool — the reason classification
    // goes through the engine map instead of a name list in derive.ts.
    const messages = (toolName: string): ChatMessage[] => [
      assistant('a1', [diagramCall('tu-1', toolName, 'graph TD; A-->B')])
    ]

    expect(deriveDiagrams(messages('mcp__claude-ui__render_mermaid'), ClaudeEngineToolMap)).toHaveLength(1)
    expect(deriveDiagrams(messages('claudeui_render_mermaid'), OpencodeEngineToolMap)).toHaveLength(1)
    expect(deriveDiagrams(messages('render_mermaid'), PiEngineToolMap)).toHaveLength(1)

    // …and a name belonging to another engine is not silently accepted.
    expect(deriveDiagrams(messages('claudeui_render_mermaid'), PiEngineToolMap)).toEqual([])
  })

  it('keeps a diagram whose tool_result reported an error', () => {
    // Engine-side validation and the renderer's mermaid build do not always agree;
    // a source that genuinely will not render is dropped at RENDER time instead.
    const diagrams = deriveDiagrams(
      [
        assistant('a1', [
          diagramCall('tu-1', 'mcp__claude-ui__render_mermaid', 'graph TD; A-->B'),
          { type: 'tool_result', toolUseId: 'tu-1', toolResult: 'invalid syntax', isError: true }
        ])
      ],
      ClaudeEngineToolMap
    )
    expect(diagrams.map((d) => d.toolUseId)).toEqual(['tu-1'])
  })

  it('excludes non-diagram tools, other block types, and empty sources', () => {
    const diagrams = deriveDiagrams(
      [
        assistant('a1', [
          { type: 'tool_use', toolUseId: 'tu-1', toolName: 'Bash', toolInput: { command: 'ls' } },
          { type: 'tool_use', toolUseId: 'tu-2', toolName: 'Read', toolInput: { file_path: '/a' } },
          {
            type: 'tool_use',
            toolUseId: 'tu-3',
            toolName: 'mcp__claude-ui-mockup__create_mockup',
            toolInput: { html: '<p/>' }
          },
          // A diagram call with no source at all — nothing to render, so nothing
          // to page to.
          { type: 'tool_use', toolUseId: 'tu-4', toolName: 'mcp__claude-ui__render_mermaid', toolInput: {} },
          { type: 'text', text: 'hello' },
          { type: 'thinking', text: 'hmm' }
        ]),
        { id: 'u1', role: 'user', content: [{ type: 'text', text: 'draw it' }], timestamp: 2 }
      ],
      ClaudeEngineToolMap
    )
    expect(diagrams).toEqual([])
  })
})
