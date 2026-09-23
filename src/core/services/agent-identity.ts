/**
 * Agent identity recovered from a parent transcript (ADR-073 §5).
 *
 * `ClaudeSession` normalizes every run of an agent onto the tool_use id that
 * spawned it, using maps it learns from `task_started`. Those maps live in
 * memory, but an agent outlives the process that spawned it: after the parent
 * cli.js process is killed and the session `--resume`s, cli.js
 *
 *  - reaps each agent that was mid-run with a terminal `task_notification`
 *    carrying the `task_id` and NO `tool_use_id`, before `system/init`; and
 *  - resumes an agent on `SendMessage{to: <agent id>}` with a `task_started`
 *    under the SendMessage call's id — while the resumed child's completed
 *    messages still carry the ORIGINAL Agent call's id from the dead process.
 *
 * (Probed against 2.1.280, 2026-09-23 — `docs/protocol-cc/04-system-subtypes.md`
 * §4.5.) A session that has forgotten the agent can attribute neither: the
 * reap lands on no card, so an agent spawned with `run_in_background: true`
 * reads "running" forever, and the resume arms a SendMessage card nothing
 * renders as a task, so the agent's own card reads "complete" while its output
 * streams into it. The transcript still holds everything needed to rebuild
 * the maps, and this module is the one reader of it.
 */
import * as fs from 'fs'
import * as readline from 'readline'
import { extractToolResultContent } from './tool-result-content'

/** An agent id in a spawn tool's result text: `agentId: a1b2…` (also TaskOutput-era `agent_id:`). */
export const AGENT_ID_RE = /(?:agentId|agent_id):\s*(\S+)/

/** The agent id in a spawn tool's result text, if there is one. */
export function agentIdOf(resultText: string): string | undefined {
  return resultText.match(AGENT_ID_RE)?.[1]
}

export interface AgentIdentity {
  /** task id → the tool_use id of the call that spawned the agent. First one wins. */
  origins: Map<string, string>
  /** A resuming call's tool_use id (a SendMessage) → the agent's origin tool_use id. */
  runAliases: Map<string, string>
  /** origin tool_use id → runs the transcript shows: the spawn plus one per resume. */
  runCounts: Map<string, number>
}

export function emptyAgentIdentity(): AgentIdentity {
  return { origins: new Map(), runAliases: new Map(), runCounts: new Map() }
}

/** One `tool_result` as the transcript records it. */
export interface TranscriptToolResult {
  toolUseId: string
  text: string
  /** The line's structured `toolUseResult`, when cli.js wrote one. */
  structured?: Record<string, unknown>
}

/**
 * Fold tool results, in transcript order, into agent identity.
 *
 * A spawn is recognized by the structured `agentId` cli.js records on the
 * Agent/Task result, or failing that by the same `agentId:` text the live path
 * (`ClaudeSession.detectTaskMapping`) matches. A resume is a result carrying
 * `resumedAgentId` — SendMessage's reply when it restarts a finished agent.
 * A SendMessage to a RUNNING agent answers "queued" with no `resumedAgentId`
 * and starts no run, which is also how the live counter sees it.
 */
export function foldAgentIdentity(results: Iterable<TranscriptToolResult>): AgentIdentity {
  const identity = emptyAgentIdentity()
  for (const { toolUseId, text, structured } of results) {
    const resumed = stringField(structured, 'resumedAgentId') ?? resumedAgentIdOf(text)
    if (resumed) {
      const origin = identity.origins.get(resumed)
      // A resume of an agent spawned before this transcript begins (a fork
      // anchor, a compacted head) has no origin to attach to — skip it rather
      // than invent one.
      if (origin && toolUseId !== origin && !identity.runAliases.has(toolUseId)) {
        identity.runAliases.set(toolUseId, origin)
        identity.runCounts.set(origin, (identity.runCounts.get(origin) ?? 1) + 1)
      }
      continue
    }
    const agentId = stringField(structured, 'agentId') ?? agentIdOf(text)
    if (agentId && !identity.origins.has(agentId)) {
      identity.origins.set(agentId, toolUseId)
      identity.runCounts.set(toolUseId, 1)
    }
  }
  return identity
}

/**
 * Read a parent transcript's agent identity. Best-effort: a missing or
 * unreadable file yields an empty identity, never a throw — the session then
 * behaves exactly as it did before this seed existed.
 */
export function readAgentIdentity(transcriptPath: string): Promise<AgentIdentity> {
  return new Promise((resolve) => {
    const results: TranscriptToolResult[] = []
    let stream: fs.ReadStream
    try {
      stream = fs.createReadStream(transcriptPath, { encoding: 'utf-8' })
    } catch {
      resolve(emptyAgentIdentity())
      return
    }
    const rl = readline.createInterface({ input: stream })
    // readline re-emits the stream's error (ENOENT for a transcript that was
    // never written) on the interface; left unhandled it is an uncaught
    // exception in the main process.
    rl.on('error', () => resolve(emptyAgentIdentity()))
    rl.on('line', (line) => {
      // Cheap prefilter: transcripts run to tens of MB and only spawn/resume
      // results matter.
      if (!line.includes('tool_result')) return
      if (!line.includes('gentId') && !line.includes('agent_id')) return
      try {
        collectToolResults(JSON.parse(line), results)
      } catch {
        // A torn or malformed line is skipped, as every other transcript reader does.
      }
    })
    rl.on('close', () => resolve(foldAgentIdentity(results)))
  })
}

function collectToolResults(line: unknown, into: TranscriptToolResult[]): void {
  if (!isRecord(line) || line.type !== 'user' || line.isSidechain === true) return
  const message = line.message
  if (!isRecord(message) || !Array.isArray(message.content)) return
  const structured = isRecord(line.toolUseResult) ? line.toolUseResult : undefined
  for (const block of message.content) {
    if (!isRecord(block) || block.type !== 'tool_result') continue
    if (typeof block.tool_use_id !== 'string' || !block.tool_use_id) continue
    into.push({
      toolUseId: block.tool_use_id,
      text: extractToolResultContent(block.content).text,
      structured
    })
  }
}

const RESUMED_AGENT_ID_RE = /"resumedAgentId"\s*:\s*"([^"]+)"/

function resumedAgentIdOf(resultText: string): string | undefined {
  return resultText.match(RESUMED_AGENT_ID_RE)?.[1]
}

function stringField(obj: Record<string, unknown> | undefined, key: string): string | undefined {
  const v = obj?.[key]
  return typeof v === 'string' && v ? v : undefined
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}
