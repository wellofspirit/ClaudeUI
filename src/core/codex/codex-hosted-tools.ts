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
 * The four tools are the SAME four pi registers by bare name
 * (pi-bridge-source.ts) and Claude/opencode expose over MCP, delegating to the
 * SAME in-process handlers (mermaid-tool.ts / mockup-tool.ts) — the field names
 * are identical on purpose so the shared renderer kind bodies render a Codex
 * call exactly like a pi or Claude one.
 *
 * `dispatch_agent` (ADR-033, slice E) is declared here but NOT executed here:
 * it needs the session's routing id, cwd, permission mode, emit, cost sink and
 * abort signal, so `CodexSession.hostedToolCall` branches on the name before
 * it ever reaches `runCodexHostedTool` — exactly the split pi uses
 * (PiSession.handleDispatchAgent vs the three handler cases beside it).
 *
 * Otherwise pure — no session import, no module state beyond the memoized
 * mermaid server (which has none of its own). The one I/O the specs do is the
 * `loadEngineConfig` read behind the dispatch model hints, which is the same
 * registration-time snapshot opencode-hosted-tools.ts takes (see
 * dispatch-model-hint.ts): config edits land on the NEXT thread creation.
 */
import type { DynamicToolSpec } from './protocol/v2/DynamicToolSpec'
import type { ToolResultContent } from '../sdk/types'
import type { EngineId } from '../../shared/types'
import { createMermaidServer } from '../services/mermaid-tool'
import { createMockupServer } from '../services/mockup-tool'
import { describeDispatchModels } from '../services/dispatch-model-hint'
import { loadEngineConfig } from '../services/ui-config'

/**
 * Every tool name this module's callers will execute. `CodexSession` refuses an
 * `item/tool/call` for anything outside this set BEFORE dispatching, so the set
 * is the security boundary, not just a lookup table. `dispatch_agent` is IN it
 * (the session executes it itself) even though `runCodexHostedTool` refuses it.
 */
export const CODEX_HOSTED_TOOL_NAMES: ReadonlySet<string> = new Set([
  'render_mermaid',
  'create_mockup',
  'show_mockup',
  'dispatch_agent'
])

/**
 * Engines a Codex session may dispatch INTO. Codex itself is absent — the
 * dispatcher has no Codex target factory, and a same-engine dispatch is
 * rejected by its own engine guard regardless.
 */
const DISPATCH_TARGETS: readonly EngineId[] = ['claude', 'opencode', 'pi']

/**
 * The `dynamicTools` param for `thread/start`, in the CANONICAL tagged form
 * (`{type:'function', ...}`). The legacy untagged form still deserializes
 * (`protocol/src/dynamic_tools.rs` `normalize_dynamic_tool_specs`), but mixing
 * the two in one list is a hard error there, so this stays tagged throughout.
 *
 * Names must match `^[a-zA-Z0-9_-]+$` and must not start with `mcp`
 * (`validate_dynamic_tools`, app-server/src/request_processors/
 * thread_processor.rs) — these four do. `deferLoading` is NOT set: it requires
 * a namespace, and a namespace would change the wire tool name the model sees
 * and the `namespace` field on every call.
 *
 * `includeDispatch` is the session's RESOLVED `crossEngineDispatch` capability
 * (ADR-030 honesty, mirroring the `CLAUDEUI_PI_DISPATCH_ENABLED` env gate pi
 * puts on the same tool): a session that has nowhere to dispatch to must not
 * advertise the tool at all.
 */
export function codexDynamicToolSpecs(includeDispatch: boolean): DynamicToolSpec[] {
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
    },
    ...(includeDispatch ? [dispatchAgentSpec()] : [])
  ]
}

/**
 * `dispatch_agent` (ADR-033, slice E) — Codex as a dispatch SOURCE. Wording and
 * parameter names mirror opencode's Zod registration
 * (opencode-hosted-tools.ts) verbatim, so the same tool reads the same to a
 * model whichever engine is hosting it, and the renderer's shared `task` kind
 * body finds the fields it expects (`engine`/`prompt`/`model`).
 *
 * The model hints are a snapshot of `engines/<target>.json` taken at thread
 * creation — see dispatch-model-hint.ts for why that is resolved here rather
 * than looked up per call.
 */
function dispatchAgentSpec(): DynamicToolSpec {
  const hints = DISPATCH_TARGETS.map((targetEngine) => {
    const dispatch = loadEngineConfig(targetEngine).dispatch
    return {
      targetEngine,
      ...describeDispatchModels({
        targetEngine,
        allowedModels: dispatch?.allowedModels,
        defaultModel: dispatch?.defaultModel
      })
    }
  })
  return {
    type: 'function',
    name: 'dispatch_agent',
    description:
      'Delegate a task to an agent running on a DIFFERENT engine — claude, opencode or pi. The ' +
      'agent runs headless in the same working directory and its final answer is returned as this ' +
      'tool result. The result includes a session_id — pass it back as `session_id` to continue ' +
      'the same agent with its context intact (multi-turn collaboration). The available model ' +
      "list is user-configured per target engine; omit `model` to use that engine's configured " +
      `default. ${hints.map((hint) => `For ${hint.targetEngine}: ${hint.long}`).join(' ')}`,
    inputSchema: {
      type: 'object',
      properties: {
        engine: {
          type: 'string',
          enum: [...DISPATCH_TARGETS],
          description: 'Target engine to dispatch to'
        },
        prompt: { type: 'string', description: 'Task for the dispatched agent' },
        model: {
          type: 'string',
          description:
            'Target model id (format depends on the target engine — must be user-allowed). Omit ' +
            `for that engine's configured default. ${hints
              .map((hint) => `For ${hint.targetEngine}: ${hint.short}`)
              .join(' ')}`
        },
        session_id: {
          type: 'string',
          description: 'session_id from a previous dispatch_agent result — continues that agent'
        }
      },
      required: ['engine', 'prompt'],
      additionalProperties: false
    }
  }
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
 *
 * `dispatch_agent` is NOT runnable here — it needs session state this module
 * deliberately cannot see, so `CodexSession.hostedToolCall` handles it before
 * calling in and the name falls through to the fail-closed unknown branch.
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
