/**
 * The live-session channels — ONE declaration, both transports.
 *
 * Everything that acts on a session or the session manager: lifecycle (`create`, `rekey`,
 * `send`, `cancel`, `interrupt`, approvals), background tasks, the per-session config verbs,
 * session grouping / proposals / context-pressure, the transcript watch, and deleting or
 * clearing conversations. `session.ipc.ts` spreads `sessionCommands(manager, 'desktop')`,
 * `remote-handlers.ts` spreads `sessionCommands(manager, 'remote')`.
 *
 * Two per-transport facts:
 *  - the desktop envelopes `session:delete-session` / `session:delete-project`
 *    (`{ ok, data }`); the WebSocket answers them bare — hence `transport` / `envelopeFor`;
 *  - optional arguments go through `opt()` where the remote handler always did: the web
 *    client's JSON marshalling turns an omitted trailing argument into `null`
 *    (`wire-args.ts`); on the desktop `opt` is inert.
 *
 * Not here: `session:pick-folder` and `voice:start-recording` / `voice:stop-recording`
 * (host-physical, desktop only), and the remote-only `voice:start` / `voice:stop`.
 */

import type { SessionManager } from '../services/session-manager'
import { getHostWindow } from '../services/host-window'
import { respondContextPressure } from '../services/context-pressure'
import { setSessionGrouped } from '../services/session-links'
import { dismissProposalFromClient, startProposalFromClient } from '../services/session-tools'
import { watchSession, unwatchSession } from '../services/session-watcher'
import { crossEngineDispatcher } from '../services/cross-engine-dispatcher'
import type {
  ApprovalDecision,
  AttachmentUpload,
  PermissionSuggestion,
  EngineId
} from '../../shared/types'
import type { CommandConnection, CommandRegistration, Transport } from './command-registry'
import { prepareAndCreateSession, type CreateSessionArgs } from './create-session'
import { answerApproval } from './approval-response'
import { envelopeFor } from './safe-handler'
import { opt } from './wire-args'
import {
  sendPrompt,
  watchBackground,
  unwatchBackground,
  readBackgroundRange,
  stopTask,
  backgroundTask,
  allowPeerMessages,
  dequeueMessage,
  recallQueued,
  askSideQuestion,
  setPermissionMode,
  setEffort,
  setThinkingMode,
  setModel,
  setReasoningVariant,
  rekeyShim,
  getPlanContent,
  getSessionLogPath,
  deleteSession,
  deleteProject,
  clearConversation,
  approveBlocked
} from './handlers-core'

export function sessionCommands(
  manager: SessionManager,
  transport: Transport
): Array<Omit<CommandRegistration, 'transport'>> {
  const env = envelopeFor(transport)
  return [
    {
      channel: 'session:create',
      capability: 'chat',
      kind: 'command',
      sessionIdArg: 0,
      handler: async (
        routingId: string,
        cwd: string,
        effort?: string | null,
        resumeSessionId?: string | null,
        permissionMode?: string | null,
        model?: string | null,
        thinkingMode?: string | null,
        resumeSessionAt?: string | null,
        forkSession?: boolean | null,
        engineId?: EngineId | null,
        announce?: CreateSessionArgs['announce'] | null
      ) => {
        // Every optional argument through `opt` — see its doc comment. `effort`
        // is the one that broke in the field; the rest are the same shape and
        // reach the same `!== undefined` / `?: T` consumers.
        await prepareAndCreateSession(manager, getHostWindow(), {
          routingId,
          cwd,
          effort: opt(effort),
          resumeSessionId: opt(resumeSessionId),
          permissionMode: opt(permissionMode),
          model: opt(model),
          thinkingMode: opt(thinkingMode),
          resumeSessionAt: opt(resumeSessionAt),
          forkSession: opt(forkSession),
          engineId: opt(engineId),
          announce: opt(announce)
        })
      }
    },
    {
      channel: 'session:rekey',
      capability: 'chat',
      kind: 'command',
      sessionIdArg: 0,
      handler: async (oldId: string, newId: string) => {
        rekeyShim(manager, oldId, newId)
      }
    },
    {
      channel: 'session:send',
      capability: 'chat',
      kind: 'command',
      sessionIdArg: 0,
      handler: async (routingId: string, prompt: string, attachments?: AttachmentUpload[] | null) =>
        sendPrompt(manager, routingId, prompt, opt(attachments))
    },
    {
      channel: 'session:cancel',
      capability: 'chat',
      kind: 'command',
      sessionIdArg: 0,
      handler: async (routingId: string) => {
        manager.cancel(routingId)
      }
    },
    {
      channel: 'session:interrupt',
      capability: 'chat',
      kind: 'command',
      sessionIdArg: 0,
      handler: async (routingId: string) => {
        await manager.interrupt(routingId)
      }
    },
    {
      channel: 'session:approval-response',
      capability: 'chat',
      kind: 'command',
      sessionIdArg: 0,
      handler: async (
        routingId: string,
        requestId: string,
        decision: ApprovalDecision,
        answers?: Record<string, string>,
        updatedPermissions?: PermissionSuggestion[]
      ) => {
        // Routing (`xeng:` dispatch cards vs the session) and the cross-client dismiss: approval-response.ts.
        answerApproval(manager, routingId, requestId, decision, answers, updatedPermissions)
      }
    },
    // ADR-091 part 6 — gated exactly like the approval it extends: a `chat`
    // command on the session it names.
    {
      channel: 'session:approve-blocked',
      capability: 'chat',
      kind: 'command',
      sessionIdArg: 0,
      handler: async (routingId: string, toolUseId: string) =>
        approveBlocked(manager, routingId, toolUseId)
    },
    {
      channel: 'session:watch-background',
      capability: 'chat',
      kind: 'query',
      sessionIdArg: 0,
      handler: async (routingId: string, toolUseId: string) =>
        watchBackground(manager, routingId, toolUseId)
    },
    {
      channel: 'session:unwatch-background',
      capability: 'chat',
      kind: 'query',
      sessionIdArg: 0,
      handler: async (routingId: string, toolUseId: string) =>
        unwatchBackground(manager, routingId, toolUseId)
    },
    {
      channel: 'session:read-background-range',
      capability: 'fs-read',
      kind: 'query',
      sessionIdArg: 0,
      handler: async (routingId: string, toolUseId: string, offset: number, length: number) =>
        readBackgroundRange(manager, routingId, toolUseId, offset, length)
    },
    {
      channel: 'session:stop-task',
      capability: 'chat',
      kind: 'command',
      sessionIdArg: 0,
      handler: async (routingId: string, toolUseId: string, isDispatch?: boolean) => {
        // A cross-engine dispatch card's toolUseId isn't gated on the dispatching
        // session's own backgroundTasks capability — route to the dispatcher
        // FIRST (ADR-033 M3), same precedent as the xeng: approval-response
        // routing above. routingId scopes the stop to the OWNING session.
        if (isDispatch) {
          // The renderer KNOWS this is a dispatch card: arm a durable stop-intent
          // when the dispatch hasn't registered yet (the Stop click can beat the
          // MCP tools/call round-trip), and NEVER fall through to the session
          // path — its "Provider does not support background tasks" error was
          // this race's misleading symptom.
          crossEngineDispatcher.stopDispatch(toolUseId, routingId, { armIfUnknown: true })
          return { success: true }
        }
        // Not marked: try the dispatcher without arming, fall through to the
        // session's own stopTask when it's not a known dispatch id.
        if (crossEngineDispatcher.stopDispatch(toolUseId, routingId)) return { success: true }
        return stopTask(manager, routingId, toolUseId)
      }
    },
    {
      channel: 'session:background-task',
      capability: 'chat',
      kind: 'command',
      sessionIdArg: 0,
      handler: async (routingId: string, toolUseId: string) =>
        backgroundTask(manager, routingId, toolUseId)
    },
    {
      channel: 'session:recall-queued',
      capability: 'chat',
      kind: 'command',
      sessionIdArg: 0,
      handler: async (routingId: string) => recallQueued(manager, routingId)
    },
    {
      channel: 'session:allow-peer-messages',
      capability: 'chat',
      kind: 'command',
      sessionIdArg: 0,
      handler: async (routingId: string) => allowPeerMessages(manager, routingId)
    },
    // "Detach from group" / "Add to group" in the sidebar (slice 1b, reworked in slice 5).
    // `routingId` is the row's own session, so the audit row names the session the user
    // acted on.
    {
      channel: 'session:link:set-grouped',
      capability: 'chat',
      kind: 'command',
      sessionIdArg: 0,
      handler: async (routingId: string, grouped: boolean) => setSessionGrouped(routingId, grouped)
    },
    // The user's click on a proposal card (session tools, slice 1c-b). The argument is
    // the proposal's id, not a session id; the audit row for the click is the registry's.
    // `grouped` is which Start button was clicked; anything but a boolean (an older client) falls back
    // to the proposal's own relation.
    {
      channel: 'session:proposal:start',
      capability: 'chat',
      kind: 'command',
      // The click's audit row carries the calling connection, so it needs it first.
      withConnection: true,
      handler: async (connection: CommandConnection, proposalId: string, grouped?: boolean) =>
        startProposalFromClient(proposalId, grouped, connection)
    },
    {
      channel: 'session:proposal:dismiss',
      capability: 'chat',
      kind: 'command',
      withConnection: true,
      handler: async (connection: CommandConnection, proposalId: string) =>
        dismissProposalFromClient(proposalId, connection)
    },
    // The user's answer to the context-pressure banner (slice 4): Hand off or Not now.
    {
      channel: 'session:context-pressure:respond',
      capability: 'chat',
      kind: 'command',
      sessionIdArg: 0,
      handler: async (routingId: string, answer: string) =>
        respondContextPressure(routingId, answer)
    },
    // Deprecated (ADR-053): recall-all shim for cached `/remote` bundles.
    {
      channel: 'session:dequeue-message',
      capability: 'chat',
      kind: 'command',
      sessionIdArg: 0,
      handler: async (routingId: string, value: string) => dequeueMessage(manager, routingId, value)
    },
    {
      channel: 'session:ask-side-question',
      capability: 'chat',
      kind: 'command',
      sessionIdArg: 0,
      handler: async (routingId: string, question: string) =>
        askSideQuestion(manager, routingId, question)
    },
    {
      channel: 'session:set-permission-mode',
      capability: 'session-config',
      kind: 'command',
      sessionIdArg: 0,
      handler: async (routingId: string, mode: string) =>
        setPermissionMode(manager, routingId, mode)
    },
    {
      channel: 'session:set-model',
      capability: 'session-config',
      kind: 'command',
      sessionIdArg: 0,
      handler: async (routingId: string, model: string) => setModel(manager, routingId, model)
    },
    {
      channel: 'session:set-effort',
      capability: 'session-config',
      kind: 'command',
      sessionIdArg: 0,
      handler: async (routingId: string, effort: string) => setEffort(manager, routingId, effort)
    },
    // `null` is a MEANINGFUL value here ("clear it"), so no `opt()`.
    {
      channel: 'session:set-reasoning-variant',
      capability: 'session-config',
      kind: 'command',
      sessionIdArg: 0,
      handler: async (routingId: string, variant: string | null) =>
        setReasoningVariant(manager, routingId, variant)
    },
    {
      channel: 'session:set-thinking-mode',
      capability: 'session-config',
      kind: 'command',
      sessionIdArg: 0,
      handler: async (routingId: string, mode: string) => setThinkingMode(manager, routingId, mode)
    },
    // `chat`, not `config`, since ADR-056 (the review sync-core.md §Follow-ons
    // asked for, resolved). Deleting a session or a project removes CONVERSATIONS
    // — the same material `chat` already governs reading and writing — and calling
    // that "configuration" put the destructive verb in the bundle a client holds
    // for saving UI preferences. One declaration now, so the registry can no longer
    // see the two transports disagree.
    {
      channel: 'session:delete-session',
      capability: 'chat',
      kind: 'command',
      handler: env(async (sessionId: string, projectKey: string, engineId?: EngineId | null) => {
        await deleteSession(manager, sessionId, projectKey, opt(engineId))
      })
    },
    {
      channel: 'session:delete-project',
      capability: 'chat',
      kind: 'command',
      handler: env(async (projectKey: string) => {
        await deleteProject(manager, projectKey)
      })
    },
    {
      channel: 'session:clear-conversation',
      capability: 'chat',
      kind: 'command',
      sessionIdArg: 0,
      handler: async (routingId: string, permissionMode?: string | null) => {
        await clearConversation(manager, routingId, opt(permissionMode))
      }
    },
    {
      channel: 'session:get-plan-content',
      capability: 'chat',
      kind: 'query',
      sessionIdArg: 0,
      handler: async (routingId: string) => getPlanContent(manager, routingId)
    },
    {
      channel: 'session:get-session-log-path',
      capability: 'chat',
      kind: 'query',
      sessionIdArg: 0,
      handler: async (routingId: string) => getSessionLogPath(manager, routingId)
    },
    // Live transcript watching (drives a client's live history view).
    {
      channel: 'session:watch-session',
      capability: 'fs-read',
      kind: 'query',
      sessionIdArg: 0,
      handler: async (
        routingId: string,
        sessionId: string,
        projectKey: string,
        cwd?: string | null
      ) => {
        watchSession(routingId, sessionId, projectKey, opt(cwd))
      }
    },
    {
      channel: 'session:unwatch-session',
      capability: 'fs-read',
      kind: 'query',
      sessionIdArg: 0,
      handler: async (routingId: string) => {
        unwatchSession(routingId)
      }
    }
  ]
}
