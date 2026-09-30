/**
 * PROBE — what does a NESTED (depth-2) background agent look like on the wire and on disk?
 *
 * Run: PROBE_MODEL=claude-haiku-4-5-20251001 PROBE_DIR=<scratch dir> node scripts/probe-nested-agents.mjs
 *
 * Needs the vendored binary (`vendor/claude-cli/`); spends real tokens (three short agent
 * runs). Companion to `probe-agent-respawn.mjs` / `probe-agent-resume.mjs`. Feeds ADR-073 §7
 * (nested agents in the roster) and protocol-cc 04 §4.5.
 *
 *   main   spawns background agent A ("probenesta")
 *   A      spawns background agent B ("probenestb"), then runs one foreground Bash that
 *          outlives the 2 s registration threshold, and one run_in_background Bash
 *   B      runs a short foreground Bash and returns
 *
 * The process is kept alive until B's terminal task_notification has arrived and the stream
 * has gone quiet, so late idle self-resumes of A are captured too.
 *
 * What to read in the output:
 *   1. B's task_started: spawn_depth, tool_use_id (A's Agent call for B?), task_id;
 *   2. which parent_tool_use_id / agent_id B's assistant, user and stream_event frames carry;
 *   3. whether A's Agent tool_use for B arrives as a frame owned by A's origin id;
 *   4. B's terminal task_notification (top level? which tool_use_id?) and where the
 *      <task-notification> user text lands: A's transcript or main's;
 *   5. the on-disk layout under <session>/subagents/ (B's .jsonl and .meta.json);
 *   6. A's foreground (>2 s) and run_in_background Bash: task_started fields, and whether their
 *      tool_use arrives in A's bucket with run_in_background intact.
 *
 * Every raw frame is written to <PROBE_DIR>/probe-nested-agents.jsonl; the scratch cwd is
 * <PROBE_DIR>/cwd. Neither is the repo. The session transcript lands wherever cli.js keeps
 * projects (CLAUDE_CONFIG_DIR, else the home config dir); the summary prints its path.
 */
import {
  appendFileSync,
  writeFileSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  existsSync
} from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'

// Mirror ClaudeUI's spawn env (src/core/sdk/args.ts buildSpawnEnv): the app entrypoint and the
// checklist tools. Must be set before the helper spawns.
process.env.CLAUDEUI_TEST_ENTRYPOINT = 'claude-desktop'
process.env.CLAUDE_CODE_ENABLE_TODO_TOOLS ??= 'true'
const { createStreamingQuery } = await import('../patch/test-helpers.mjs')

const DIR = process.env.PROBE_DIR || join(tmpdir(), 'probe-nested-agents')
const CWD = join(DIR, 'cwd')
mkdirSync(CWD, { recursive: true })
const OUT = join(DIR, 'probe-nested-agents.jsonl')
writeFileSync(OUT, '')
const MODEL = process.env.PROBE_MODEL
const NAME_A = 'probenesta'
const NAME_B = 'probenestb'

const t0 = Date.now()
const frames = []
const line = (k, d) =>
  console.log(`${String((Date.now() - t0) / 1000).padStart(7)}s  ${k.padEnd(26)} ${d}`)

const owner = (m) => `ptu=${m.parent_tool_use_id ?? '-'}${m.agent_id ? ` aid=${m.agent_id}` : ''}`

function log(m) {
  if (m.type === 'stream_event') {
    const e = m.event ?? {}
    // Only block starts and message boundaries; deltas are in the raw file.
    if (e.type === 'content_block_start')
      line(
        'stream/block_start',
        `${owner(m)} ${e.content_block?.type}${e.content_block?.type === 'tool_use' ? ` ${e.content_block.id} ${e.content_block.name}` : ''}`
      )
    else if (e.type === 'message_start') line('stream/message_start', owner(m))
    return
  }
  if (m.type === 'system') {
    if (String(m.subtype).startsWith('task_')) {
      line(
        `system/${m.subtype}`,
        `task_id=${m.task_id} tuid=${m.tool_use_id ?? '-'} ${m.task_type ?? ''} ${m.status ?? ''} depth=${m.spawn_depth ?? '-'} bg=${m.is_backgrounded ?? '-'} owned=${m.owned_by_subagent ?? '-'} ${owner(m)}${m.patch ? ' ' + JSON.stringify(m.patch) : ''}`
      )
    } else if (!['status', 'thinking_tokens'].includes(m.subtype))
      line(`system/${m.subtype}`, owner(m))
    return
  }
  if (m.type === 'assistant') {
    for (const b of m.message?.content ?? []) {
      if (b.type === 'tool_use')
        line(
          'assistant/tool_use',
          `${owner(m)} ${b.id} ${b.name} ${JSON.stringify(b.input).slice(0, 110)}`
        )
      else if (b.type === 'text' && b.text.trim())
        line('assistant/text', `${owner(m)} ${JSON.stringify(b.text.slice(0, 70))}`)
    }
    return
  }
  if (m.type === 'user') {
    const c = m.message?.content
    if (Array.isArray(c)) {
      for (const b of c) {
        if (b.type === 'tool_result') {
          const text = Array.isArray(b.content)
            ? b.content.map((x) => x.text ?? '').join('')
            : String(b.content ?? '')
          line(
            'user/tool_result',
            `${owner(m)} ${b.tool_use_id} ${JSON.stringify(text.slice(0, 90))}`
          )
        } else if (b.type === 'text')
          line('user/text', `${owner(m)} ${JSON.stringify(b.text.slice(0, 110))}`)
      }
    } else if (typeof c === 'string')
      line('user/string', `${owner(m)} ${JSON.stringify(c.slice(0, 110))}`)
    return
  }
  if (m.type === 'result') line('result', `${m.subtype} ${owner(m)}`)
}

const PROMPT_B = `Use the Bash tool to run exactly: sleep 5; echo done (foreground, NOT in background). Then reply with exactly the word DONEB. Do not spawn agents.`
const PROMPT_A = [
  `Do these steps in order, each as its own tool call, and say nothing else:`,
  `1. Call the Agent tool with EXACTLY: name "${NAME_B}", subagent_type "general-purpose", description "probe nested b", run_in_background true, prompt ${JSON.stringify(PROMPT_B)}`,
  `2. Call the Bash tool with EXACTLY: command "sleep 4; echo fg", run_in_background false.`,
  `3. Call the Bash tool with EXACTLY: command "sleep 8; echo bg", run_in_background true.`,
  `4. Reply with exactly the word DONEA. Do not wait for anything.`,
  `When later told that a task finished, reply with exactly the word NOTED and use no tools.`
].join('\n')
const PROMPT_MAIN = `Call the Agent tool with EXACTLY: name "${NAME_A}", subagent_type "general-purpose", description "probe nested a", run_in_background true, prompt ${JSON.stringify(PROMPT_A)}\nSay nothing else. When later told that a task finished, reply with exactly the word NOTED and use no tools.`

let sid = null
const { q, cleanup } = createStreamingQuery(
  PROMPT_MAIN,
  {
    cwd: CWD,
    persistSession: true,
    extraArgs: ['--forward-subagent-text'],
    ...(MODEL ? { model: MODEL } : {})
  },
  600_000
)

// Stop once B's terminal notification is in AND the stream has been quiet for a while
// (A may be idle-resumed by B's or its bg shell's notification after that).
let bTaskId = null
let bDone = false
let quiet = null
const armQuiet = () => {
  clearTimeout(quiet)
  if (bDone) quiet = setTimeout(() => cleanup(), 40_000)
}
try {
  for await (const m of q) {
    if (!m || typeof m !== 'object') continue
    if (m.session_id && !sid) sid = m.session_id
    frames.push(m)
    appendFileSync(OUT, JSON.stringify({ t: Date.now() - t0, m }) + '\n')
    log(m)
    if (
      m.type === 'system' &&
      m.subtype === 'task_started' &&
      m.task_type === 'local_agent' &&
      m.spawn_depth === 2
    )
      bTaskId = m.task_id
    if (
      m.type === 'system' &&
      m.subtype === 'task_notification' &&
      bTaskId &&
      m.task_id === bTaskId
    )
      bDone = true
    armQuiet()
  }
} finally {
  clearTimeout(quiet)
  cleanup()
}

// ---- summary ----------------------------------------------------------------
console.log(`\n==== session ${sid}\nraw frames: ${OUT}\nscratch cwd: ${CWD}`)
const trim = (o) =>
  JSON.stringify(o, (k, v) => (typeof v === 'string' && v.length > 160 ? v.slice(0, 160) + '…' : v))

const taskFrames = frames.filter(
  (m) => m.type === 'system' && String(m.subtype).startsWith('task_')
)
console.log('\n-- every task_* frame')
for (const m of taskFrames) console.log(trim(m))

// Who owns what: distinct (type, parent_tool_use_id, agent_id) triples.
const owners = new Map()
for (const m of frames) {
  if (!['assistant', 'user', 'stream_event'].includes(m.type)) continue
  const key = `${m.type} ptu=${m.parent_tool_use_id ?? '-'} aid=${m.agent_id ?? '-'}`
  owners.set(key, (owners.get(key) ?? 0) + 1)
}
console.log('\n-- frame owners (type, parent_tool_use_id, agent_id) → count')
for (const [k, n] of owners) console.log(`${k}  x${n}`)

// On-disk layout.
const configDir = process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude')
const projects = join(configDir, 'projects')
let sessionDir = null
if (sid && existsSync(projects)) {
  for (const p of readdirSync(projects)) {
    if (existsSync(join(projects, p, `${sid}.jsonl`))) {
      sessionDir = join(projects, p, sid)
      console.log(`\n-- transcript: ${join(projects, p, `${sid}.jsonl`)}`)
      break
    }
  }
}
if (sessionDir && existsSync(join(sessionDir, 'subagents'))) {
  const sub = join(sessionDir, 'subagents')
  console.log(`-- ${sub}`)
  for (const f of readdirSync(sub, { recursive: true })) console.log(`   ${f}`)
  for (const f of readdirSync(sub).filter((f) => f.endsWith('.meta.json')))
    console.log(`   ${f}: ${readFileSync(join(sub, f), 'utf8').trim()}`)
  // Where did each <task-notification> text land?
  const files = [
    join(sessionDir, '..', `${sid}.jsonl`),
    ...readdirSync(sub)
      .filter((f) => f.endsWith('.jsonl'))
      .map((f) => join(sub, f))
  ]
  console.log('\n-- <task-notification> texts per transcript file')
  for (const f of files) {
    const hits = readFileSync(f, 'utf8')
      .split('\n')
      .filter((l) => l.includes('<task-notification>'))
      .map((l) => {
        const tid = /<task-id>([^<]*)</.exec(l)?.[1]
        const tu = /<tool-use-id>([^<]*)</.exec(l)?.[1]
        const st = /<status>([^<]*)</.exec(l)?.[1]
        return `task-id=${tid} tool-use-id=${tu ?? '-'} status=${st}`
      })
    console.log(
      `   ${f.split(/[\\/]/).slice(-2).join('/')}: ${hits.length ? '\n      ' + hits.join('\n      ') : 'none'}`
    )
  }
} else console.log('\n-- no subagents dir found')
