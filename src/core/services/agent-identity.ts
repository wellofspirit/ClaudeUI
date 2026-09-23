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

/** Identity plus where each agent's last run stands — needs the terminal events too. */
export interface AgentLifecycle extends AgentIdentity {
  /**
   * Agents whose latest run the transcript shows starting — an async spawn or
   * a resume — and never ending. That is an agent that was still working when
   * its process died: nothing will ever report it finished, and cli.js only
   * reaps it if the session is resumed.
   */
  unfinished: Set<string>
  /**
   * The run each terminal event ends (1-based, the live counter's numbering),
   * keyed by the event object the caller passed in — so a reader can stamp
   * `runIndex` on the notification it built from that event.
   */
  closedRun: Map<TranscriptTerminal, number>
}

export function emptyAgentIdentity(): AgentIdentity {
  return { origins: new Map(), runAliases: new Map(), runCounts: new Map() }
}

/** One `tool_result` as the transcript records it. */
export interface TranscriptToolResult {
  kind: 'result'
  toolUseId: string
  text: string
  /** The line's structured `toolUseResult`, when cli.js wrote one. */
  structured?: Record<string, unknown>
}

/** A `<task-notification>` the transcript records: one run of a task reached a terminal state. */
export interface TranscriptTerminal {
  kind: 'terminal'
  taskId: string
  /**
   * The `<tool-use-id>` of the run it ends, when the XML carries one. The reap
   * of an orphaned agent on `--resume` carries none — it ends whatever run is
   * current.
   */
  runToolUseId?: string
}

export type TranscriptAgentEvent = TranscriptToolResult | TranscriptTerminal

/**
 * Fold a transcript's agent events, in order, into agent identity.
 *
 * A spawn is recognized by the structured `agentId` cli.js records on the
 * Agent/Task result, or failing that by the same `agentId:` text the live path
 * (`ClaudeSession.detectTaskMapping`) matches. A resume is a result carrying
 * `resumedAgentId` — SendMessage's reply when it restarts a finished agent.
 * A SendMessage to a RUNNING agent answers "queued" with no `resumedAgentId`
 * and starts no run, which is also how the live counter sees it.
 *
 * A FOREGROUND spawn's result is the agent's final answer, so that run ends
 * with its own result; only an async launch or a resume opens a run that a
 * terminal event has to close. (Runs cli.js restarts on its own — a queued
 * message, the agent's background Bash finishing — leave no tool result and
 * are invisible here.)
 */
export function foldAgentIdentity(events: Iterable<TranscriptAgentEvent>): AgentLifecycle {
  const identity: AgentLifecycle = {
    ...emptyAgentIdentity(),
    unfinished: new Set(),
    closedRun: new Map()
  }
  /** task id → the tool_use id of the run most recently started. */
  const currentRun = new Map<string, string>()
  /** A run's tool_use id → its 1-based index. cli.js's own restarts reuse the id, as live. */
  const runIndexOf = new Map<string, number>()
  for (const event of events) {
    if (event.kind === 'terminal') {
      const current = currentRun.get(event.taskId)
      const ends = event.runToolUseId ?? current
      const index = ends !== undefined ? runIndexOf.get(ends) : undefined
      if (index !== undefined) identity.closedRun.set(event, index)
      // A notification for an EARLIER run (consumed by the parent after the
      // next run began) must not close the current one.
      if (event.runToolUseId && current !== event.runToolUseId) continue
      identity.unfinished.delete(event.taskId)
      continue
    }
    const { toolUseId, text, structured } = event
    const resumed = stringField(structured, 'resumedAgentId') ?? resumedAgentIdOf(text)
    if (resumed) {
      const origin = identity.origins.get(resumed)
      // A resume of an agent spawned before this transcript begins (a fork
      // anchor, a compacted head) has no origin to attach to — skip it rather
      // than invent one.
      if (origin && toolUseId !== origin && !identity.runAliases.has(toolUseId)) {
        identity.runAliases.set(toolUseId, origin)
        const runs = (identity.runCounts.get(origin) ?? 1) + 1
        identity.runCounts.set(origin, runs)
        runIndexOf.set(toolUseId, runs)
        currentRun.set(resumed, toolUseId)
        identity.unfinished.add(resumed)
      }
      continue
    }
    const agentId = stringField(structured, 'agentId') ?? agentIdOf(text)
    if (agentId && !identity.origins.has(agentId)) {
      identity.origins.set(agentId, toolUseId)
      identity.runCounts.set(toolUseId, 1)
      runIndexOf.set(toolUseId, 1)
      currentRun.set(agentId, toolUseId)
      if (isAsyncLaunch(text, structured)) identity.unfinished.add(agentId)
    }
  }
  return identity
}

function isAsyncLaunch(text: string, structured: Record<string, unknown> | undefined): boolean {
  return (
    structured?.isAsync === true ||
    structured?.status === 'async_launched' ||
    text.startsWith('Async agent launched')
  )
}

/**
 * Read a parent transcript's agent identity — who spawned each agent and how
 * many runs it has had. Terminal events are not read (the prefilter skips
 * them), so this answers identity only, never whether a run finished.
 * Best-effort: a missing or unreadable file yields an empty identity, never a
 * throw — the session then behaves exactly as it did before this seed existed.
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
    rl.on('close', () => {
      const { origins, runAliases, runCounts } = foldAgentIdentity(results)
      resolve({ origins, runAliases, runCounts })
    })
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
      kind: 'result',
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
