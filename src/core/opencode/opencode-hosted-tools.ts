/**
 * Single McpServer ('claudeui') that exposes all four hosted tools:
 *   render_mermaid, create_mockup, show_mockup, dispatch_agent
 *
 * Reuses the real tool handler logic from mermaid-tool.ts and
 * mockup-tool.ts — no duplication. Tool definitions are extracted from
 * the SdkMcpServer wrappers returned by those factories and re-registered
 * on one unified McpServer so opencode sees a single MCP server.
 *
 * opencode sanitizes tool names as `sanitize(serverName)_sanitize(toolName)`
 * where sanitize = `s.replace(/[^a-zA-Z0-9_-]/g, "_")`. With server name
 * 'claudeui' the resulting names are:
 *   claudeui_render_mermaid, claudeui_create_mockup, claudeui_show_mockup,
 *   claudeui_dispatch_agent
 *
 * `dispatch_agent` (ADR-033 M2, opencode → Claude) is registered directly
 * (not extracted from an SdkMcpServer factory) because it needs the raw MCP
 * SDK `extra` (RequestHandlerExtra) adapted into our SdkToolExtra shape, and
 * because it depends on TWO things this module must NOT import directly —
 * see the cycle note on `CallerSessionLookup`/`DispatchAgentFn` below.
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { RequestHandlerExtra } from '@modelcontextprotocol/sdk/shared/protocol.js'
import type { ServerNotification, ServerRequest } from '@modelcontextprotocol/sdk/types.js'
import { z } from 'zod'
import { createMermaidServer } from '../services/mermaid-tool'
import { createMockupServer } from '../services/mockup-tool'
import { loadEngineConfig } from '../services/ui-config'
import { describeDispatchModels } from '../services/dispatch-model-hint'
import type { SdkMcpTool, SdkToolExtra } from '../sdk/types'
import type { EngineId } from '../../shared/types'
// `import type` only: DispatchContext/DispatchRequest/DispatchResult are
// ERASED at compile time, so this does NOT create a runtime import cycle
// even though cross-engine-dispatcher.ts (at runtime) imports
// OpencodeServerManager.ts, which imports THIS module.
import type {
  DispatchContext,
  DispatchRequest,
  DispatchResult
} from '../services/cross-engine-dispatcher'

/**
 * What the dispatch tool needs to know about the CALLING opencode session.
 * Deliberately structural/minimal (not `OpencodeSession` itself) — see the
 * cycle note below.
 */
export interface CallerSessionHandle {
  cwd: string
  /** Claude-style permission-mode string (buildRuleset's `mode` param). */
  autonomyMode: string
  /** Re-emits an event under the caller session's routing (ISession.emit). */
  emit: (channel: string, data: unknown) => void
  /** ISession.addDispatchedCost — folds a dispatched turn's spend into the
   *  caller session's own cost breakdown (ADR-033 Slice C). */
  addDispatchedCost: (engineId: EngineId, modelId: string, costUsd: number) => void
}

/**
 * Resolves the live OpencodeSession for a caller session id (routingId,
 * post-rekey — see collab-tool.ts's identical convention on the Claude
 * side) into the minimal handle above, or undefined if no such session is
 * currently live.
 *
 * CYCLE NOTE: this module is imported by OpencodeServerManager.ts (to build
 * the hosted tools server), which is in turn imported by
 * cross-engine-dispatcher.ts (for opencode targets) AND by OpencodeSession.ts
 * (its own server connection). If this module imported `sessionManager`
 * (session-manager.ts → register-engines.ts → OpencodeSession.ts →
 * OpencodeServerManager.ts → **this module**) or `crossEngineDispatcher`
 * (cross-engine-dispatcher.ts → OpencodeServerManager.ts → **this module**)
 * directly, both would form a require-cycle. Instead, the lookup (and the
 * dispatch function below) are threaded in as a constructor-injected
 * dependency: OpencodeServerManager holds a settable field, wired ONCE at
 * app bootstrap in main/index.ts (which sits above both cycles and can
 * safely import sessionManager + crossEngineDispatcher).
 */
export type CallerSessionLookup = (sessionId: string) => CallerSessionHandle | undefined

/** Same cycle-avoidance rationale as CallerSessionLookup above. */
export type DispatchAgentFn = (
  req: DispatchRequest,
  ctx: DispatchContext
) => Promise<DispatchResult>

/**
 * Built per server creation (not module-load time) so the `model` param's
 * `.describe()` can carry the concrete model-hint resolved from the current
 * engines/claude.json (ADR-033 follow-up — see dispatch-model-hint.ts).
 */
function buildDispatchAgentInputSchema(
  modelHintShort: string,
  piModelHintShort: string
): Record<string, z.ZodTypeAny> {
  return {
    engine: z.enum(['claude', 'pi']).describe('Target engine to dispatch to'),
    prompt: z.string().describe('Task for the dispatched agent'),
    model: z
      .string()
      .optional()
      .describe(
        'Target model id (format depends on the target engine — must be user-allowed). Omit for ' +
          `that engine's configured default. For claude: a Claude alias (e.g. "haiku", "sonnet") — ` +
          `${modelHintShort} For pi: ${piModelHintShort}`
      ),
    session_id: z
      .string()
      .optional()
      .describe('session_id from a previous dispatch_agent result — continues that agent'),
    // Internal — see resources/opencode/claudeui-xeng-plugin.ts. Declared
    // explicitly so our Zod validator does not STRIP it (z.object() drops
    // unknown keys by default); the handler reads then removes it before any
    // other use.
    __xeng_caller_session: z
      .string()
      .optional()
      .describe('internal — set automatically by the ClaudeUI plugin; never set this yourself'),
    // Internal — same zod-stripping hazard as __xeng_caller_session above. The
    // plugin also stamps the calling tool part's own callID (ADR-033 M3) so the
    // dispatcher can key subagent-stream/task-progress/task-notification events
    // to the dispatching tool_use block. Missing → dispatch still works, just
    // without live streaming (never fail a dispatch over a missing id).
    __xeng_call_id: z
      .string()
      .optional()
      .describe('internal — set automatically by the ClaudeUI plugin; never set this yourself')
  }
}

/**
 * Create a single McpServer (name 'claudeui') that exposes all hosted
 * tools. Cwd is baked into the mockup tool's path resolution at creation time
 * (mockups land under `<cwd>/.claude/ui/mockups`).
 *
 * `lookupCallerSession`/`dispatch` are optional so existing callers (and
 * lifecycle tests that only exercise server spawn/teardown) keep working
 * unchanged; when omitted, `dispatch_agent` degrades to a safe isError
 * instead of throwing or silently misrouting.
 */
export function createOpencodeHostedToolsServer(
  cwd: string,
  deps: { lookupCallerSession?: CallerSessionLookup; dispatch?: DispatchAgentFn } = {}
): McpServer {
  const server = new McpServer(
    { name: 'claudeui', version: '1.0.0' },
    { capabilities: { tools: {} } }
  )

  // Extract tool definitions from the canonical implementations.
  const mermaidTools: SdkMcpTool[] = createMermaidServer().tools
  const mockupTools: SdkMcpTool[] = createMockupServer(cwd).tools

  for (const t of [...mermaidTools, ...mockupTools]) {
    server.registerTool(
      t.name,
      {
        description: t.description,
        inputSchema: t.inputSchema as unknown as Record<string, z.ZodTypeAny>
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      t.handler as unknown as (...args: any[]) => any
    )
  }

  // Model-hint snapshot (ADR-033 follow-up, see dispatch-model-hint.ts):
  // resolved ONCE per cwd-server spawn (OpencodeServerManager.resolveHandle)
  // from engines/claude.json. Config edits mid-lifetime aren't reflected
  // until the NEXT spawn — cross-engine-dispatcher.ts's isError allowlist
  // echo remains the live source of truth if the model turns out to be
  // stale/mismatched. No cached-model peek on this side (unlike the
  // opencode-target side in collab-tool.ts): the only synchronous main-side
  // source of Claude's model list is a per-Claude-session service-session
  // control handle (session.ipc.ts's fetchModels/supportedModels), which is
  // the wrong lifecycle for a registration path — async, and may not even
  // exist headless. Falls through to allowlist/default/generic-alias-hint.
  const dispatchCfg = loadEngineConfig('claude').dispatch
  const modelHint = describeDispatchModels({
    targetEngine: 'claude',
    allowedModels: dispatchCfg?.allowedModels,
    defaultModel: dispatchCfg?.defaultModel
  })
  // pi (ADR-033 M4c) — a SECOND, independent model-hint snapshot alongside
  // Claude's, since this one tool registration now spans two possible target
  // engines with unrelated model-id formats/allowlists. Same snapshot-at-spawn
  // caveat as the Claude hint above.
  const piDispatchCfg = loadEngineConfig('pi').dispatch
  const piModelHint = describeDispatchModels({
    targetEngine: 'pi',
    allowedModels: piDispatchCfg?.allowedModels,
    defaultModel: piDispatchCfg?.defaultModel
  })

  server.registerTool(
    'dispatch_agent',
    {
      description:
        "Delegate a task to an agent running on a DIFFERENT engine — Claude (Anthropic's models) or " +
        'pi (an alternative coding-agent harness). The agent runs headless in the same working ' +
        'directory and its final answer is returned as this tool result. The result includes a ' +
        'session_id — pass it back as `session_id` to continue the same agent with its context intact ' +
        '(multi-turn collaboration). The available model list is user-configured per target engine; ' +
        `omit \`model\` to use that engine's configured default. For claude: ${modelHint.long} For pi: ${piModelHint.long}`,
      inputSchema: buildDispatchAgentInputSchema(modelHint.short, piModelHint.short)
    },
    async (
      args: Record<string, unknown>,
      extra: RequestHandlerExtra<ServerRequest, ServerNotification>
    ) => {
      const { engine, prompt, model, session_id, __xeng_caller_session, __xeng_call_id } = args as {
        engine: 'claude' | 'pi'
        prompt: string
        model?: string
        session_id?: string
        __xeng_caller_session?: string
        __xeng_call_id?: string
      }

      if (!__xeng_caller_session) {
        return {
          content: [
            {
              type: 'text' as const,
              text:
                'dispatch_agent could not identify the calling session. The ClaudeUI caller-identity ' +
                'plugin (claudeui-xeng-plugin) must be loaded by opencode for cross-engine dispatch to ' +
                'work — ask the user to check their opencode configuration.'
            }
          ],
          isError: true
        }
      }

      const caller = deps.lookupCallerSession?.(__xeng_caller_session)
      if (!caller) {
        return {
          content: [
            {
              type: 'text' as const,
              text: `dispatch_agent could not find the calling session (${__xeng_caller_session}) — it may have ended. Start a fresh dispatch from an active session.`
            }
          ],
          isError: true
        }
      }

      if (!deps.dispatch) {
        return {
          content: [
            { type: 'text' as const, text: 'Cross-engine dispatch is not wired up in this build.' }
          ],
          isError: true
        }
      }

      const toolExtra: SdkToolExtra = {
        signal: extra.signal,
        progressToken: extra._meta?.progressToken,
        sendNotification: (notification) =>
          extra.sendNotification(notification as ServerNotification),
        meta: extra._meta as Record<string, unknown> | undefined
      }

      const result = await deps.dispatch(
        { engine, prompt, model, sessionId: session_id },
        {
          fromEngine: 'opencode',
          fromRoutingId: __xeng_caller_session,
          cwd: caller.cwd,
          autonomyMode: caller.autonomyMode,
          emit: caller.emit,
          addDispatchedCost: caller.addDispatchedCost,
          toolUseId: __xeng_call_id,
          extra: toolExtra
        }
      )

      const text = result.isError
        ? result.text
        : `${result.text}\n\n[dispatch session_id: ${result.sessionId} — pass it as session_id to continue this agent]`

      return {
        content: [{ type: 'text' as const, text }],
        ...(result.isError ? { isError: true } : {})
      }
    }
  )

  return server
}
