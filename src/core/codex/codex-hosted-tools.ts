/**
 * ClaudeUI's own hosted UI tools, carried over Codex's DYNAMIC TOOL channel.
 *
 * Codex has no MCP-client seam we may drive from here, but `thread/start` takes
 * `dynamicTools` (`app-server-protocol/src/protocol/v2/thread.rs`, behind the
 * `experimentalApi` capability the session already negotiates) and calls them
 * back as the `item/tool/call` SERVER REQUEST
 * (`DynamicToolCallParams {threadId, turnId, callId, namespace, tool,
 * arguments}`) whose response is `{contentItems, success}`
 * (`app-server/src/dynamic_tools.rs` `decode_response`). That is the whole
 * transport: no extension, no loopback HTTP, no bridge process.
 *
 * The three tools are the SAME three pi registers by bare name
 * (pi-bridge-source.ts) and Claude/opencode expose over MCP, delegating to the
 * SAME in-process handlers (mermaid-tool.ts / mockup-tool.ts) — the field names
 * are identical on purpose so the shared renderer kind bodies render a Codex
 * call exactly like a pi or Claude one. `dispatch_agent` is deliberately absent:
 * cross-engine dispatch from Codex is its own slice, and `crossEngineDispatch`
 * is still false for this engine.
 *
 * Pure by design — no session import, no module state beyond the memoized
 * mermaid server (which has none of its own).
 */
import type { DynamicToolSpec } from './protocol/v2/DynamicToolSpec'
import type { ToolResultContent } from '../sdk/types'
import { createMermaidServer } from '../services/mermaid-tool'
import { createMockupServer } from '../services/mockup-tool'

/**
 * Every tool name this module will execute. `CodexSession` refuses an
 * `item/tool/call` for anything outside this set BEFORE dispatching, so the set
 * is the security boundary, not just a lookup table.
 */
export const CODEX_HOSTED_TOOL_NAMES: ReadonlySet<string> = new Set([
  'render_mermaid',
  'create_mockup',
  'show_mockup'
])

/**
 * The `dynamicTools` param for `thread/start`, in the CANONICAL tagged form
 * (`{type:'function', ...}`). The legacy untagged form still deserializes
 * (`protocol/src/dynamic_tools.rs` `normalize_dynamic_tool_specs`), but mixing
 * the two in one list is a hard error there, so this stays tagged throughout.
 *
 * Names must match `^[a-zA-Z0-9_-]+$` and must not start with `mcp`
 * (`validate_dynamic_tools`, app-server/src/request_processors/
 * thread_processor.rs) — these three do. `deferLoading` is NOT set: it requires
 * a namespace, and a namespace would change the wire tool name the model sees
 * and the `namespace` field on every call.
 */
export function codexDynamicToolSpecs(): DynamicToolSpec[] {
  return [
    {
      type: 'function',
      name: 'render_mermaid',
      description:
        'Render a Mermaid.js diagram as an interactive SVG in the chat UI, displayed inline in a dedicated card. Returns success confirmation or syntax error details -- fix the syntax and call again if it errors.',
      inputSchema: {
        type: 'object',
        properties: {
          source: { type: 'string', description: 'Complete Mermaid diagram syntax' },
          title: { type: 'string', description: 'Optional title/caption shown on the diagram card' }
        },
        required: ['source'],
        additionalProperties: false
      }
    },
    {
      type: 'function',
      name: 'create_mockup',
      description:
        'Create a new UI mockup: scaffolds a directory on disk and writes the initial HTML, rendered inline as a preview card. Tailwind v3 utility classes are available; default to vanilla HTML/CSS/JS. Returns a directory ID -- edit the returned file path for incremental changes, then show_mockup to re-display.',
      inputSchema: {
        type: 'object',
        properties: {
          html: {
            type: 'string',
            description:
              'HTML body content for the mockup (goes inside <body>; Tailwind utility classes available)'
          },
          title: { type: 'string', description: 'Title shown on the mockup preview card' }
        },
        required: ['html'],
        additionalProperties: false
      }
    },
    {
      type: 'function',
      name: 'show_mockup',
      description:
        'Display an existing mockup from disk by its directory ID. Use this when the user wants to see a previously created mockup again and the original card is no longer visible.',
      inputSchema: {
        type: 'object',
        properties: {
          directory: {
            type: 'string',
            description: 'The mockup directory ID returned by create_mockup'
          }
        },
        required: ['directory'],
        additionalProperties: false
      }
    }
  ]
}

/** Constructing it is cheap but stateless, so one per process is enough (mirrors PiSession's memo). */
let mermaid: ReturnType<typeof createMermaidServer> | null = null

/** Fail-closed default: never crash on a name the caller should already have refused. */
function unknownHostedTool(name: string): ToolResultContent {
  return { content: [{ type: 'text', text: `Unknown hosted tool "${name}"` }], isError: true }
}

/**
 * Run one hosted tool and hand back the MCP-shaped `{content, isError?}` the
 * shared handlers produce. The caller maps that onto `contentItems`/`success`.
 *
 * `signal` is the app-server request's own abort signal: `finishTurn` fires it
 * for an ended turn and disposal fires it for all of them, so a handler that
 * watches it stops when the turn does. Mockups are written under
 * `<cwd>/.claude/ui/mockups`, parity with every other engine
 * (`createMockupServer` bakes `cwd` into its `mockupsRoot` at construction, so
 * a per-call server is the only way to keep that honest — it is two `join()`s).
 *
 * Never throws: a handler fault becomes an error RESULT, which reaches the
 * model as a failed tool call it can react to, rather than a rejected server
 * request the app-server turns into its own opaque "dynamic tool request
 * failed".
 */
export async function runCodexHostedTool(
  name: string,
  args: Record<string, unknown>,
  cwd: string,
  signal: AbortSignal
): Promise<ToolResultContent> {
  const extra = { signal, sendNotification: async (): Promise<void> => {} }
  try {
    if (name === 'render_mermaid') {
      mermaid ??= createMermaidServer()
      const tool = mermaid.tools.find((entry) => entry.name === name)
      return tool ? await tool.handler(args, extra) : unknownHostedTool(name)
    }
    if (name === 'create_mockup' || name === 'show_mockup') {
      const tool = createMockupServer(cwd).tools.find((entry) => entry.name === name)
      return tool ? await tool.handler(args, extra) : unknownHostedTool(name)
    }
    return unknownHostedTool(name)
  } catch (error) {
    return {
      content: [
        {
          type: 'text',
          text: `Hosted tool "${name}" failed: ${error instanceof Error ? error.message : String(error)}`
        }
      ],
      isError: true
    }
  }
}
