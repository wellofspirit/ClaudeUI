/**
 * The session listing, transcript-history and folder-browser reads — ONE declaration, both
 * transports. All `fs-read` queries except `blob:get` (`chat`). `opt()` is applied where the
 * remote handler always did (the web client's JSON marshalling turns an omitted trailing
 * argument into `null`, see `wire-args.ts`); on the desktop it is inert.
 */

import { readSessionHistory as loadSessionHistory, historyFor } from '../services/engine-history'
import {
  loadSessionStatusLine,
  loadSubagentHistory,
  buildSubagentFileMap,
  loadBackgroundOutput
} from '../services/session-history'
import { assertSafePathSegment } from '../services/path-containment'
import { listAllDirectories } from '../services/sync-seed'
import {
  listOpencodeSessionsGlobal,
  loadOpencodeSessionHistory
} from '../services/opencode-session-list'
import { listPiSessionsGlobal, loadPiSessionHistory } from '../services/pi-session-list'
import { withDispatchTasks } from '../services/dispatch-task-history'
import type { EngineId, LoadSessionHistoryOptions } from '../../shared/types'
import type { ProgressReporter } from '../../shared/remote-protocol'
import type { CommandRegistration } from './command-registry'
import { opt } from './wire-args'
import { getBlob, listDirEntries, listPlaces } from './handlers-core'

export function sessionHistoryCommands(): Array<Omit<CommandRegistration, 'transport'>> {
  return [
    // Resolve the fork ("branch off") anchor, engine-dispatched — Claude by
    // messageId (JSONL line uuid), pi by messageIndex (position, no stable id).
    // Used by the renderer before creating the branch.
    {
      channel: 'session:resolve-fork-anchor',
      capability: 'fs-read',
      kind: 'query',
      handler: async (
        sessionId: string,
        cwd: string,
        messageId: string,
        engineId: EngineId,
        messageIndex: number
      ) => {
        return await historyFor(engineId).forkAnchor(sessionId, cwd, messageId, messageIndex)
      }
    },
    {
      channel: 'session:list-directories',
      capability: 'fs-read',
      kind: 'query',
      handler: async () => {
        // The MERGED listing (claude + opencode + pi), so a cold query and the
        // replicated `session:directories-changed` payload are the same value —
        // they used to be the claude-only subset and a per-client merge.
        return await listAllDirectories()
      }
    },
    // Multi-engine session listing + history (opencode + pi) for the sidebar.
    {
      channel: 'session:list-opencode',
      capability: 'fs-read',
      kind: 'query',
      handler: async () => {
        // The sidebar's open/focus nudge (ADR-097 §6, S9): answered from the
        // cached listing at once; a stale one is refreshed in the background.
        return await listOpencodeSessionsGlobal({ interaction: true })
      }
    },
    {
      channel: 'session:load-opencode-history',
      capability: 'fs-read',
      kind: 'query',
      handler: async (sessionId: string) => {
        return withDispatchTasks(sessionId, await loadOpencodeSessionHistory(sessionId))
      }
    },
    {
      channel: 'session:list-pi',
      capability: 'fs-read',
      kind: 'query',
      handler: async () => {
        return await listPiSessionsGlobal()
      }
    },
    {
      channel: 'session:load-pi-history',
      capability: 'fs-read',
      kind: 'query',
      handler: async (sessionId: string) => {
        return withDispatchTasks(sessionId, await loadPiSessionHistory(sessionId))
      }
    },
    // Folder browser (the web client's picker; the desktop's file tree)
    {
      channel: 'file:list-dir',
      capability: 'fs-read',
      kind: 'query',
      handler: async (dirPath: string) => listDirEntries(dirPath)
    },
    {
      channel: 'file:list-places',
      capability: 'fs-read',
      kind: 'query',
      handler: async () => listPlaces()
    },
    {
      channel: 'session:load-history',
      capability: 'fs-read',
      kind: 'query',
      // ADR-102: the reporter leads the args; a caller that sends none gets a no-op
      // (the wire frames come from remote-server).
      withProgress: true,
      handler: async (
        progress: ProgressReporter,
        sessionId: string,
        projectKey: string,
        resumeSessionAt?: string | null,
        options?: LoadSessionHistoryOptions | null
      ) => {
        // Both identifiers are caller-supplied and joined into a ~/.claude/projects path
        // by the Claude reader. Every engine's real id and projectKey is a single
        // segment (uuid / `ses_…` ids; `cwdToProjectKey` is `[A-Za-z0-9-]*`), so one
        // check serves the engine dispatch too.
        assertSafePathSegment(sessionId, 'sessionId')
        assertSafePathSegment(projectKey, 'projectKey')
        return await loadSessionHistory(sessionId, projectKey, opt(resumeSessionAt), undefined, {
          onProgress: progress,
          // Strictly a literal `true`: any other shape of the (client-supplied) options is ignored.
          deferStatusLine: options?.deferStatusLine === true
        })
      }
    },
    // The status line a `deferStatusLine` read left out (ADR-102 Arc 2): same
    // result as the full read's, own progress plan (M + S, phase `costs`).
    {
      channel: 'session:load-status-line',
      capability: 'fs-read',
      kind: 'query',
      withProgress: true,
      handler: async (progress: ProgressReporter, sessionId: string, projectKey: string) => {
        assertSafePathSegment(sessionId, 'sessionId')
        assertSafePathSegment(projectKey, 'projectKey')
        return await loadSessionStatusLine(sessionId, projectKey, progress)
      }
    },
    {
      channel: 'session:load-subagent-history',
      capability: 'fs-read',
      kind: 'query',
      // Declared so a remote call gets the transport's `sending` frame (it slides
      // the client's 30 s timeout while a large bucket transfers); reports nothing itself.
      withProgress: true,
      handler: async (
        _progress: ProgressReporter,
        sessionId: string,
        projectKey: string,
        agentId: string
      ) => {
        assertSafePathSegment(sessionId, 'sessionId')
        assertSafePathSegment(projectKey, 'projectKey')
        assertSafePathSegment(agentId, 'agentId')
        return await loadSubagentHistory(sessionId, projectKey, agentId)
      }
    },
    // The bytes behind a transcript BlobRef (ADR-087). `chat`, not `fs-read`: a
    // `chat` grant already read these exact bytes inside the snapshot, and the
    // store is not the filesystem — it holds only what a transcript carried. An invoke
    // on purpose, not an HTTP route: on an E2E origin the bytes stay inside the
    // encrypted channel.
    {
      channel: 'blob:get',
      capability: 'chat',
      kind: 'query',
      handler: async (blobId: string) => getBlob(blobId)
    },
    {
      channel: 'session:build-subagent-file-map',
      capability: 'fs-read',
      kind: 'query',
      handler: async (
        sessionId: string,
        projectKey: string,
        taskPrompts: Record<string, string>
      ) => {
        return buildSubagentFileMap(sessionId, projectKey, taskPrompts)
      }
    },
    {
      channel: 'session:load-background-output',
      capability: 'fs-read',
      kind: 'query',
      handler: async (projectKey: string, taskId: string, outputFile?: string | null) => {
        return loadBackgroundOutput(projectKey, taskId, opt(outputFile))
      }
    }
  ]
}
