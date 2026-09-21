/**
 * PROBE — what does cli.js emit when a COMPLETED agent is resumed via SendMessage?
 *
 * Run: node scripts/probe-agent-resume.mjs
 *
 * Needs the vendored binary (`vendor/claude-cli/`, gitignored) — in a fresh worktree run
 * `bun run ensure-cli` first, or run the probe from a checkout that already has it.
 * It spends real tokens: two short turns plus a two-run agent.
 *
 * The finding this produced is documented in docs/protocol-cc/04-system-subtypes.md §4.5
 * ("A RESUMED agent emits a second task_started") and is the evidence behind ADR-073.
 * Re-run it after a `claudeCliVersion` bump: if a resume stops re-emitting `task_started`,
 * or starts reusing the original `tool_use_id`, the lifecycle normalization in
 * ClaudeSession (originByTaskId + the run alias) is built on a fact that has moved.
 *
 * What it does:
 *   turn 1  make the model spawn a NAMED background agent; wait for its terminal notification
 *   turn 2  make the model SendMessage that agent; record every task_* event that follows
 *
 * What to read in the output:
 *   - is there a task_started in the [resume] phase at all?
 *   - is its task_id the SAME as run 1's, and its tool_use_id DIFFERENT?
 *   - which tool_use_id do the child's stream_event partials vs its completed
 *     assistant message hang off? (2.1.268: partials → the SendMessage call,
 *     the completed message → the original Agent call.)
 *
 * Gotcha: SendMessage is a DEFERRED tool — the model must ToolSearch for its schema
 * first. The prompt says so, and the probe's quiet-window logic allows for the extra
 * turn; a probe that stops at the first `result` cuts the run off mid-search.
 */

import { writeFileSync, appendFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createStreamingQuery, userMessage } from '../patch/test-helpers.mjs'

// Temp dir, not the repo: the raw log is evidence for one run, not an artifact.
const OUT = join(tmpdir(), 'probe-agent-resume.jsonl')
writeFileSync(OUT, '')

const AGENT_NAME = 'proberalpha'

const SPAWN_PROMPT = `You MUST use the Agent tool (also known as the Task tool) right now. Do NOT answer directly and do NOT use any other tool first.

Call it with EXACTLY these parameters:
- name: "${AGENT_NAME}"
- subagent_type: "general-purpose"
- description: "probe one"
- prompt: "Reply with exactly the word ONE. Do not use any tools."

After the tool call, say nothing else.`

const RESUME_PROMPT = `SendMessage is a deferred tool: first call ToolSearch with query "select:SendMessage" to load its schema, then use SendMessage immediately.

Use SendMessage to send a message to the agent named "${AGENT_NAME}".

Call it with EXACTLY these parameters:
- to: "${AGENT_NAME}"
- message: "Reply with exactly the word TWO. Do not use any tools."

Do NOT spawn a new agent. Do NOT use the Agent tool. Only SendMessage.`

const t0 = Date.now()
const log = []
const at = () => `${String((Date.now() - t0) / 1000).padStart(6, ' ')}s`

function record(kind, detail, raw) {
  const line = `${at()}  ${kind.padEnd(26)} ${detail}`
  log.push(line)
  console.log(line)
  appendFileSync(OUT, JSON.stringify({ tMs: Date.now() - t0, kind, detail, raw }) + '\n')
}

const { q, channel, cleanup } = createStreamingQuery(SPAWN_PROMPT, {}, 300_000)

let phase = 'spawn'
let notificationsSeen = 0
let resumeSent = false
let sawResultAfterResume = false
let sendMessageSeen = false
let stopTimer = null

try {
  for await (const msg of q) {
    if (!msg || typeof msg !== 'object') continue

    // Which run does the subagent's OWN output hang off? The renderer keys
    // subagentMessages/itemStreams by parent tool_use id, so this decides
    // whether run 2's transcript lands on the Agent card or the SendMessage one.
    if (msg.parent_tool_use_id) {
      const text = (msg.message?.content ?? [])
        .filter((b) => b.type === 'text')
        .map((b) => b.text)
        .join(' ')
        .slice(0, 50)
      record(
        `child/${msg.type}`,
        `[${phase}] parent=${msg.parent_tool_use_id} ${JSON.stringify(text)}`,
        null
      )
    }

    if (msg.type === 'system' && typeof msg.subtype === 'string') {
      if (msg.subtype.startsWith('task_')) {
        const bits = [
          `task_id=${msg.task_id ?? '-'}`,
          `tool_use_id=${msg.tool_use_id ?? '-'}`,
          msg.task_type ? `task_type=${msg.task_type}` : null,
          msg.status ? `status=${msg.status}` : null,
          msg.patch ? `patch=${JSON.stringify(msg.patch)}` : null,
          msg.description ? `desc=${JSON.stringify(String(msg.description).slice(0, 40))}` : null
        ].filter(Boolean)
        record(`system/${msg.subtype}`, `[${phase}] ${bits.join(' ')}`, msg)

        if (msg.subtype === 'task_notification') {
          notificationsSeen++
          // First terminal notification = the agent finished its first run. The
          // resume goes out on the next result boundary: a terminal notification
          // for an auto-continuing type makes cli.js continue the turn on its
          // own, and pushing input mid-turn would race it.
          if (notificationsSeen === 1) phase = 'awaiting-resume-window'
        }
      } else if (msg.subtype === 'init') {
        record('system/init', `[${phase}] session=${String(msg.session_id).slice(0, 8)}`, null)
      }
      continue
    }

    if (msg.type === 'assistant') {
      for (const b of msg.message?.content ?? []) {
        if (b.type === 'tool_use') {
          record(
            'assistant/tool_use',
            `[${phase}] ${b.name} ${JSON.stringify(b.input).slice(0, 120)}`,
            b
          )
          if (b.name === 'SendMessage') {
            sendMessageSeen = true
            // The resume itself is what we came to watch: hold the stream open
            // long enough for the agent's second run to start AND finish.
            clearTimeout(stopTimer)
            stopTimer = setTimeout(() => cleanup(), 90_000)
          }
        }
      }
      continue
    }

    if (msg.type === 'result') {
      record('result', `[${phase}] subtype=${msg.subtype} turns=${msg.num_turns ?? '-'}`, null)
      if (!resumeSent && notificationsSeen >= 1) {
        resumeSent = true
        phase = 'resume'
        record('>>> PUSH', 'sending the SendMessage prompt', null)
        channel.push(userMessage(RESUME_PROMPT))
      } else if (resumeSent) {
        sawResultAfterResume = true
        // Don't stop on a result: SendMessage is deferred, so the model spends a
        // turn on ToolSearch first, and the resumed agent's run lands in a later
        // auto-continued turn. Only a quiet window ends the probe.
        if (!sendMessageSeen) {
          clearTimeout(stopTimer)
          stopTimer = setTimeout(() => cleanup(), 45_000)
        }
      }
    }
  }
} catch (err) {
  record('ERROR', String(err?.message ?? err), null)
} finally {
  clearTimeout(stopTimer)
  cleanup()
}

const resumePhase = log.filter((l) => l.includes('[resume]'))
const countIn = (needle) => resumePhase.filter((l) => l.includes(needle)).length

console.log('\n' + '='.repeat(72))
console.log('  VERDICT')
console.log('='.repeat(72))
console.log(
  `  after the resume: task_started=${countIn('task_started')} ` +
    `task_updated=${countIn('task_updated')} task_notification=${countIn('task_notification')}`
)
console.log(`  total task_notification seen: ${notificationsSeen}`)
console.log(`  reached a result after resume: ${sawResultAfterResume}`)
console.log('\n  EXPECTED (2.1.268): 1 / 1 / 1, same task_id as run 1, a DIFFERENT tool_use_id.')
console.log(`\n  raw log: ${OUT}`)
