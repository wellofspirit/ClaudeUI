// Seeded generator of a synthetic Claude Code transcript (`~/.claude/projects/<key>/<sid>.jsonl`)
// for the chat-scroll bench. The SHAPE follows what cli.js writes and what
// `src/core/services/session-history.ts` `loadSessionHistory` folds: one `user` line per prompt,
// one `assistant` line per content block sharing the API `message.id` (the loader upserts by id,
// so a step with thinking + text + tool_use is ONE chat message), and one `user` line per
// tool_result carrying `toolUseResult`. No content is copied from any real transcript: every
// word below comes from the seeded PRNG over a fixed vocabulary.
//
// The size knob is the number of CHAT messages the app will render (user prompts + assistant
// API messages), which is what the scroller holds one `.cv-auto` wrapper per.

/** mulberry32 — small, fast, seedable. */
export function prng(seed) {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const WORDS = (
  'the a an of to in for on with by from at as into over under after before between through ' +
  'session store render scroll anchor layout frame bubble message transcript stream token cache ' +
  'buffer queue worker handler reducer effect state event channel socket request response route ' +
  'config setting model engine harness provider endpoint vendor account ledger metric sample ' +
  'window viewport height width offset zoom scale pixel margin padding border flex grid column ' +
  'parser lexer token syntax node tree walker range match highlight search index cursor pointer ' +
  'commit branch merge rebase diff patch hunk line file path directory module package bundle ' +
  'build test assert expect mock stub fixture snapshot coverage gate lint format type check ' +
  'returns calls reads writes updates checks handles emits receives sends waits retries fails ' +
  'quickly slowly correctly safely eventually always never only still already instead because ' +
  'large small stale fresh hidden visible pending active idle running stable fractional nested'
).split(/\s+/)

const IDENTS = (
  'scrollTop scrollHeight clientHeight effectiveZoom doAutoScroll checkAtBottom loadSession ' +
  'applyPatch buildEnv parseLine foldEvents resolveModel createServer handleFrame emitDelta ' +
  'renderBubble measureAnchor computeMetrics readTranscript writeAtomic syncReplica ' +
  'projectState queueCommand dispatchTask settleReveal prerender releaseForced'
).split(/\s+/)

const EXTS = ['ts', 'tsx', 'mjs', 'py', 'json', 'md', 'css']
const DIRS = [
  'src/core/services',
  'src/renderer/src/components/chat',
  'src/shared',
  'scripts/lib',
  'docs/architecture',
  'src/main/ipc'
]

export const DEFAULT_MARKER = 'zephyrquartz'

function makeRand(seed) {
  const r = prng(seed)
  const int = (lo, hi) => lo + Math.floor(r() * (hi - lo + 1))
  const pick = (arr) => arr[Math.floor(r() * arr.length)]
  const chance = (p) => r() < p
  // Heavy-tailed size: most small, a few very large (tool output in real sessions).
  const skewed = (lo, hi) => Math.floor(lo + (hi - lo) * Math.pow(r(), 2.6))
  const hex = (n) => {
    let s = ''
    for (let i = 0; i < n; i++) s += Math.floor(r() * 16).toString(16)
    return s
  }
  const uuid = () =>
    `${hex(8)}-${hex(4)}-4${hex(3)}-${pick(['8', '9', 'a', 'b'])}${hex(3)}-${hex(12)}`
  return { r, int, pick, chance, skewed, hex, uuid }
}

function sentence(R, min = 6, max = 22) {
  const n = R.int(min, max)
  const words = []
  for (let i = 0; i < n; i++) {
    const roll = R.r()
    if (roll < 0.06) words.push(`\`${R.pick(IDENTS)}\``)
    else if (roll < 0.08) words.push(`**${R.pick(WORDS)}**`)
    else words.push(R.pick(WORDS))
  }
  const s = words.join(' ')
  return s.charAt(0).toUpperCase() + s.slice(1) + '.'
}

function paragraph(R, sentences = R.int(2, 6)) {
  const out = []
  for (let i = 0; i < sentences; i++) out.push(sentence(R))
  return out.join(' ')
}

function filePath(R) {
  return `${R.pick(DIRS)}/${R.pick(IDENTS)}.${R.pick(EXTS)}`
}

function codeLines(R, n, lang = 'ts') {
  const lines = []
  let depth = 0
  for (let i = 0; i < n; i++) {
    const id = R.pick(IDENTS)
    const roll = R.r()
    const pad = '  '.repeat(depth)
    if (lang === 'py') {
      if (roll < 0.15) {
        lines.push(`${pad}def ${id}_${R.int(1, 99)}(self, ${R.pick(WORDS)}_value):`)
        depth = Math.min(depth + 1, 3)
      } else if (roll < 0.25 && depth > 0) {
        lines.push(`${pad}return ${id}(${R.pick(WORDS)})`)
        depth--
      } else lines.push(`${pad}${R.pick(WORDS)}_${R.int(0, 9)} = ${id}(${R.int(0, 999)})`)
    } else if (lang === 'bash') {
      lines.push(
        `${R.pick(['bun run', 'node', 'git', 'grep -rn', 'ls -la', 'cat'])} ${filePath(R)}`
      )
    } else if (lang === 'json') {
      lines.push(`${pad}"${R.pick(WORDS)}_${i}": ${R.chance(0.5) ? R.int(0, 9999) : `"${id}"`},`)
    } else {
      if (roll < 0.12) {
        lines.push(`${pad}export function ${id}${R.int(1, 99)}(el: HTMLElement): number {`)
        depth = Math.min(depth + 1, 4)
      } else if (roll < 0.22 && depth > 0) {
        depth--
        lines.push(`${'  '.repeat(depth)}}`)
      } else if (roll < 0.32) {
        lines.push(`${pad}// ${sentence(R, 4, 12)}`)
      } else if (roll < 0.42) {
        lines.push(`${pad}if (${id}.${R.pick(WORDS)} > ${R.int(0, 200)}) return ${R.int(0, 9)}`)
      } else {
        lines.push(
          `${pad}const ${R.pick(WORDS)}${i} = ${id}(${R.pick(WORDS)}, ${R.int(0, 999)}) // ${R.pick(WORDS)}`
        )
      }
    }
  }
  while (depth-- > 0) lines.push(`${'  '.repeat(depth)}}`)
  return lines
}

function table(R) {
  const cols = R.int(3, 6)
  const rows = R.int(3, 12)
  const head = Array.from({ length: cols }, () => R.pick(WORDS))
  const out = [`| ${head.join(' | ')} |`, `|${head.map(() => ' --- ').join('|')}|`]
  for (let i = 0; i < rows; i++)
    out.push(
      `| ${Array.from({ length: cols }, (_, c) =>
        c === 0 ? `\`${R.pick(IDENTS)}\`` : R.chance(0.5) ? String(R.int(0, 5000)) : R.pick(WORDS)
      ).join(' | ')} |`
    )
  return out.join('\n')
}

/** A long markdown answer: headers, prose, lists, a table, fenced code. */
function markdownAnswer(R, marker) {
  const parts = []
  const sections = R.int(1, 5)
  for (let s = 0; s < sections; s++) {
    parts.push(`## ${sentence(R, 2, 6).replace(/\.$/, '')}`)
    parts.push(paragraph(R, R.int(2, 7)))
    const roll = R.r()
    if (roll < 0.35) {
      for (let i = 0, n = R.int(3, 9); i < n; i++) parts.push(`- ${sentence(R, 4, 18)}`)
    } else if (roll < 0.55) {
      for (let i = 0, n = R.int(3, 7); i < n; i++) parts.push(`${i + 1}. ${sentence(R, 6, 20)}`)
    } else if (roll < 0.7) {
      parts.push(table(R))
    }
    if (R.chance(0.45)) {
      const lang = R.pick(['ts', 'ts', 'py', 'bash', 'json'])
      parts.push('```' + lang + '\n' + codeLines(R, R.skewed(4, 70), lang).join('\n') + '\n```')
    }
    if (R.chance(0.4)) parts.push(paragraph(R, R.int(1, 4)))
  }
  if (marker) parts.splice(R.int(1, parts.length), 0, `${paragraph(R, 1)} ${marker} ${sentence(R)}`)
  return parts.join('\n\n')
}

function bashOutput(R, marker) {
  const n = R.skewed(1, 420)
  const lines = []
  const style = R.pick(['test', 'ls', 'log', 'build', 'grep'])
  for (let i = 0; i < n; i++) {
    if (style === 'test')
      lines.push(
        `${R.chance(0.93) ? ' ✓' : ' ✗'} ${filePath(R)} > ${sentence(R, 3, 9).replace(/\.$/, '')} ${R.int(1, 400)}ms`
      )
    else if (style === 'ls')
      lines.push(
        `-rw-r--r-- 1 dev dev ${String(R.int(10, 99999)).padStart(6)} Oct  ${R.int(1, 9)} 1${R.int(0, 9)}:${R.int(10, 59)} ${R.pick(IDENTS)}.${R.pick(EXTS)}`
      )
    else if (style === 'log')
      lines.push(`${R.hex(8)} ${R.pick(['feat', 'fix', 'docs', 'test'])}: ${sentence(R, 4, 12)}`)
    else if (style === 'build')
      lines.push(
        `  ${R.pick(['OK', 'OK', 'OK', 'WARN'])} ${filePath(R)} (${R.int(1, 900)} kB, ${R.int(1, 99)}ms)`
      )
    else lines.push(`${filePath(R)}:${R.int(1, 900)}:  ${codeLines(R, 1)[0]}`)
  }
  if (marker && lines.length) lines.splice(R.int(0, lines.length - 1), 0, `  note: ${marker} found`)
  return lines.join('\n')
}

function catN(lines, start = 1) {
  return lines.map((l, i) => `${String(start + i).padStart(6)}\t${l}`).join('\n')
}

/** A solid-colour PNG (no deps: zlib + a hand-rolled CRC). */
export async function solidPng(width, height, rgb) {
  const { deflateSync } = await import('node:zlib')
  const crcTable = Array.from({ length: 256 }, (_, n) => {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    return c >>> 0
  })
  const crc = (buf) => {
    let c = 0xffffffff
    for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8)
    return (c ^ 0xffffffff) >>> 0
  }
  const chunk = (type, data) => {
    const len = Buffer.alloc(4)
    len.writeUInt32BE(data.length)
    const td = Buffer.concat([Buffer.from(type, 'ascii'), data])
    const c = Buffer.alloc(4)
    c.writeUInt32BE(crc(td))
    return Buffer.concat([len, td, c])
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8
  ihdr[9] = 2
  const row = Buffer.alloc(1 + width * 3)
  for (let x = 0; x < width; x++) row.set(rgb, 1 + x * 3)
  const raw = Buffer.concat(Array.from({ length: height }, () => row))
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0))
  ]).toString('base64')
}

const TOOL_WEIGHTS = [
  ['Bash', 38],
  ['Read', 24],
  ['Edit', 9],
  ['Write', 4],
  ['Grep', 8],
  ['Glob', 5],
  ['TodoWrite', 5],
  ['Agent', 3],
  ['ReadImage', 1]
]

/**
 * Generate the transcript lines.
 *
 * @param {object} o
 * @param {number} o.messages   target chat-message count (user prompts + assistant API messages)
 * @param {number} [o.seed]
 * @param {string} o.cwd        the session's cwd (groups it in the sidebar)
 * @param {string} o.sessionId
 * @param {boolean} [o.images]  include occasional image tool results
 * @param {string} [o.marker]   rare search term planted in text, bash output and edits
 * @returns {Promise<{ lines: string[], manifest: object }>}
 */
export async function generateTranscript(o) {
  const R = makeRand(o.seed ?? 1)
  const marker = o.marker ?? DEFAULT_MARKER
  const png = o.images ? await solidPng(480, 270, [64, 120, 200]) : null
  const lines = []
  const manifest = {
    seed: o.seed ?? 1,
    sessionId: o.sessionId,
    cwd: o.cwd,
    target: o.messages,
    chatMessages: 0,
    userPrompts: 0,
    assistantMessages: 0,
    tools: {},
    marker,
    markerHits: { text: 0, bash: 0, edit: 0 }
  }
  const base = {
    isSidechain: false,
    userType: 'external',
    cwd: o.cwd,
    sessionId: o.sessionId,
    version: '2.1.285',
    gitBranch: 'bench',
    entrypoint: 'claude-desktop'
  }
  let t = Date.UTC(2026, 8, 1, 9, 0, 0)
  let parent = null
  const ts = () => {
    t += R.int(400, 9000)
    return new Date(t).toISOString()
  }
  const push = (obj) => {
    const uuid = R.uuid()
    lines.push(JSON.stringify({ parentUuid: parent, ...base, ...obj, uuid, timestamp: ts() }))
    parent = uuid
    return uuid
  }
  const usage = () => ({
    input_tokens: R.int(1, 40),
    cache_creation_input_tokens: R.int(0, 4000),
    cache_read_input_tokens: R.int(10000, 120000),
    output_tokens: R.int(20, 3000)
  })
  const weightTotal = TOOL_WEIGHTS.reduce((s, [, w]) => s + w, 0)
  const pickTool = () => {
    let roll = R.r() * weightTotal
    for (const [name, w] of TOOL_WEIGHTS) if ((roll -= w) < 0) return name
    return 'Bash'
  }
  let todoState = []

  /** One tool call: the tool_use block and the tool_result line that follows it. */
  const makeTool = (name) => {
    const id = `toolu_01${R.hex(22)}`
    manifest.tools[name] = (manifest.tools[name] ?? 0) + 1
    const plantBash = R.chance(0.05)
    const plantEdit = R.chance(0.08)
    switch (name) {
      case 'Bash': {
        const out = bashOutput(R, plantBash ? marker : null)
        if (plantBash) manifest.markerHits.bash++
        return {
          use: {
            name,
            input: { command: codeLines(R, 1, 'bash')[0], description: sentence(R, 3, 8) }
          },
          id,
          content: out,
          result: { stdout: out, stderr: '', interrupted: false, isImage: false }
        }
      }
      case 'Read': {
        const path = filePath(R)
        const n = R.skewed(20, 900)
        const body = codeLines(R, n, path.endsWith('.py') ? 'py' : 'ts')
        return {
          use: { name, input: { file_path: `${o.cwd}/${path}` } },
          id,
          content: catN(body),
          result: {
            type: 'text',
            file: {
              filePath: `${o.cwd}/${path}`,
              content: body.join('\n'),
              numLines: body.length,
              startLine: 1,
              totalLines: body.length
            }
          }
        }
      }
      case 'ReadImage': {
        if (!png) return makeTool('Read')
        const path = `${o.cwd}/screenshots/${R.pick(IDENTS)}.png`
        return {
          use: { name: 'Read', input: { file_path: path } },
          id,
          content: [
            { type: 'image', source: { type: 'base64', media_type: 'image/png', data: png } }
          ],
          result: { type: 'image', file: { base64: png, type: 'image/png', originalSize: 4000 } }
        }
      }
      case 'Edit': {
        const path = `${o.cwd}/${filePath(R)}`
        const oldLines = codeLines(R, R.skewed(1, 40))
        const newLines = codeLines(R, R.skewed(1, 50))
        if (plantEdit) {
          newLines.splice(0, 0, `// ${marker}: ${sentence(R, 3, 8)}`)
          manifest.markerHits.edit++
        }
        return {
          use: {
            name,
            input: {
              file_path: path,
              old_string: oldLines.join('\n'),
              new_string: newLines.join('\n'),
              replace_all: false
            }
          },
          id,
          content: `The file ${path} has been updated successfully.`,
          result: {
            filePath: path,
            oldString: oldLines.join('\n'),
            newString: newLines.join('\n'),
            originalFile: null,
            structuredPatch: [
              {
                oldStart: R.int(1, 400),
                oldLines: oldLines.length,
                newStart: R.int(1, 400),
                newLines: newLines.length,
                lines: [...oldLines.map((l) => `-${l}`), ...newLines.map((l) => `+${l}`)]
              }
            ],
            userModified: false,
            replaceAll: false
          }
        }
      }
      case 'Write': {
        const path = `${o.cwd}/${filePath(R)}`
        const body = codeLines(R, R.skewed(10, 260))
        return {
          use: { name, input: { file_path: path, content: body.join('\n') } },
          id,
          content: `File created successfully at: ${path}`,
          result: {
            type: 'create',
            filePath: path,
            content: body.join('\n'),
            structuredPatch: [],
            originalFile: null
          }
        }
      }
      case 'Grep': {
        const n = R.skewed(1, 90)
        const hits = Array.from(
          { length: n },
          () => `${filePath(R)}:${R.int(1, 900)}:${codeLines(R, 1)[0]}`
        )
        return {
          use: {
            name,
            input: { pattern: R.pick(IDENTS), path: o.cwd, output_mode: 'content', '-n': true }
          },
          id,
          content: hits.join('\n'),
          result: {
            mode: 'content',
            numFiles: n,
            filenames: [],
            content: hits.join('\n'),
            numLines: n
          }
        }
      }
      case 'Glob': {
        const n = R.skewed(1, 120)
        const files = Array.from({ length: n }, () => `${o.cwd}/${filePath(R)}`)
        return {
          use: { name, input: { pattern: `**/*.${R.pick(EXTS)}` } },
          id,
          content: files.join('\n'),
          result: { filenames: files, durationMs: R.int(2, 90), numFiles: n, truncated: false }
        }
      }
      case 'TodoWrite': {
        const oldTodos = todoState
        if (!todoState.length || R.chance(0.3))
          todoState = Array.from({ length: R.int(3, 8) }, () => ({
            content: sentence(R, 3, 9).replace(/\.$/, ''),
            status: 'pending',
            activeForm: sentence(R, 3, 7).replace(/\.$/, '')
          }))
        else {
          todoState = todoState.map((td, i) => ({
            ...td,
            status: i < R.int(0, todoState.length) ? 'completed' : td.status
          }))
          const next = todoState.find((td) => td.status === 'pending')
          if (next) next.status = 'in_progress'
        }
        return {
          use: { name, input: { todos: todoState } },
          id,
          content:
            'Todos have been modified successfully. Ensure that you continue to use the todo list to track your progress.',
          result: { oldTodos, newTodos: todoState }
        }
      }
      case 'Agent': {
        const report = markdownAnswer(R, null)
        const agentId = R.hex(17)
        return {
          use: {
            name,
            input: {
              description: sentence(R, 2, 5).replace(/\.$/, ''),
              prompt: paragraph(R, R.int(3, 8)),
              subagent_type: 'general-purpose'
            }
          },
          id,
          content: [
            { type: 'text', text: report },
            { type: 'text', text: `agentId: ${agentId} (use SendMessage to continue)` }
          ],
          result: {
            status: 'completed',
            agentId,
            content: [{ type: 'text', text: report }],
            totalDurationMs: R.int(20000, 400000),
            totalTokens: R.int(5000, 90000),
            totalToolUseCount: R.int(2, 40)
          }
        }
      }
    }
    throw new Error(`unknown tool ${name}`)
  }

  const model = 'claude-sonnet-4-5-20250929'
  const emitAssistantBlocks = (blocks, stop) => {
    const messageId = `msg_01${R.hex(22)}`
    const requestId = `req_011${R.hex(21)}`
    let last = null
    for (const block of blocks)
      last = push({
        type: 'assistant',
        requestId,
        message: {
          id: messageId,
          type: 'message',
          role: 'assistant',
          model,
          content: [block],
          stop_reason: stop,
          stop_sequence: null,
          usage: usage()
        }
      })
    manifest.assistantMessages++
    manifest.chatMessages++
    return last
  }

  while (manifest.chatMessages < o.messages) {
    // A user prompt.
    const prompt = [paragraph(R, R.int(1, 5))]
    if (R.chance(0.2)) prompt.push('```ts\n' + codeLines(R, R.skewed(3, 40)).join('\n') + '\n```')
    if (R.chance(0.3)) prompt.push(paragraph(R, R.int(1, 3)))
    push({
      type: 'user',
      promptId: R.uuid(),
      message: { role: 'user', content: prompt.join('\n\n') }
    })
    manifest.userPrompts++
    manifest.chatMessages++

    const steps = R.int(3, 14)
    for (let s = 0; s < steps && manifest.chatMessages < o.messages; s++) {
      const final = s === steps - 1 || manifest.chatMessages === o.messages - 1
      const blocks = []
      if (R.chance(final ? 0.3 : 0.5))
        blocks.push({
          type: 'thinking',
          thinking: paragraph(R, R.skewed(2, 30)),
          signature: R.hex(64)
        })
      if (final) {
        const plant = R.chance(0.07)
        if (plant) manifest.markerHits.text++
        blocks.push({ type: 'text', text: markdownAnswer(R, plant ? marker : null) })
        emitAssistantBlocks(blocks, 'end_turn')
        break
      }
      if (R.chance(0.55)) blocks.push({ type: 'text', text: paragraph(R, R.int(1, 3)) })
      const nTools = R.chance(0.15) ? R.int(2, 3) : 1
      const tools = Array.from({ length: nTools }, () => makeTool(pickTool()))
      for (const tool of tools)
        blocks.push({ type: 'tool_use', id: tool.id, name: tool.use.name, input: tool.use.input })
      const assistantUuid = emitAssistantBlocks(blocks, 'tool_use')
      for (const tool of tools)
        push({
          type: 'user',
          sourceToolAssistantUUID: assistantUuid,
          message: {
            role: 'user',
            content: [
              { tool_use_id: tool.id, type: 'tool_result', content: tool.content, is_error: false }
            ]
          },
          toolUseResult: tool.result
        })
    }
  }
  lines.push(
    JSON.stringify({
      type: 'ai-title',
      sessionId: o.sessionId,
      aiTitle: `Synthetic bench ${o.messages} msgs`
    })
  )
  return { lines, manifest }
}
