/**
 * @vitest-environment node
 *
 * Agent identity read back from a parent transcript (ADR-073 §5).
 *
 * The line shapes are the ones cli.js 2.1.280 wrote for
 * `scripts/probe-agent-resume.mjs`'s kill-and-resume run: the Agent result
 * carries a structured `toolUseResult.agentId` next to the `agentId:` text, and
 * a SendMessage that restarts a finished agent answers with `resumedAgentId`.
 */
import { describe, it, expect, afterEach } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { foldAgentIdentity, readAgentIdentity } from '../agent-identity'

const AGENT = 'acb38d350312a25c3'
const ORIGIN = 'toolu_019e8GsqnZqS8mnY21TC4ohu' // the Agent call
const RESUME_1 = 'toolu_017A1U8QZCKgnQsc6tk5snTD' // SendMessage that restarted it
const RESUME_2 = 'toolu_01Resume2xxxxxxxxxxxxxxx'

const SPAWN_TEXT =
  'Async agent launched successfully. (This tool result is internal metadata.)\n' +
  `agentId: ${AGENT} (internal ID - do not mention to user. Use SendMessage with to: '${AGENT}')\n` +
  'The agent is working in the background.'

const resumeText = (agentId: string): string =>
  JSON.stringify({
    success: true,
    message: `Resuming agent ${agentId.slice(0, 7)}`,
    resumedAgentId: agentId,
    pin: { id: agentId, name: agentId, ref: '463e09' }
  })

const QUEUED_TEXT = JSON.stringify({
  success: true,
  message: 'Message queued for delivery to probedelta at its next tool round.',
  pin: { id: AGENT, name: 'probedelta', ref: '43f278' }
})

/** A transcript `user` line holding one tool_result, as cli.js writes it. */
function resultLine(
  toolUseId: string,
  text: string,
  toolUseResult?: Record<string, unknown>,
  extra: Record<string, unknown> = {}
): string {
  return JSON.stringify({
    type: 'user',
    isSidechain: false,
    message: {
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: toolUseId, content: text }]
    },
    ...(toolUseResult ? { toolUseResult } : {}),
    ...extra
  })
}

const tempDirs: string[] = []
afterEach(() => {
  for (const d of tempDirs.splice(0)) fs.rmSync(d, { recursive: true, force: true })
})

function writeTranscript(lines: string[]): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-identity-'))
  tempDirs.push(dir)
  const file = path.join(dir, 'session.jsonl')
  fs.writeFileSync(file, lines.join('\n') + '\n')
  return file
}

describe('foldAgentIdentity', () => {
  it('maps an agent to the call that spawned it and counts each resume as a run', () => {
    const identity = foldAgentIdentity([
      { kind: 'result', toolUseId: ORIGIN, text: SPAWN_TEXT },
      { kind: 'result', toolUseId: RESUME_1, text: resumeText(AGENT) },
      { kind: 'result', toolUseId: RESUME_2, text: resumeText(AGENT) }
    ])
    expect(identity.origins.get(AGENT)).toBe(ORIGIN)
    expect(identity.runAliases.get(RESUME_1)).toBe(ORIGIN)
    expect(identity.runAliases.get(RESUME_2)).toBe(ORIGIN)
    expect(identity.runCounts.get(ORIGIN)).toBe(3)
  })

  it('does not count a message queued to a running agent as a run', () => {
    // cli.js starts no new run for it, and the live counter does not count it.
    const identity = foldAgentIdentity([
      { kind: 'result', toolUseId: ORIGIN, text: SPAWN_TEXT },
      { kind: 'result', toolUseId: RESUME_1, text: QUEUED_TEXT }
    ])
    expect(identity.runCounts.get(ORIGIN)).toBe(1)
    expect(identity.runAliases.size).toBe(0)
  })

  it('keeps the FIRST call that named an agent as its origin', () => {
    const identity = foldAgentIdentity([
      { kind: 'result', toolUseId: ORIGIN, text: SPAWN_TEXT },
      { kind: 'result', toolUseId: 'toolu_later_output_check', text: `agent_id: ${AGENT}` }
    ])
    expect(identity.origins.get(AGENT)).toBe(ORIGIN)
  })

  it('prefers the structured result over the text', () => {
    const identity = foldAgentIdentity([
      {
        kind: 'result',
        toolUseId: ORIGIN,
        text: 'no id in this text',
        structured: { agentId: AGENT }
      },
      { kind: 'result', toolUseId: RESUME_1, text: '', structured: { resumedAgentId: AGENT } }
    ])
    expect(identity.origins.get(AGENT)).toBe(ORIGIN)
    expect(identity.runCounts.get(ORIGIN)).toBe(2)
  })

  it('ignores a resume of an agent whose spawn the transcript does not hold', () => {
    const identity = foldAgentIdentity([
      { kind: 'result', toolUseId: RESUME_1, text: resumeText(AGENT) }
    ])
    expect(identity.origins.size).toBe(0)
    expect(identity.runAliases.size).toBe(0)
    expect(identity.runCounts.size).toBe(0)
  })
})

describe('foldAgentIdentity — runs the transcript never closes', () => {
  const spawn = { kind: 'result', toolUseId: ORIGIN, text: SPAWN_TEXT } as const
  const resume = { kind: 'result', toolUseId: RESUME_1, text: resumeText(AGENT) } as const
  const ended = (runToolUseId?: string) =>
    ({ kind: 'terminal', taskId: AGENT, runToolUseId }) as const

  it('an async spawn with no terminal event is unfinished', () => {
    expect(foldAgentIdentity([spawn]).unfinished).toEqual(new Set([AGENT]))
  })

  it("the run's own terminal event closes it", () => {
    expect(foldAgentIdentity([spawn, ended(ORIGIN)]).unfinished.size).toBe(0)
  })

  it('a resume re-opens it, and only that run’s end closes it again', () => {
    expect(foldAgentIdentity([spawn, ended(ORIGIN), resume]).unfinished).toEqual(new Set([AGENT]))
    expect(foldAgentIdentity([spawn, ended(ORIGIN), resume, ended(RESUME_1)]).unfinished.size).toBe(
      0
    )
  })

  it('a late notification for an EARLIER run does not close the current one', () => {
    // Run 1's XML consumed by the parent after the SendMessage started run 2.
    expect(foldAgentIdentity([spawn, resume, ended(ORIGIN)]).unfinished).toEqual(new Set([AGENT]))
  })

  it('the --resume reap (no tool-use-id) closes whatever run is current', () => {
    expect(foldAgentIdentity([spawn, resume, ended()]).unfinished.size).toBe(0)
  })

  it('a foreground spawn ends with its own result', () => {
    const foreground = {
      kind: 'result',
      toolUseId: ORIGIN,
      text: 'The answer is 42.',
      structured: { status: 'completed', agentId: AGENT }
    } as const
    expect(foldAgentIdentity([foreground]).unfinished.size).toBe(0)
  })
})

describe('readAgentIdentity', () => {
  it('reads spawns and resumes from a transcript on disk', async () => {
    const file = writeTranscript([
      JSON.stringify({ type: 'queue-operation', operation: 'enqueue' }),
      resultLine(ORIGIN, SPAWN_TEXT, { isAsync: true, status: 'async_launched', agentId: AGENT }),
      // Passes the prefilter, fails JSON.parse — a torn write mid-line.
      '{"type":"user","message":{"content":[{"type":"tool_result","content":"agentId: torn',
      resultLine(RESUME_1, resumeText(AGENT), { success: true, resumedAgentId: AGENT }),
      resultLine('toolu_unrelated', 'total 3 files', { stdout: 'x' })
    ])
    const identity = await readAgentIdentity(file)
    expect(identity.origins.get(AGENT)).toBe(ORIGIN)
    expect(identity.runAliases.get(RESUME_1)).toBe(ORIGIN)
    expect(identity.runCounts.get(ORIGIN)).toBe(2)
  })

  it("skips a subagent's own (sidechain) lines", () => {
    const file = writeTranscript([
      resultLine('toolu_child_spawn', `agentId: nested-agent`, undefined, { isSidechain: true })
    ])
    return expect(readAgentIdentity(file)).resolves.toMatchObject({ origins: new Map() })
  })

  it('yields an empty identity for a missing transcript instead of throwing', async () => {
    const identity = await readAgentIdentity(path.join(os.tmpdir(), 'no-such-dir', 'x.jsonl'))
    expect(identity.origins.size).toBe(0)
  })
})
