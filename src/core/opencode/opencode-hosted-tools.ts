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
 *
 * The session tools (session tools, slice 2) are registered here too, as
 * `claudeui_session_*`, when the host wired them (`deps.sessionTools`): see
 * `registerSessionTools`. Root agent only.
 *
 * Caller identity (ADR-097 §4, amends ADR-033): see `resolveCallerIdentity`.
 * One McpServer is built per MCP SESSION (mcp-http-host.ts): an opencode 2.x
 * server serves every directory and connects its MCP clients per directory, so
 * the mockup tools resolve their cwd per CALL from the calling session.
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { RequestHandlerExtra } from '@modelcontextprotocol/sdk/shared/protocol.js'
import type { ServerNotification, ServerRequest } from '@modelcontextprotocol/sdk/types.js'
import { z } from 'zod'
import { createMermaidServer } from '../services/mermaid-tool'
import { createMockupServer } from '../services/mockup-tool'
import { loadEngineConfig } from '../services/ui-config'
import { describeDispatchModels } from '../services/dispatch-model-hint'
import {
  DISPATCH_BACKGROUND_PARAM,
  DISPATCH_DESCRIPTION_PARAM,
  DISPATCH_NAME_PARAM,
  dispatchAgentDescription,
  HAND_BACK_DESCRIPTION,
  HAND_BACK_REPORT_PARAM,
  HAND_BACK_TOOL,
  joinDispatchHints,
  OWN_SUBAGENT_TOOL,
  runsInBackground
} from '../../shared/dispatch-agent-description'
import {
  SESSION_TOOL_NAMES,
  sessionToolDescriptions,
  sessionToolsGuidance,
  type SessionToolName
} from '../../shared/session-tools-description'
import { SESSION_TOOL_SHAPES } from '../services/session-tool-specs'
import type { SessionToolCaller, SessionToolResult } from '../services/session-tools'
import type { SdkMcpTool, SdkToolExtra } from '../sdk/types'
import type { ChatMessage, EngineId } from '../../shared/types'
import type { BlockedCallLedger } from '../automode/blocked-calls'
import type { CallerRestriction } from './caller-restriction'
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
  /** The caller's Claude-style permission mode, read LIVE at every dispatch
   *  decision (ADR-088) — not a snapshot taken when the handle was built. */
  getAutonomyMode: () => string
  /** The caller's live transcript (ISession.getMessages), for the judge of a
   *  dispatched pi/opencode target's calls (ADR-088). */
  getMessages: () => ChatMessage[]
  /** The caller's still-queued user turns (ISession.queuedUserTurns, ADR-091 §4). */
  getQueuedUserTurns?: () => ChatMessage[]
  /** The caller's approvable blocks and grants (ISession.blockedCalls, ADR-091 part 6). */
  blockedCalls?: BlockedCallLedger
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

/**
 * The ClaudeUI chat a non-chat caller (a subagent child) descends from, with
 * the restriction its agent chain carries (ADR-097 S9, option a); `refused`
 * when that restriction cannot be read (fail closed); undefined when no
 * ancestor is a ClaudeUI chat.
 */
export type CallerRootResolver = (
  sessionId: string
) => Promise<
  | { readonly root: string; readonly restriction: CallerRestriction | undefined }
  | { readonly refused: string }
  | undefined
>

/**
 * The session tools' service, injected like {@link DispatchAgentFn}; absent (the
 * host did not wire them, or a test) registers none of the nine.
 */
export interface HostedSessionTools {
  run: (
    caller: SessionToolCaller,
    tool: SessionToolName,
    input: Record<string, unknown>
  ) => Promise<SessionToolResult>
}

/** The `claudeui_` prefix opencode puts on this server's tool names. */
const HOSTED_TOOL_PREFIX = 'claudeui_'

/**
 * `hand_back` (ADR-105 §3), injected like {@link DispatchAgentFn}: the dispatcher holds the
 * targets. `sessionId` is the session `_meta` names; the dispatcher refuses anything that is
 * not a dispatch target's own session.
 */
export type HandBackFn = (
  sessionId: string,
  report: unknown,
  callId: string | undefined
) => { text: string; isError: boolean }

/** Same cycle-avoidance rationale as CallerSessionLookup above. */
export type DispatchAgentFn = (
  req: DispatchRequest,
  ctx: DispatchContext
) => Promise<DispatchResult>

/**
 * The `_meta` key opencode 2.x puts on EVERY MCP `tools/call`
 * (vendor/opencode-src/packages/core/src/mcp/client.ts `callTool`).
 */
export const OPENCODE_SESSION_META_KEY = 'ai.opencode/sessionID'

export interface CallerIdentity {
  /** The calling opencode session, or undefined when nothing identifies it. */
  sessionId?: string
  /** The calling tool part's id (ADR-033 M3 live streaming), plugin-only. */
  callId?: string
  /** Which signal supplied `sessionId`. */
  source: 'meta' | 'plugin' | 'none'
  /** `_meta` and the plugin stamp named DIFFERENT sessions (`_meta` won). */
  mismatch?: boolean
}

/**
 * Who called a hosted tool. PRECEDENCE (ADR-097 §4):
 *
 * 1. Session — `_meta["ai.opencode/sessionID"]` wins. It is opencode's own
 *    first-party contract, set by the engine outside anything the model or a
 *    plugin controls, and it works even when the `claudeui-xeng` plugin failed
 *    to load. The plugin's `__xeng_caller_session` stamp is the fallback for a
 *    request without `_meta` (an engine that does not send it).
 * 2. Call id — only the plugin knows it (`__xeng_call_id`), and it is trusted
 *    only when the same call also carries the plugin's session stamp and that
 *    stamp agrees with `_meta`: the plugin always writes both together, so a
 *    lone or disagreeing call id did not come from it. No call id → dispatch
 *    still works, without live streaming (as before).
 */
export function resolveCallerIdentity(
  meta: Record<string, unknown> | undefined,
  args: { __xeng_caller_session?: unknown; __xeng_call_id?: unknown }
): CallerIdentity {
  const nonEmpty = (v: unknown): string | undefined =>
    typeof v === 'string' && v.length > 0 ? v : undefined
  const fromMeta = nonEmpty(meta?.[OPENCODE_SESSION_META_KEY])
  const stamped = nonEmpty(args.__xeng_caller_session)
  const stampedCall = nonEmpty(args.__xeng_call_id)
  const mismatch = !!fromMeta && !!stamped && fromMeta !== stamped
  const callId = stamped && !mismatch ? stampedCall : undefined
  if (fromMeta)
    return { sessionId: fromMeta, callId, source: 'meta', ...(mismatch ? { mismatch } : {}) }
  if (stamped) return { sessionId: stamped, callId, source: 'plugin' }
  return { source: 'none' }
}

/**
 * Resolves the directory a hosted tool call works in, from the calling
 * session's id (see `resolveCallerIdentity`). Undefined when it cannot.
 */
export type CallerCwdResolver = (callerSessionId: string | undefined) => Promise<string | undefined>

/**
 * Built per server creation (not module-load time) so the `model` param's
 * `.describe()` can carry the concrete model-hint resolved from the current
 * engines/claude.json (ADR-033 follow-up — see dispatch-model-hint.ts).
 */
function buildDispatchAgentInputSchema(
  modelHintShort: string,
  piModelHintShort: string,
  codexModelHintShort: string
): Record<string, z.ZodTypeAny> {
  return {
    engine: z.enum(['claude', 'pi', 'codex']).describe('Target engine to dispatch to'),
    prompt: z.string().describe('Task for the dispatched agent'),
    model: z
      .string()
      .optional()
      .describe(
        'Target model id (format depends on the target engine — must be user-allowed). Omit for ' +
          `that engine's configured default. For claude: a Claude alias (e.g. "haiku", "sonnet") — ` +
          `${modelHintShort} For pi: ${piModelHintShort} For codex: ${codexModelHintShort}`
      ),
    name: z.string().optional().describe(DISPATCH_NAME_PARAM),
    description: z.string().optional().describe(DISPATCH_DESCRIPTION_PARAM),
    session_id: z
      .string()
      .optional()
      .describe('session_id from a previous dispatch_agent result — continues that agent'),
    run_in_background: z.boolean().optional().describe(DISPATCH_BACKGROUND_PARAM),
    // Internal — see resources/opencode/claudeui-xeng/index.js. Declared
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
 * tools. Mockups land under `<cwd>/.claude/ui/mockups`: a string `cwd` binds
 * them at creation time, a `CallerCwdResolver` per call (the server manager's
 * case — one opencode server serves every directory).
 *
 * `lookupCallerSession`/`dispatch` are optional so existing callers (and
 * lifecycle tests that only exercise server spawn/teardown) keep working
 * unchanged; when omitted, `dispatch_agent` degrades to a safe isError
 * instead of throwing or silently misrouting.
 */
export function createOpencodeHostedToolsServer(
  cwd: string | CallerCwdResolver,
  deps: {
    lookupCallerSession?: CallerSessionLookup
    /**
     * The ClaudeUI session a caller descends from, when the caller itself is
     * not one (a subagent child: opencode's `_meta` names the CHILD session).
     */
    resolveCallerRoot?: CallerRootResolver
    dispatch?: DispatchAgentFn
    /** The dispatch targets' report channel (ADR-105 §3); `hand_back` is not registered without it. */
    handBack?: HandBackFn
    /** The session tools' service (slice 2); none registered without it. */
    sessionTools?: HostedSessionTools
    /** Called when `_meta` and the plugin stamp disagree (diagnostics). */
    onIdentityMismatch?: (identity: CallerIdentity) => void
  } = {}
): McpServer {
  const server = new McpServer(
    { name: 'claudeui', version: '1.0.0' },
    {
      capabilities: { tools: {} },
      // The session tools' guidance rides the MCP server's own instructions, which
      // opencode puts in the model's prompt (`core/src/mcp/instructions.ts`). Every
      // session on the server reads it, subagents and dispatch targets too: they
      // are not offered the tools (`SESSION_TOOLS_DENY_RULE`), so it costs them
      // one short paragraph.
      ...(deps.sessionTools
        ? { instructions: sessionToolsGuidance({ toolPrefix: HOSTED_TOOL_PREFIX }) }
        : {})
    }
  )

  // Extract tool definitions from the canonical implementations.
  const mermaidTools: SdkMcpTool[] = createMermaidServer().tools
  for (const t of mermaidTools) {
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

  // Mockups land under `<cwd>/.claude/ui/mockups`. A fixed cwd (tests, and any
  // single-directory host) binds them once; a resolver binds them per call to
  // the CALLING session's directory, memoized per directory.
  const mockupsByCwd = new Map<string, SdkMcpTool[]>()
  const mockupToolsFor = (dir: string): SdkMcpTool[] => {
    let tools = mockupsByCwd.get(dir)
    if (!tools) {
      tools = createMockupServer(dir).tools
      mockupsByCwd.set(dir, tools)
    }
    return tools
  }
  const fixedCwd = typeof cwd === 'string' ? cwd : null
  // Schemas and descriptions do not depend on the directory.
  for (const t of createMockupServer(fixedCwd ?? '.').tools) {
    const handler = fixedCwd
      ? t.handler
      : async (
          args: Record<string, unknown>,
          extra: RequestHandlerExtra<ServerRequest, ServerNotification>
        ) => {
          const caller = resolveCallerIdentity(
            extra?._meta as Record<string, unknown> | undefined,
            {}
          )
          const dir = await (cwd as CallerCwdResolver)(caller.sessionId).catch(() => undefined)
          if (!dir) {
            return {
              content: [
                {
                  type: 'text' as const,
                  text: `${t.name} could not determine the calling session's project directory${caller.sessionId ? ` (${caller.sessionId})` : ''}. Try again from an active ClaudeUI session.`
                }
              ],
              isError: true
            }
          }
          const target = mockupToolsFor(dir).find((m) => m.name === t.name)!
          return target.handler(args)
        }
    server.registerTool(
      t.name,
      {
        description: t.description,
        inputSchema: t.inputSchema as unknown as Record<string, z.ZodTypeAny>
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      handler as unknown as (...args: any[]) => any
    )
  }

  // Model-hint snapshot (ADR-033 follow-up, see dispatch-model-hint.ts):
  // resolved ONCE per MCP session (one per directory an opencode server serves,
  // see mcp-http-host.ts) from engines/claude.json. Config edits mid-lifetime
  // aren't reflected until the NEXT session — cross-engine-dispatcher.ts's isError allowlist
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
  // codex (ADR-033 slice H) — a THIRD independent snapshot alongside the two
  // above, same snapshot-at-spawn caveat.
  const codexDispatchCfg = loadEngineConfig('codex').dispatch
  const codexModelHint = describeDispatchModels({
    targetEngine: 'codex',
    allowedModels: codexDispatchCfg?.allowedModels,
    defaultModel: codexDispatchCfg?.defaultModel
  })

  server.registerTool(
    'dispatch_agent',
    {
      description: dispatchAgentDescription({
        targets: ['claude', 'pi', 'codex'],
        ownSubagentTool: OWN_SUBAGENT_TOOL.opencode,
        hints: joinDispatchHints([
          { targetEngine: 'claude', long: modelHint.long },
          { targetEngine: 'pi', long: piModelHint.long },
          { targetEngine: 'codex', long: codexModelHint.long }
        ])
      }),
      inputSchema: buildDispatchAgentInputSchema(
        modelHint.short,
        piModelHint.short,
        codexModelHint.short
      )
    },
    async (
      args: Record<string, unknown>,
      extra: RequestHandlerExtra<ServerRequest, ServerNotification>
    ) => {
      const {
        engine,
        prompt,
        model,
        name,
        description,
        session_id,
        run_in_background,
        __xeng_caller_session,
        __xeng_call_id
      } = args as {
        engine: 'claude' | 'pi' | 'codex'
        prompt: string
        model?: string
        name?: string
        description?: string
        session_id?: string
        run_in_background?: boolean
        __xeng_caller_session?: string
        __xeng_call_id?: string
      }

      const identity = resolveCallerIdentity(extra?._meta as Record<string, unknown> | undefined, {
        __xeng_caller_session,
        __xeng_call_id
      })
      if (identity.mismatch) deps.onIdentityMismatch?.(identity)
      const callerId = identity.sessionId
      if (!callerId) {
        return {
          content: [
            {
              type: 'text' as const,
              text:
                'dispatch_agent could not identify the calling session: the request carried neither ' +
                `opencode's _meta["${OPENCODE_SESSION_META_KEY}"] nor the ClaudeUI caller-identity ` +
                "plugin's stamp (claudeui-xeng) — ask the user to check their opencode configuration."
            }
          ],
          isError: true
        }
      }

      // The dispatch belongs to the ClaudeUI chat: the caller, or the chat a
      // subagent child descends from (its targets are disposed with that chat).
      let routingId = callerId
      let callerRestriction: CallerRestriction | undefined
      let caller = deps.lookupCallerSession?.(callerId)
      // The chat's own agent is the root caller; a subagent child resolves to its chat below.
      // Only the root agent defaults to a background run (ADR-105 §2).
      const callerIsRoot = !!caller
      if (!caller && deps.resolveCallerRoot) {
        const resolved = await deps.resolveCallerRoot(callerId).catch(() => undefined)
        if (resolved && 'refused' in resolved) {
          return { content: [{ type: 'text' as const, text: resolved.refused }], isError: true }
        }
        if (resolved) {
          routingId = resolved.root
          callerRestriction = resolved.restriction
          caller = deps.lookupCallerSession?.(resolved.root)
        }
      }
      if (!caller) {
        return {
          content: [
            {
              type: 'text' as const,
              text: `dispatch_agent could not find the calling session (${callerId}) — it may have ended. Start a fresh dispatch from an active session.`
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

      const background = runsInBackground(run_in_background, callerIsRoot, identity.callId)
      const result = await deps.dispatch(
        {
          engine,
          prompt,
          model,
          name,
          description,
          sessionId: session_id,
          ...(background ? { runInBackground: true } : {}),
          // A subagent child asked for the background: its report goes to the chat's root agent.
          ...(background && !callerIsRoot ? { fromSubagent: true } : {})
        },
        {
          fromEngine: 'opencode',
          fromRoutingId: routingId,
          cwd: caller.cwd,
          getAutonomyMode: caller.getAutonomyMode,
          getMessages: caller.getMessages,
          ...(caller.getQueuedUserTurns ? { getQueuedUserTurns: caller.getQueuedUserTurns } : {}),
          ...(caller.blockedCalls ? { blockedCalls: caller.blockedCalls } : {}),
          emit: caller.emit,
          addDispatchedCost: caller.addDispatchedCost,
          toolUseId: identity.callId,
          ...(callerRestriction ? { callerRestriction } : {}),
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

  if (deps.handBack) registerHandBack(server, deps.handBack)
  if (deps.sessionTools) registerSessionTools(server, deps)

  return server
}

/**
 * `claudeui_hand_back`: the report a dispatch target ends its run with (ADR-105 §3). It is on
 * the shared server, so every session of the server is offered it; the interactive rulesets
 * deny it (`HAND_BACK_DENY_RULE`, hidden from the model) and only a target's ruleset allows
 * it. The caller is the session opencode's `_meta` names — never the model's say-so — and the
 * dispatcher accepts only a dispatch target's own session, so a subagent child of a target,
 * an interactive chat or an unidentified call is refused here as well.
 */
function registerHandBack(server: McpServer, handBack: HandBackFn): void {
  server.registerTool(
    HAND_BACK_TOOL,
    {
      description: HAND_BACK_DESCRIPTION,
      inputSchema: { report: z.string().describe(HAND_BACK_REPORT_PARAM) }
    },
    async (
      args: { report: string },
      extra: RequestHandlerExtra<ServerRequest, ServerNotification>
    ) => {
      const callerId = resolveCallerIdentity(
        extra?._meta as Record<string, unknown> | undefined,
        {}
      ).sessionId
      const answer = callerId
        ? handBack(callerId, args.report, undefined)
        : {
            text: 'hand_back could not identify the calling session, so no report was taken.',
            isError: true
          }
      return {
        content: [{ type: 'text' as const, text: answer.text }],
        ...(answer.isError ? { isError: true as const } : {})
      }
    }
  )
}

/**
 * The nine session tools on the hosted server (`claudeui_session_*`). The caller is
 * the session opencode names in `_meta` (the plugin's stamp exists for dispatch's
 * call id only, and opencode 2.x sends `_meta` on every `tools/call`): a ClaudeUI
 * chat is the root agent; a subagent child resolves to the chat it descends from and
 * is attributed `subagent`, which the service refuses for every acting tool. Any
 * other caller (a dispatch target, a session ClaudeUI never created, an agent whose
 * rules cannot be read) gets a refusal and nothing runs: fail closed.
 */
function registerSessionTools(
  server: McpServer,
  deps: {
    lookupCallerSession?: CallerSessionLookup
    resolveCallerRoot?: CallerRootResolver
    sessionTools?: HostedSessionTools
  }
): void {
  // No `ownMessageTool`: opencode has no teammate-messaging tool to point `session_message`
  // away from (pi passes `send_message`, Claude `SendMessage`).
  const descriptions = sessionToolDescriptions({})
  const refuse = (text: string): { content: { type: 'text'; text: string }[]; isError: true } => ({
    content: [{ type: 'text' as const, text: `Refused: ${text}` }],
    isError: true
  })
  for (const name of SESSION_TOOL_NAMES) {
    server.registerTool(
      name,
      {
        description: descriptions[name],
        inputSchema: SESSION_TOOL_SHAPES[name] as unknown as Record<string, z.ZodTypeAny>
      },
      async (
        args: Record<string, unknown>,
        extra: RequestHandlerExtra<ServerRequest, ServerNotification>
      ) => {
        const callerId = resolveCallerIdentity(
          extra?._meta as Record<string, unknown> | undefined,
          {}
        ).sessionId
        if (!callerId) {
          return refuse(`${name} could not identify the calling session, so it is not run.`)
        }
        let routingId = callerId
        let owner: 'root' | 'subagent' = 'root'
        let handle = deps.lookupCallerSession?.(callerId)
        if (!handle && deps.resolveCallerRoot) {
          const resolved = await deps.resolveCallerRoot(callerId).catch(() => undefined)
          if (resolved && 'refused' in resolved) return refuse(resolved.refused)
          if (resolved) {
            routingId = resolved.root
            owner = 'subagent'
            handle = deps.lookupCallerSession?.(resolved.root)
          }
        }
        if (!handle) {
          return refuse(
            `${name} is for the main agent of a ClaudeUI session; the calling session (${callerId}) is not one.`
          )
        }
        const result = await deps.sessionTools!.run(
          {
            routingId,
            engine: 'opencode',
            cwd: handle.cwd,
            permissionMode: handle.getAutonomyMode(),
            callOwner: async () => owner
          },
          name,
          args
        )
        return {
          content: [{ type: 'text' as const, text: result.text }],
          ...(result.isError ? { isError: true as const } : {})
        }
      }
    )
  }
}
