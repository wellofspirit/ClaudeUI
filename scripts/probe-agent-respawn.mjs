/**
 * PROBE — what happens to an agent when the PARENT process dies mid-run?
 *
 * Run: PROBE_MODEL=claude-haiku-4-5-20251001 node scripts/probe-agent-respawn.mjs
 *
 * Needs the vendored binary (`vendor/claude-cli/`); spends real tokens (a short agent
 * run plus two short turns). Companion to `probe-agent-resume.mjs`, which covers a resume
 * inside one process.
 *
 *   process 1  spawn a named agent that sleeps, then kill the parent while it is mid-run
 *              (what ClaudeUI's cancel() does: the user's Stop, the idle reaper, an
 *              account switch)
 *   process 2  --resume the session, then SendMessage the orphaned agent BY ID
 *
 * What to read in the output (2.1.280, 2026-09-23 — protocol-cc §4.5, ADR-073 §5):
 *   - p2 opens with a task_notification for the orphan: its task_id, status=stopped,
 *     and NO tool_use_id — before system/init;
 *   - the resume is a task_started under the SendMessage call's id;
 *   - the resumed child's completed messages carry the ORIGINAL Agent id from p1.
 * If the reap starts carrying a tool_use_id, or the child stops hanging off the
 * original id, the transcript identity seed in `core/services/agent-identity.ts`
 * is built on a fact that has moved.
 */
import { appendFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createStreamingQuery, userMessage } from '../patch/test-helpers.mjs'

// Temp dirs, not the repo: the session this persists and the raw log are one run's evidence.
const CWD = join(tmpdir(), 'probe-agent-respawn-cwd')
mkdirSync(CWD, { recursive: true })
const OUT = join(tmpdir(), 'probe-agent-respawn.jsonl')
writeFileSync(OUT, '')
const MODEL = process.env.PROBE_MODEL
const NAME = 'probedelta'

const t0 = Date.now()
const rec = (proc, k, d, raw) => {
  console.log(`${String((Date.now() - t0) / 1000).padStart(7)}s  [p${proc}] ${k.padEnd(24)} ${d}`)
  appendFileSync(OUT, JSON.stringify({ t: Date.now() - t0, proc, k, d, raw }) + '\n')
}

function log(proc, m, st) {
  if (m.parent_tool_use_id) {
    if (m.type === 'assistant') {
      const txt = (m.message?.content ?? [])
        .map((b) => (b.type === 'text' ? b.text : b.type === 'tool_use' ? `<${b.name}>` : ''))
        .join('')
        .slice(0, 40)
      rec(proc, 'child/assistant', `parent=${m.parent_tool_use_id} ${JSON.stringify(txt)}`)
      st.childSeen = true
    }
    return
  }
  if (m.type === 'system') {
    if (String(m.subtype).startsWith('task_')) {
      rec(
        proc,
        `system/${m.subtype}`,
        `task_id=${m.task_id} tuid=${m.tool_use_id ?? '-'} ${m.task_type ?? ''} ${m.status ?? ''} ${m.patch ? JSON.stringify(m.patch) : ''}`,
        m
      )
      if (m.subtype === 'task_started') st.started++
      if (m.subtype === 'task_notification') st.notifs++
    } else if (!['status', 'thinking_tokens'].includes(m.subtype))
      rec(proc, `system/${m.subtype}`, '')
  } else if (m.type === 'assistant') {
    for (const b of m.message?.content ?? []) {
      if (b.type === 'tool_use')
        rec(proc, 'tool_use', `${b.id} ${b.name} ${JSON.stringify(b.input).slice(0, 90)}`)
      if (b.type === 'text' && b.text.trim()) rec(proc, 'text', JSON.stringify(b.text.slice(0, 80)))
    }
  } else if (m.type === 'user') {
    const c = m.message?.content
    if (Array.isArray(c)) {
      for (const b of c) {
        if (b.type === 'tool_result') {
          const text = Array.isArray(b.content)
            ? b.content.map((x) => x.text ?? '').join('')
            : String(b.content ?? '')
          rec(proc, 'tool_result', `${b.tool_use_id} ${JSON.stringify(text.slice(0, 150))}`)
        }
      }
    } else if (typeof c === 'string') rec(proc, 'user/string', JSON.stringify(c.slice(0, 150)))
  } else if (m.type === 'result') rec(proc, 'result', `notifs=${st.notifs}`)
}

// ---- process 1: spawn a long agent, kill the parent mid-run -----------------
let sid = null
let agentId = null
{
  const { q, cleanup } = createStreamingQuery(
    `Call the Agent tool with EXACTLY: name "${NAME}", subagent_type "general-purpose", description "probe kill", prompt "Use the Bash tool to run exactly: sleep 40 (foreground, NOT in background). Then reply with exactly the word ONE." Say nothing else.`,
    { cwd: CWD, persistSession: true, ...(MODEL ? { model: MODEL } : {}) },
    300_000
  )
  const st = { started: 0, notifs: 0, childSeen: false }
  let killTimer = null
  try {
    for await (const m of q) {
      if (!m || typeof m !== 'object') continue
      if (m.session_id && !sid) sid = m.session_id
      if (m.type === 'system' && m.subtype === 'task_started' && m.task_type === 'local_agent')
        agentId = m.task_id
      log(1, m, st)
      // Kill once the child is demonstrably mid-run (it has issued its Bash call).
      if (st.childSeen && !killTimer)
        killTimer = setTimeout(() => {
          rec(1, '=== KILL', '')
          cleanup()
        }, 6000)
    }
  } finally {
    clearTimeout(killTimer)
    cleanup()
  }
}
rec(1, '=== EXITED', `session=${sid} agent=${agentId}`)
await new Promise((r) => setTimeout(r, 4000))

// ---- process 2: --resume, idle a while, then SendMessage the orphan by id ------
{
  const { q, channel, cleanup } = createStreamingQuery(
    'Reply with exactly the word READY and nothing else. Do not use any tools.',
    { cwd: CWD, persistSession: true, resume: sid, ...(MODEL ? { model: MODEL } : {}) },
    300_000
  )
  const st = { started: 0, notifs: 0, childSeen: false }
  let phase = 'startup'
  let quiet = null
  const arm = (ms) => {
    clearTimeout(quiet)
    quiet = setTimeout(() => cleanup(), ms)
  }
  try {
    for await (const m of q) {
      if (!m || typeof m !== 'object') continue
      log(2, m, st)
      if (m.type === 'result') {
        if (phase === 'startup') {
          phase = 'resume'
          rec(2, '>>> PUSH', 'SendMessage prompt')
          channel.push(
            userMessage(
              `SendMessage is a deferred tool: call ToolSearch "select:SendMessage" first, then SendMessage to "${agentId}" with message "Reply with exactly the word TWO. Do not use any tools." Do not spawn agents. Say nothing else.`
            )
          )
        }
        arm(45_000)
      }
    }
  } finally {
    clearTimeout(quiet)
    cleanup()
  }
}
console.log(`\nraw: ${OUT}`)
