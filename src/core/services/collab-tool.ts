import { createSdkMcpServer, tool } from '../sdk'
import type { SdkMcpServer } from '../sdk'
import { z } from 'zod'
import { crossEngineDispatcher } from './cross-engine-dispatcher'
import { loadEngineConfig } from './ui-config'
import { peekOpencodeModels } from '../opencode/model-discovery'
import { describeDispatchModels } from './dispatch-model-hint'
import type { ChatMessage, EngineId } from '../../shared/types'
import {
  DISPATCH_BACKGROUND_PARAM,
  DISPATCH_DESCRIPTION_PARAM,
  DISPATCH_NAME_PARAM,
  DISPATCH_SESSION_ID_REMOVED_TEXT,
  dispatchAgentDescription,
  dispatchResultSuffix,
  hasRemovedSessionId,
  joinDispatchHints,
  OWN_SUBAGENT_TOOL,
  runsInBackground
} from '../../shared/dispatch-agent-description'
import type { ToolCallOwner } from './tool-use-owners'
import type { BlockedCallLedger } from '../automode/blocked-calls'

export interface CollabServerContext {
  engineId: EngineId
  /** Live routingId lookup — the session is rekeyed to its UUID after init. */
  getRoutingId: () => string
  cwd: string
  /** Live permission-mode lookup — read at every dispatch decision (ADR-088). */
  getAutonomyMode: () => string
  /** The session's live transcript (`getMessages()`), for the judge of a
   *  dispatched pi/opencode target's calls (ADR-088). */
  getMessages: () => ChatMessage[]
  /** The session's still-queued user turns (ADR-091 §4), for the same judge. */
  getQueuedUserTurns?: () => ChatMessage[]
  /** The session's approvable blocks and grants (ADR-091 part 6), for the same judge. */
  blockedCalls?: BlockedCallLedger
  /** BaseSession.send — re-emits under the dispatching session's routing. */
  emit: (channel: string, data: unknown) => void
  /** BaseSession.addDispatchedCost — folds a dispatched turn's spend into this
   *  session's own cost breakdown (ADR-033 Slice C). */
  addDispatchedCost: (engineId: EngineId, modelId: string, costUsd: number) => void
  /**
   * Who made a tool call, from the session's stream (`ToolUseOwners.ownerOf`): the default
   * for `run_in_background` is "background" for the root agent only (ADR-105 §2), and a
   * subagent's call or one that cannot be attributed waits. Absent: every call waits.
   */
  callOwner?: (toolUseId: string | undefined) => Promise<ToolCallOwner>
}

/**
 * In-process MCP server hosting the `dispatch_agent` tool (ADR-033).
 *
 * Registered as a SEPARATE server (`claude-ui-collab`) so it does NOT ride
 * the auto-allowed `mcp__claude-ui__` prefix — dispatch_agent goes through
 * canUseTool like an ordinary tool.
 */
export function createCollabServer(ctx: CollabServerContext): SdkMcpServer {
  // Model-hint snapshot (ADR-033 follow-up, see dispatch-model-hint.ts):
  // resolved ONCE per Claude session spawn from engines/opencode.json plus
  // whatever the opencode model-discovery cache happens to hold right now.
  // Config edits or newly-discovered models mid-session are NOT reflected
  // until the NEXT spawn — cross-engine-dispatcher.ts's isError allowlist
  // echo remains the live source of truth if the model turns out to be
  // stale/mismatched.
  const dispatchCfg = loadEngineConfig('opencode').dispatch
  const knownModelIds = peekOpencodeModels()?.flatMap((group) => group.models.map((m) => m.value))
  const modelHint = describeDispatchModels({
    targetEngine: 'opencode',
    allowedModels: dispatchCfg?.allowedModels,
    defaultModel: dispatchCfg?.defaultModel,
    knownModelIds
  })
  // pi (ADR-033 M4c) — a SECOND, independent model-hint snapshot, since one
  // tool registration now spans two possible target engines with unrelated
  // model-id formats/allowlists. Same snapshot-at-spawn caveat as above.
  const piDispatchCfg = loadEngineConfig('pi').dispatch
  const piModelHint = describeDispatchModels({
    targetEngine: 'pi',
    allowedModels: piDispatchCfg?.allowedModels,
    defaultModel: piDispatchCfg?.defaultModel
  })
  // codex (ADR-033 slice H) — a THIRD independent snapshot, same
  // snapshot-at-spawn caveat as the two above. No cached-model peek: Codex's
  // catalog only exists on a live app-server connection, which a synchronous
  // registration path must not open.
  const codexDispatchCfg = loadEngineConfig('codex').dispatch
  const codexModelHint = describeDispatchModels({
    targetEngine: 'codex',
    allowedModels: codexDispatchCfg?.allowedModels,
    defaultModel: codexDispatchCfg?.defaultModel
  })

  return createSdkMcpServer({
    name: 'claude-ui-collab',
    version: '1.0.0',
    tools: [
      tool(
        'dispatch_agent',
        dispatchAgentDescription({
          targets: ['opencode', 'pi', 'codex'],
          ownSubagentTool: OWN_SUBAGENT_TOOL.claude,
          hints: joinDispatchHints([
            { targetEngine: 'opencode', long: modelHint.long },
            { targetEngine: 'pi', long: piModelHint.long },
            { targetEngine: 'codex', long: codexModelHint.long }
          ])
        }),
        {
          // 'opencode', 'pi' (ADR-033 M4c) and 'codex' (slice H) are listed:
          // dispatching to 'claude' from a Claude session is same-engine and
          // already guard-rejected by the dispatcher — listing it here would be
          // misleading (ADR-033 M2).
          engine: z.enum(['opencode', 'pi', 'codex']).describe('Target engine to dispatch to'),
          prompt: z.string().describe('Task for the dispatched agent'),
          model: z
            .string()
            .optional()
            .describe(
              'Target model id (format depends on the target engine — must be user-allowed). Omit for ' +
                `that engine's configured default. For opencode: ${modelHint.short} ` +
                `For pi: ${piModelHint.short} For codex: ${codexModelHint.short}`
            ),
          name: z.string().optional().describe(DISPATCH_NAME_PARAM),
          description: z.string().describe(DISPATCH_DESCRIPTION_PARAM),
          run_in_background: z.boolean().optional().describe(DISPATCH_BACKGROUND_PARAM)
        },
        async (input, extra) => {
          const { engine, prompt, model, name, description, run_in_background } = input
          // `session_id` is no longer a parameter (ADR-105 §4) and is not in the schema the model
          // sees; the tool is registered `passthrough`, so a call that still sends one (an older
          // transcript) reaches us and gets the guiding error, with nothing launched.
          if (hasRemovedSessionId((input as Record<string, unknown>).session_id)) {
            return {
              content: [{ type: 'text' as const, text: DISPATCH_SESSION_ID_REMOVED_TEXT }],
              isError: true
            }
          }
          // cli.js stamps `_meta["claudecode/toolUseId"]` on EVERY MCP tools/call
          // (the calling assistant tool_use block's id) — the Claude-side source
          // of the dispatching tool_use id (ADR-033 M3). Missing/non-string →
          // undefined; the dispatcher gates every subagent/task emit on its
          // presence and never fails a dispatch over it.
          const toolUseId = extra?.meta?.['claudecode/toolUseId']
          const callId = typeof toolUseId === 'string' ? toolUseId : undefined
          // Only a call that may run in the background needs to know the caller (a wait of up to
          // 250 ms on a call whose frame has not been seen yet): an unspecified one takes the
          // default from it, and a subagent's explicit one is told its report goes to the root.
          const owner =
            run_in_background !== false && callId && ctx.callOwner
              ? await ctx.callOwner(callId)
              : undefined
          const callerIsRoot = owner === 'root'
          const background = runsInBackground(run_in_background, callerIsRoot, callId)
          const result = await crossEngineDispatcher.dispatch(
            {
              engine,
              prompt,
              model,
              name,
              description,
              ...(background ? { runInBackground: true } : {}),
              ...(background && owner === 'subagent' ? { fromSubagent: true } : {})
            },
            {
              fromEngine: ctx.engineId,
              fromRoutingId: ctx.getRoutingId(),
              cwd: ctx.cwd,
              getAutonomyMode: ctx.getAutonomyMode,
              getMessages: ctx.getMessages,
              ...(ctx.getQueuedUserTurns ? { getQueuedUserTurns: ctx.getQueuedUserTurns } : {}),
              ...(ctx.blockedCalls ? { blockedCalls: ctx.blockedCalls } : {}),
              emit: ctx.emit,
              addDispatchedCost: ctx.addDispatchedCost,
              toolUseId: callId,
              extra
            }
          )
          const text =
            result.isError || !result.agentRef
              ? result.text
              : `${result.text}${dispatchResultSuffix(result.agentRef)}`
          return {
            content: [{ type: 'text' as const, text }],
            ...(result.isError ? { isError: true } : {})
          }
        },
        { passthrough: true }
      )
    ]
  })
}
