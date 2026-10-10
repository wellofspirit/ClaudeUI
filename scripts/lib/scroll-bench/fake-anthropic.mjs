// A local, scripted Anthropic Messages endpoint for the chat-scroll bench's deterministic
// streaming scenario (S4). The app points cli.js at it through its own custom-endpoint support
// (`vendors/anthropic.json` -> `applyEndpointEnv` -> ANTHROPIC_BASE_URL / ANTHROPIC_AUTH_TOKEN on
// the spawn), so the real harness, the real stream-json pipeline and the real renderer run; only
// the model is fake. The tools it asks for are EXECUTED FOR REAL by cli.js in the scratch cwd.
//
// Stateless by design: every /v1/messages request carries the whole conversation, so the next step
// is derived from it. A bench prompt carries a `[[bench-turn K]]` tag; the number of tool_result
// rounds since that prompt is the step index into turn K's seeded plan. A subagent's prompt carries
// `[[bench-subagent]]` and gets a short plan of its own. Anything else (title generation, side
// queries) gets one short text reply.
//
// Tool names and input shapes are taken from the request's own `tools` array, so a tool the
// harness does not offer (e.g. TodoWrite when the Task* family replaces it) is substituted or
// skipped rather than called blind.
import { createServer } from 'node:http'
import { prng } from './transcript-gen.mjs'
import { sleep } from './common.mjs'

const LOREM = (
  'the scroller pins to the bottom while a turn streams and each tool card grows as its output ' +
  'arrives so the view must follow the true end of the content without drifting or jumping back ' +
  'layout settles after placeholder swaps and the anchor keeps the reading position stable'
).split(' ')

function words(r, n) {
  const out = []
  for (let i = 0; i < n; i++) out.push(LOREM[Math.floor(r() * LOREM.length)])
  return out.join(' ')
}

function markdown(r, paras) {
  const parts = []
  for (let i = 0; i < paras; i++) {
    parts.push(`### Step ${i + 1}: ${words(r, 4)}`)
    parts.push(words(r, 40 + Math.floor(r() * 60)) + '.')
    if (r() < 0.5)
      parts.push(
        Array.from({ length: 3 + Math.floor(r() * 4) }, () => `- ${words(r, 8)}`).join('\n')
      )
    if (r() < 0.4)
      parts.push(
        '```ts\n' +
          Array.from(
            { length: 4 + Math.floor(r() * 16) },
            (_, k) => `const value${k} = compute(${Math.floor(r() * 100)}) // ${words(r, 3)}`
          ).join('\n') +
          '\n```'
      )
  }
  return parts.join('\n\n')
}

/** Fill an input object from a JSON schema's required properties (fallback for unknown tools). */
function fromSchema(schema, r) {
  const out = {}
  for (const key of schema?.required ?? []) {
    const p = schema.properties?.[key] ?? {}
    if (p.enum) out[key] = p.enum[0]
    else if (p.type === 'string') out[key] = words(r, 5)
    else if (p.type === 'number' || p.type === 'integer') out[key] = 1
    else if (p.type === 'boolean') out[key] = false
    else if (p.type === 'array') out[key] = []
    else out[key] = {}
  }
  return out
}

/**
 * The plan for one bench turn: `steps` assistant messages; every one but the last calls tools.
 * `ctx.files` are absolute paths of the big files the bench seeded in the cwd; `ctx.cwd` the cwd.
 */
export function turnPlan(turn, ctx) {
  const r = prng(1000 + turn * 7919)
  const steps = ctx.stepsPerTurn
  const plan = []
  const read = new Set()
  const order = ['Bash', 'Read', 'Grep', 'Edit', 'Bash', 'Glob', 'Todo', 'Read', 'Write', 'Bash']
  for (let s = 0; s < steps - 1; s++) {
    const kind = s === Math.floor(steps / 2) && ctx.subagent ? 'Agent' : order[s % order.length]
    const file = ctx.files[(turn + s) % ctx.files.length]
    const step = { thinking: r() < 0.5 ? words(r, 30 + Math.floor(r() * 80)) : null, text: null }
    if (r() < 0.6) step.text = words(r, 10 + Math.floor(r() * 30)) + '.'
    if (kind === 'Edit' && !read.has(file)) {
      step.tools = [{ kind: 'Read', file }]
      read.add(file)
    } else {
      step.tools = [{ kind, file, n: 80 + Math.floor(r() * 400), k: turn * 100 + s }]
      if (kind === 'Read') read.add(file)
    }
    plan.push(step)
  }
  plan.push({
    thinking: r() < 0.4 ? words(r, 60) : null,
    text: markdown(r, 3 + Math.floor(r() * 4))
  })
  return plan
}

function subagentPlan(ctx) {
  const r = prng(4242)
  return [
    { text: 'Looking around.', tools: [{ kind: 'Glob' }] },
    { text: null, tools: [{ kind: 'Bash', n: 60 }] },
    { text: markdown(r, 2) }
  ].map((s) => ({ thinking: null, ...s, ctx }))
}

/**
 * A LONG background subagent: rounds of streamed thinking/text + a tool, then a final report.
 * `gradual` (S7): each Bash prints a line every ~30 ms, so it runs for seconds with live output.
 * Dense (S6): Bash prints at once and the next round streams right away, so text keeps
 * streaming into the chat for minutes.
 */
function longSubagentPlan(ctx, gradual) {
  const r = prng(5151)
  const plan = []
  const rounds = gradual ? ctx.bgSteps : ctx.bgSteps * 3
  for (let s = 0; s < rounds; s++)
    plan.push({
      thinking: s % 2 === 0 ? words(r, 60 + Math.floor(r() * 60)) : null,
      text: words(r, 60 + Math.floor(r() * 80)) + '.',
      tools: [
        s % 5 === 4
          ? { kind: 'Read', file: ctx.files[s % ctx.files.length] }
          : s % 4 === 3
            ? { kind: 'Grep' }
            : { kind: gradual ? 'BashSlow' : 'Bash', n: 60 + Math.floor(r() * 200) }
      ]
    })
  plan.push({ thinking: null, text: markdown(r, 3) })
  return plan
}

/** The main turn that launches a background subagent and then goes idle (S6). */
function bgTurnPlan(gradual) {
  return [
    {
      thinking: null,
      text: 'Starting a background survey.',
      tools: [{ kind: 'AgentBg', gradual }]
    },
    { thinking: null, text: 'The survey runs in the background; I will report when it finishes.' }
  ]
}

/** Turn an abstract tool step into a concrete tool_use for the tools this request offers. */
function concreteTool(t, ctx, offered, r) {
  const has = (n) => offered.has(n)
  switch (t.kind) {
    case 'Bash':
      return {
        name: 'Bash',
        input: {
          command: `for i in $(seq 1 ${t.n ?? 120}); do echo "row $i ${words(r, 6)}"; done`,
          description: 'Print a long listing'
        }
      }
    case 'BashSlow':
      return {
        name: 'Bash',
        input: {
          // Printed GRADUALLY (a line every 30 ms), so the harness streams it as live Bash output
          // while the call runs — the case where only the bash-output store changes, not `msgs`.
          command: `for i in $(seq 1 ${t.n ?? 40}); do echo "scan $i ${words(r, 5)}"; sleep 0.03; done; sleep ${ctx.bgSleep}`,
          description: 'Scan a batch'
        }
      }
    case 'Read':
      return { name: 'Read', input: { file_path: t.file } }
    case 'Grep':
      return has('Grep')
        ? { name: 'Grep', input: { pattern: 'compute', path: ctx.cwd, output_mode: 'content' } }
        : { name: 'Bash', input: { command: `grep -rn compute .`, description: 'Search' } }
    case 'Glob':
      return has('Glob')
        ? { name: 'Glob', input: { pattern: '**/*.ts', path: ctx.cwd } }
        : { name: 'Bash', input: { command: 'ls -la', description: 'List files' } }
    case 'Edit':
      return {
        name: 'Edit',
        input: {
          file_path: t.file,
          old_string: `// edit-slot ${t.k % ctx.slotsPerFile}\n`,
          new_string: `// edit-slot ${t.k % ctx.slotsPerFile} done (${t.k})\n${words(r, 12)
            .split(' ')
            .map((w) => `// ${w}`)
            .join('\n')}\n`
        }
      }
    case 'Write':
      return {
        name: 'Write',
        input: {
          file_path: `${ctx.cwd}/out-${t.k}.md`,
          content: markdown(r, 2)
        }
      }
    case 'Todo': {
      if (has('TodoWrite'))
        return {
          name: 'TodoWrite',
          input: {
            todos: Array.from({ length: 5 }, (_, i) => ({
              content: `Task ${i + 1}: ${words(r, 4)}`,
              status: i < 2 ? 'completed' : i === 2 ? 'in_progress' : 'pending',
              activeForm: `Working on ${words(r, 3)}`
            }))
          }
        }
      if (has('TaskCreate'))
        return {
          name: 'TaskCreate',
          input: fromSchema(ctx.schemas.get('TaskCreate'), r)
        }
      return null
    }
    case 'Agent':
    case 'AgentBg': {
      const name = has('Agent') ? 'Agent' : has('Task') ? 'Task' : null
      if (!name) return null
      const bg = t.kind === 'AgentBg'
      return {
        name,
        input: {
          description: bg ? 'Long background survey' : 'Survey the files',
          prompt: bg
            ? `[[bench-subagent ${t.gradual ? 'longbash' : 'long'}]] Scan the files batch by batch and report.`
            : '[[bench-subagent]] List the files and summarise them briefly.',
          subagent_type: 'general-purpose',
          ...(bg ? { run_in_background: true } : {})
        }
      }
    }
  }
  return null
}

function textOf(content) {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .filter((b) => b.type === 'text')
    .map((b) => b.text)
    .join('\n')
}

/** Text of a user message, minus cli.js's injected `<system-reminder>` blocks. */
function promptText(content) {
  return textOf(content)
    .replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '')
    .trim()
}

/**
 * Where in which plan this request is: walk back over the tool_result rounds to the prompt that
 * opened this loop. A tagged prompt selects a plan; an untagged one (a `<task-notification>`
 * delivery, a title request) is a side request.
 */
function locate(body) {
  const msgs = body.messages ?? []
  let rounds = 0
  for (let i = msgs.length - 1; i >= 0; i--) {
    const m = msgs[i]
    if (m.role !== 'user') continue
    const hasResult = Array.isArray(m.content) && m.content.some((b) => b.type === 'tool_result')
    const text = promptText(m.content)
    const turn = /\[\[bench-turn (\d+)\]\]/.exec(text)
    const bg = /\[\[bench-bg(bash)? (\d+)\]\]/.exec(text)
    const sub = /\[\[bench-subagent( longbash| long)?\]\]/.exec(text)
    if (turn) return { kind: 'turn', turn: Number(turn[1]), step: rounds }
    if (bg) return { kind: 'bg', gradual: !!bg[1], turn: Number(bg[2]), step: rounds }
    if (sub)
      return {
        kind: sub[1] ? 'sublong' : 'sub',
        gradual: sub[1] === ' longbash',
        turn: 0,
        step: rounds
      }
    if (hasResult) {
      rounds++
      continue
    }
    // An untagged prompt — including one that is ALL system-reminder (a task-notification
    // delivery) — opens no plan.
    if (text || textOf(m.content).trim()) return { kind: 'side' }
  }
  return { kind: 'side' }
}

/**
 * @param {object} o
 * @param {string} o.cwd        scratch cwd the tools run in
 * @param {string[]} o.files    absolute paths of seeded files (Read/Edit targets)
 * @param {number} [o.stepsPerTurn]
 * @param {number} [o.cps]      streamed characters per second
 * @param {boolean} [o.subagent]
 * @param {(line: string) => void} [o.log]
 */
export async function startFakeAnthropic(o) {
  const ctx = {
    cwd: o.cwd.replace(/\\/g, '/'),
    files: o.files.map((f) => f.replace(/\\/g, '/')),
    stepsPerTurn: o.stepsPerTurn ?? 24,
    slotsPerFile: o.slotsPerFile ?? 60,
    subagent: o.subagent ?? true,
    bgSteps: o.bgSteps ?? 40,
    bgSleep: o.bgSleep ?? 2,
    schemas: new Map()
  }
  const cps = o.cps ?? 600
  const log = o.log ?? (() => {})
  const stats = { requests: 0, turnSteps: 0, subSteps: 0, side: 0, paths: {} }
  let seq = 0

  const server = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x')
    stats.paths[url.pathname] = (stats.paths[url.pathname] ?? 0) + 1
    let raw = ''
    for await (const chunk of req) raw += chunk
    if (req.method !== 'POST' || !url.pathname.endsWith('/v1/messages')) {
      if (url.pathname.endsWith('/count_tokens')) {
        res.writeHead(200, { 'content-type': 'application/json' })
        return res.end(JSON.stringify({ input_tokens: 1000 }))
      }
      res.writeHead(404, { 'content-type': 'application/json' })
      return res.end(JSON.stringify({ type: 'error', error: { type: 'not_found_error' } }))
    }
    stats.requests++
    let body
    try {
      body = JSON.parse(raw)
    } catch {
      res.writeHead(400)
      return res.end()
    }
    const offered = new Set((body.tools ?? []).map((t) => t.name))
    for (const t of body.tools ?? []) if (t.input_schema) ctx.schemas.set(t.name, t.input_schema)
    const where = locate(body)
    const r = prng(77 + seq++)
    let step
    if (where.kind === 'turn') {
      const plan = turnPlan(where.turn, ctx)
      step = plan[Math.min(where.step, plan.length - 1)]
      stats.turnSteps++
    } else if (where.kind === 'bg') {
      const plan = bgTurnPlan(where.gradual)
      step = plan[Math.min(where.step, plan.length - 1)]
      stats.turnSteps++
    } else if (where.kind === 'sub' || where.kind === 'sublong') {
      const plan = where.kind === 'sub' ? subagentPlan(ctx) : longSubagentPlan(ctx, where.gradual)
      step = plan[Math.min(where.step, plan.length - 1)]
      stats.subSteps++
    } else {
      step = { thinking: null, text: 'Bench session' }
      stats.side++
    }
    const blocks = []
    if (step.thinking) blocks.push({ type: 'thinking', thinking: step.thinking })
    if (step.text) blocks.push({ type: 'text', text: step.text })
    for (const t of step.tools ?? []) {
      const c = concreteTool(t, ctx, offered, r)
      if (c && offered.has(c.name))
        blocks.push({
          type: 'tool_use',
          id: `toolu_bench${String(seq).padStart(6, '0')}${blocks.length}`,
          ...c
        })
    }
    if (!blocks.length) blocks.push({ type: 'text', text: 'Done.' })
    const stop = blocks.some((b) => b.type === 'tool_use') ? 'tool_use' : 'end_turn'
    const tagLine = (body.messages ?? [])
      .filter((m) => m.role === 'user')
      .map((m) => promptText(m.content))
      .filter(Boolean)
      .map((t) => t.slice(0, 40).replace(/\s+/g, ' '))
    log(
      `REQ msgs=${(body.messages ?? []).length} tools=${offered.size} prompts=${JSON.stringify(tagLine.slice(0, 3))} ${where.kind}${where.kind === 'turn' ? ` t${where.turn}` : ''} s${where.step ?? 0} -> ${blocks.map((b) => b.name ?? b.type).join(',')}`
    )
    const id = `msg_bench${String(seq).padStart(8, '0')}`
    const model = body.model ?? 'bench-model'
    const usage = {
      input_tokens: 1200,
      output_tokens: 1,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0
    }
    if (!body.stream) {
      res.writeHead(200, { 'content-type': 'application/json' })
      return res.end(
        JSON.stringify({
          id,
          type: 'message',
          role: 'assistant',
          model,
          content: blocks.map((b) => (b.type === 'thinking' ? { ...b, signature: 'bench' } : b)),
          stop_reason: stop,
          stop_sequence: null,
          usage: { ...usage, output_tokens: 200 }
        })
      )
    }
    res.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive'
    })
    const send = (type, data) =>
      res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`)
    const CHUNK = Math.max(4, Math.round(cps / 30))
    const pace = (CHUNK / cps) * 1000
    send('message_start', {
      message: {
        id,
        type: 'message',
        role: 'assistant',
        model,
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage
      }
    })
    let outTokens = 0
    for (let i = 0; i < blocks.length; i++) {
      const b = blocks[i]
      if (b.type === 'thinking') {
        send('content_block_start', {
          index: i,
          content_block: { type: 'thinking', thinking: '', signature: '' }
        })
        for (let p = 0; p < b.thinking.length; p += CHUNK) {
          send('content_block_delta', {
            index: i,
            delta: { type: 'thinking_delta', thinking: b.thinking.slice(p, p + CHUNK) }
          })
          await sleep(pace)
        }
        send('content_block_delta', {
          index: i,
          delta: { type: 'signature_delta', signature: 'bench-signature' }
        })
      } else if (b.type === 'text') {
        send('content_block_start', { index: i, content_block: { type: 'text', text: '' } })
        for (let p = 0; p < b.text.length; p += CHUNK) {
          send('content_block_delta', {
            index: i,
            delta: { type: 'text_delta', text: b.text.slice(p, p + CHUNK) }
          })
          await sleep(pace)
        }
      } else {
        send('content_block_start', {
          index: i,
          content_block: { type: 'tool_use', id: b.id, name: b.name, input: {} }
        })
        const json = JSON.stringify(b.input)
        for (let p = 0; p < json.length; p += CHUNK * 4) {
          send('content_block_delta', {
            index: i,
            delta: { type: 'input_json_delta', partial_json: json.slice(p, p + CHUNK * 4) }
          })
          await sleep(pace)
        }
      }
      outTokens += 50
      send('content_block_stop', { index: i })
    }
    send('message_delta', {
      delta: { stop_reason: stop, stop_sequence: null },
      usage: { output_tokens: outTokens }
    })
    send('message_stop', {})
    res.end()
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = server.address().port
  return {
    url: `http://127.0.0.1:${port}`,
    stats,
    close: () => new Promise((resolve) => server.close(() => resolve()))
  }
}

/** The seeded files a fake turn reads and edits: big enough for long Read output. */
export function seedFiles(cwd, { count = 4, lines = 700, slots = 60 } = {}) {
  return import('node:fs').then(({ writeFileSync, mkdirSync }) => {
    mkdirSync(cwd, { recursive: true })
    const files = []
    for (let f = 0; f < count; f++) {
      const r = prng(31 + f)
      const out = []
      for (let i = 0; i < lines; i++) {
        if (
          i % Math.floor(lines / slots) === 0 &&
          out.filter((l) => l.startsWith('// edit-slot')).length < slots
        )
          out.push(`// edit-slot ${out.filter((l) => l.startsWith('// edit-slot')).length}`)
        else out.push(`export const v${i} = compute(${Math.floor(r() * 1000)}) // ${words(r, 6)}`)
      }
      const file = `${cwd}/module-${f}.ts`.replace(/\\/g, '/')
      writeFileSync(file, out.join('\n') + '\n')
      files.push(file)
    }
    return files
  })
}
