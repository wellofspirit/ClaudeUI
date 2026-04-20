import { createSdkMcpServer, tool } from '../sdk'
import { z } from 'zod'

/**
 * Creates an in-process MCP server that provides the `render_mermaid` tool.
 *
 * Validation runs via `@mermaid-js/parser` (pure Node, no DOM) so the main
 * process can check syntax without round-tripping to the renderer.
 */
export function createMermaidServer() {
  return createSdkMcpServer({
    name: 'claude-ui',
    version: '1.0.0',
    tools: [
      tool(
        'render_mermaid',
        'Render a Mermaid.js diagram as an interactive SVG in the chat UI. ' +
          'The diagram will be displayed inline in a dedicated card. ' +
          'Returns success confirmation or syntax error details for you to fix and retry.',
        {
          source: z.string().describe('Complete Mermaid diagram syntax'),
          title: z.string().optional().describe('Optional title/caption shown on the diagram card')
        },
        async ({ source, title }) => {
          const result = await validateMermaid(source)
          if (result.valid) {
            const label = title ? `"${title}"` : 'Diagram'
            return {
              content: [{ type: 'text' as const, text: `${label} rendered successfully.` }]
            }
          }
          return {
            content: [{
              type: 'text' as const,
              text: `Mermaid syntax error:\n${result.error}\n\nFix the syntax and call render_mermaid again.`
            }],
            isError: true
          }
        }
      )
    ]
  })
}

// ---------------------------------------------------------------------------
// Validation via @mermaid-js/parser (lightweight, DOM-free)
// ---------------------------------------------------------------------------

interface ValidationResult {
  valid: boolean
  error?: string
}

/** Diagram types that @mermaid-js/parser can validate (Langium-based) */
const PARSEABLE_TYPES: Record<string, string> = {
  info: 'info',
  packet: 'packet',
  'packet-beta': 'packet',
  pie: 'pie',
  architecture: 'architecture',
  'architecture-beta': 'architecture',
  gitgraph: 'gitGraph',
  'gitGraph': 'gitGraph',
  radar: 'radar',
  'radar-beta': 'radar',
  treemap: 'treemap',
  'treemap-beta': 'treemap',
  treeview: 'treeView',
  'tree-view': 'treeView',
  wardley: 'wardley',
}

/**
 * Detect the diagram type from the first non-empty, non-directive line.
 * Mermaid diagrams start with a keyword like `flowchart`, `sequenceDiagram`, `graph`, etc.
 */
function detectDiagramType(source: string): string | null {
  for (const line of source.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('%%') || trimmed.startsWith('---')) continue
    // First keyword on the line is the diagram type
    const match = trimmed.match(/^(\S+)/)
    return match ? match[1] : null
  }
  return null
}

/**
 * Validates mermaid syntax using @mermaid-js/parser where supported.
 *
 * The parser only covers a subset of diagram types (Langium-based grammars).
 * For unsupported types (flowchart, sequence, class, state, etc.), we accept
 * the source and let the renderer's full mermaid lib handle validation visually.
 */
async function validateMermaid(source: string): Promise<ValidationResult> {
  const detected = detectDiagramType(source)
  if (!detected) {
    return { valid: false, error: 'Could not detect diagram type. The source appears empty or malformed.' }
  }

  const parserType = PARSEABLE_TYPES[detected] || PARSEABLE_TYPES[detected.toLowerCase()]
  if (!parserType) {
    // Diagram type not covered by the parser — accept it, renderer will handle the rest
    return { valid: true }
  }

  try {
    const parser = await import('@mermaid-js/parser')
    await parser.parse(parserType as 'info', source)
    return { valid: true }
  } catch (err: unknown) {
    if (err && typeof err === 'object' && 'result' in err) {
      // MermaidParseError — extract diagnostics
      const parseErr = err as { result: { lexerErrors?: Array<{ message: string }>; parserErrors?: Array<{ message: string }> }; message: string }
      const messages: string[] = []
      if (parseErr.result.lexerErrors?.length) {
        messages.push(...parseErr.result.lexerErrors.map((e) => e.message))
      }
      if (parseErr.result.parserErrors?.length) {
        messages.push(...parseErr.result.parserErrors.map((e) => e.message))
      }
      return { valid: false, error: messages.length ? messages.join('\n') : parseErr.message }
    }
    const message = err instanceof Error ? err.message : String(err)
    return { valid: false, error: message }
  }
}
