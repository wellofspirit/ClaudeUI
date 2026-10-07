/**
 * pi + ClaudeUI's shared MCP catalog, end to end, with NO credential and NO
 * network (ADR-096).
 *
 * The real pinned pi binary, the real bridge extension (`writeBridgeExtension`),
 * the real `PiBridgeHost` serving `/mcp-servers`, the real translator
 * (`buildPiMcpCatalog`) and the real permission ladder (`decideWithSource` with
 * pi's `mcpRuleKey`) — against two local fixtures:
 *
 *  - a stdio MCP server (a tiny node script) with two tools, `echo` and `wipe`,
 *    that records every `tools/call` in a marker file, so "the tool ran" and
 *    "the tool never ran" are observable from outside pi;
 *  - an OpenAI-compatible chat-completions provider on 127.0.0.1, declared in
 *    the ISOLATED agent dir's `models.json`, scripted to call
 *    `mcp__fixture__echo` (or `mcp__fixture__wipe`) once and then answer.
 *
 * The user's rules allow `mcp__fixture__echo` and deny `mcp__fixture__wipe`,
 * written in Claude's vocabulary, so the path proven is: catalog → bridged
 * registration (`exposure: "direct"`, declared to the model) → the model calls
 * the tool → ClaudeUI's gate decides → the result (or the denial) returns.
 *
 * Isolation: `PI_CODING_AGENT_DIR` is a temp dir (never `~/.pi`), pi runs
 * offline (`PI_OFFLINE=1`, no version check, no telemetry), sessions land in the
 * temp dir. The only write outside it is the bridge extension file under
 * `~/.claude/ui/pi-ext`, exactly as every pi integration test (and the app)
 * writes it. Skips when no pi is installed.
 */

// @vitest-environment node

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { createServer, type Server } from 'node:http'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { locatePiLaunch } from '../../core/pi/pi-locate'
import { PiRpcClient } from '../../core/pi/PiRpcClient'
import { PiBridgeHost, writeBridgeExtension } from '../../core/pi/PiBridgeHost'
import type { GateDecision, PiToolCallPayload } from '../../core/pi/PiBridgeHost'
import { buildPiMcpCatalog, piMcpRuleKey } from '../../core/pi/pi-mcp-bridge'
import { decideWithSource } from '../../core/pi/permission-engine'
import { createPiMapperState, mapPiEvent } from '../../core/pi/event-mapper'

const LAUNCH = locatePiLaunch()

const PROVIDER = 'cui-fixture'
const MODEL_ID = 'fixture-model'
const ECHO_TOOL = 'mcp__fixture__echo'
const WIPE_TOOL = 'mcp__fixture__wipe'
/** Carries a `$`: the escape must deliver it to the server LITERALLY. */
const FIXTURE_TAG = 'tag$HOME!'

/** The stdio MCP server. Records `call:<tool>:<args>` lines; answers `echo` with `<tag>:<text>`. */
const STUB_SOURCE = `import { appendFileSync } from 'node:fs'
const [marker] = process.argv.slice(2)
const tag = process.env.FIXTURE_TAG || ''
let buffer = ''
process.stdin.setEncoding('utf8')
process.stdin.on('data', (chunk) => {
  buffer += chunk
  for (let i = buffer.indexOf('\\n'); i >= 0; i = buffer.indexOf('\\n')) {
    const line = buffer.slice(0, i).trim()
    buffer = buffer.slice(i + 1)
    if (!line) continue
    let msg
    try { msg = JSON.parse(line) } catch { continue }
    if (msg.id === undefined || msg.id === null) continue
    let result = {}
    if (msg.method === 'initialize') {
      result = { protocolVersion: msg.params && msg.params.protocolVersion || '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'fixture', version: '1' } }
    } else if (msg.method === 'tools/list') {
      result = { tools: [
        { name: 'echo', description: 'Echo the text back.', inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] } },
        { name: 'wipe', description: 'Destroy everything.', inputSchema: { type: 'object', properties: {} } }
      ] }
    } else if (msg.method === 'tools/call') {
      const name = msg.params && msg.params.name
      const args = (msg.params && msg.params.arguments) || {}
      appendFileSync(marker, 'call:' + name + ':' + JSON.stringify(args) + '\\n')
      result = { content: [{ type: 'text', text: name === 'echo' ? tag + ':' + args.text : 'wiped' }], isError: false }
    } else if (msg.method === 'ping') {
      result = {}
    } else {
      process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: 'not found' } }) + '\\n')
      continue
    }
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result }) + '\\n')
  }
})
process.stdin.on('end', () => process.exit(0))
process.stdin.resume()
`

interface ChatMessage {
  role: string
  content?: unknown
  tool_calls?: unknown
}

/** One SSE chat-completions stream: a tool call, or a final text answer. */
function sseBody(step: { tool: string; args: Record<string, unknown> } | { text: string }): string {
  const chunk = (delta: Record<string, unknown>, finish: string | null): string =>
    `data: ${JSON.stringify({
      id: 'chatcmpl-fixture',
      object: 'chat.completion.chunk',
      created: 0,
      model: MODEL_ID,
      choices: [{ index: 0, delta, finish_reason: finish }]
    })}\n\n`
  const usage = `data: ${JSON.stringify({
    id: 'chatcmpl-fixture',
    object: 'chat.completion.chunk',
    created: 0,
    model: MODEL_ID,
    choices: [],
    usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 }
  })}\n\n`
  const body =
    'tool' in step
      ? chunk(
          {
            role: 'assistant',
            tool_calls: [
              {
                index: 0,
                id: `call_${step.tool}`,
                type: 'function',
                function: { name: step.tool, arguments: JSON.stringify(step.args) }
              }
            ]
          },
          null
        ) + chunk({}, 'tool_calls')
      : chunk({ role: 'assistant', content: step.text }, null) + chunk({}, 'stop')
  return body + usage + 'data: [DONE]\n\n'
}

function lastUserText(messages: ChatMessage[]): string {
  const user = [...messages].reverse().find((m) => m.role === 'user')
  if (!user) return ''
  return typeof user.content === 'string' ? user.content : JSON.stringify(user.content)
}

describe.skipIf(!LAUNCH)('pi + the shared MCP catalog (credential-free, ADR-096)', () => {
  let dir: string
  let marker: string
  let provider: Server
  let bridgeHost: PiBridgeHost
  let client: PiRpcClient
  const requests: Array<{ tools: string[]; messages: ChatMessage[] }> = []
  const gateCalls: PiToolCallPayload[] = []
  const events: Record<string, unknown>[] = []
  const lockedHits: string[] = []

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'pi-mcp-it-'))
    marker = join(dir, 'calls.log')
    const stub = join(dir, 'stub-mcp.mjs')
    writeFileSync(stub, STUB_SOURCE)
    const agentDir = join(dir, 'agent')
    const cwd = join(dir, 'work')
    mkdirSync(agentDir, { recursive: true })
    mkdirSync(cwd, { recursive: true })

    // The provider: step 1 of a turn calls the tool the prompt names, step 2
    // (the conversation ends in a tool result) answers with that result.
    provider = createServer((req, res) => {
      let raw = ''
      req.on('data', (c) => (raw += c))
      req.on('end', () => {
        // The OAuth-guarded MCP server: every request is unauthorized.
        if (req.url?.startsWith('/locked')) {
          lockedHits.push(`${req.method} ${req.url}`)
          res.writeHead(401, { 'www-authenticate': 'Bearer realm="fixture"' }).end()
          return
        }
        if (req.method !== 'POST' || !req.url?.endsWith('/chat/completions')) {
          res.writeHead(404).end()
          return
        }
        const body = JSON.parse(raw) as {
          messages: ChatMessage[]
          tools?: Array<{ function?: { name?: string } }>
        }
        requests.push({
          tools: (body.tools ?? []).map((t) => t.function?.name ?? ''),
          messages: body.messages
        })
        const last = body.messages[body.messages.length - 1]
        const step =
          last?.role === 'tool'
            ? {
                text: `fixture saw: ${typeof last.content === 'string' ? last.content : JSON.stringify(last.content)}`
              }
            : lastUserText(body.messages).includes('WIPE')
              ? { tool: WIPE_TOOL, args: {} }
              : { tool: ECHO_TOOL, args: { text: 'hello-mcp' } }
        res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
        res.end(sseBody(step))
      })
    })
    await new Promise<void>((resolve) => provider.listen(0, '127.0.0.1', () => resolve()))
    const address = provider.address()
    if (!address || typeof address === 'string') throw new Error('no provider port')

    writeFileSync(
      join(agentDir, 'models.json'),
      JSON.stringify({
        providers: {
          [PROVIDER]: {
            baseUrl: `http://127.0.0.1:${address.port}/v1`,
            api: 'openai-completions',
            apiKey: 'fixture-not-a-key',
            models: [{ id: MODEL_ID, name: 'Fixture', contextWindow: 32000, maxTokens: 4096 }]
          }
        }
      })
    )

    // The catalog exactly as a session builds it: the real translator.
    const catalog = buildPiMcpCatalog(
      {
        fixture: {
          command: process.execPath,
          args: [stub, marker],
          env: { FIXTURE_TAG }
        },
        // A catalog HTTP server with no Authorization header that answers 401:
        // pi treats it as OAuth, which RPC mode cannot sign in to by itself.
        locked: { type: 'http', url: `http://127.0.0.1:${address.port}/locked/mcp` }
      },
      {}
    )
    expect(catalog.skipped).toEqual([])

    // The user's Claude-vocabulary rules, through the real ladder.
    const rules = {
      allow: [ECHO_TOOL],
      deny: [WIPE_TOOL],
      ask: [],
      additionalDirectories: [],
      defaultMode: undefined
    }
    const gate = async (payload: PiToolCallPayload): Promise<GateDecision> => {
      gateCalls.push(payload)
      const verdict = decideWithSource(payload.toolName, payload.input, {
        mode: 'default',
        rules,
        sessionAllows: new Set(),
        cwd,
        mcpRuleKey: piMcpRuleKey
      })
      if (verdict.decision === 'allow') return { behavior: 'allow' }
      return {
        behavior: 'deny',
        reason: verdict.rule
          ? `Denied by permission rule: ${verdict.rule}`
          : 'Denied by permission rules'
      }
    }
    bridgeHost = new PiBridgeHost(gate, undefined, { mcpServers: catalog.servers })
    const bridge = await bridgeHost.start()
    const bridgePath = writeBridgeExtension()

    client = new PiRpcClient(LAUNCH!, {
      cwd,
      args: ['--mode', 'rpc', '-e', bridgePath, '--session-dir', join(dir, 'sessions')],
      env: {
        PI_CODING_AGENT_DIR: agentDir,
        PI_OFFLINE: '1',
        PI_SKIP_VERSION_CHECK: '1',
        PI_TELEMETRY: '0',
        CLAUDEUI_PI_BRIDGE_URL: bridge.url,
        CLAUDEUI_PI_BRIDGE_TOKEN: bridge.token,
        CLAUDEUI_PI_MCP: '1',
        CLAUDEUI_PI_HOSTED_TOOLS: '',
        CLAUDEUI_PI_DISPATCH_ENABLED: '',
        CLAUDEUI_PI_PLAN_TOOLS: '',
        CLAUDEUI_PI_AGENT_TOOL: '',
        CLAUDEUI_PI_SEND_MESSAGE: '',
        CLAUDEUI_PI_SKILL_DIRS: ''
      }
    })
    client.onEvent((ev) => events.push(ev as unknown as Record<string, unknown>))
    await client.start()
    const set = await client.request(
      { type: 'set_model', provider: PROVIDER, modelId: MODEL_ID },
      30_000
    )
    expect(set.success, `set_model failed: ${JSON.stringify(set)}`).toBe(true)
  }, 60_000)

  afterAll(async () => {
    client?.dispose()
    bridgeHost?.dispose()
    await new Promise((resolve) => setTimeout(resolve, 500))
    await new Promise<void>((resolve) => (provider ? provider.close(() => resolve()) : resolve()))
    if (dir) rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
  })

  async function turn(message: string): Promise<Record<string, unknown>[]> {
    const from = events.length
    const resp = await client.request({ type: 'prompt', message }, 30_000)
    expect(resp.success, JSON.stringify(resp)).toBe(true)
    const deadline = Date.now() + 45_000
    while (Date.now() < deadline) {
      const slice = events.slice(from)
      if (slice.some((ev) => ev.type === 'agent_settled')) return slice
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
    throw new Error(`turn did not settle: ${JSON.stringify(events.slice(from)).slice(0, 4000)}`)
  }

  function toolResult(
    slice: Record<string, unknown>[],
    toolName: string
  ): { isError: boolean; text: string } | null {
    for (const ev of slice) {
      if (ev.type !== 'message_end') continue
      const msg = ev.message as Record<string, unknown> | undefined
      if (!msg || msg.role !== 'toolResult' || msg.toolName !== toolName) continue
      const content = (msg.content as Array<{ type: string; text?: string }>) ?? []
      return {
        isError: Boolean(msg.isError),
        text: content
          .filter((b) => b.type === 'text')
          .map((b) => b.text ?? '')
          .join('')
      }
    }
    return null
  }

  const calls = (): string[] =>
    existsSync(marker) ? readFileSync(marker, 'utf-8').split('\n').filter(Boolean) : []

  it('an allowed call: registered direct, declared to the model, gated, executed, result returned', async () => {
    const slice = await turn('Please ECHO something.')
    // Declared to the model like a built-in (exposure "direct"), both tools.
    expect(requests[0]?.tools).toEqual(expect.arrayContaining([ECHO_TOOL, WIPE_TOOL]))
    // The gate saw the call under pi's MCP name, and the allow rule bound.
    expect(gateCalls.map((c) => c.toolName)).toContain(ECHO_TOOL)
    const result = toolResult(slice, ECHO_TOOL)
    expect(result, `no ${ECHO_TOOL} result: ${JSON.stringify(slice).slice(0, 3000)}`).not.toBeNull()
    expect(result!.isError).toBe(false)
    // The server ran with the catalog's env, `$` and `!` delivered literally.
    expect(result!.text).toBe(`${FIXTURE_TAG}:hello-mcp`)
    expect(calls()).toEqual(['call:echo:{"text":"hello-mcp"}'])
  }, 60_000)

  it('a denied call: the deny rule blocks it, the server never runs it, pi gets the reason', async () => {
    const slice = await turn('Please WIPE everything.')
    expect(gateCalls.map((c) => c.toolName)).toContain(WIPE_TOOL)
    const result = toolResult(slice, WIPE_TOOL)
    expect(result, `no ${WIPE_TOOL} result: ${JSON.stringify(slice).slice(0, 3000)}`).not.toBeNull()
    expect(result!.isError).toBe(true)
    expect(result!.text).toContain(`Denied by permission rule: ${WIPE_TOOL}`)
    expect(calls().some((line) => line.startsWith('call:wipe'))).toBe(false)
  }, 60_000)

  it('an OAuth server from the catalog never hangs the session: pi marks it and ClaudeUI warns', async () => {
    // Both turns above already ran with it registered. pi reports the state
    // once every startup connection settled, as a notify ClaudeUI maps to a
    // session warning.
    const deadline = Date.now() + 15_000
    let notice: string | undefined
    while (!notice && Date.now() < deadline) {
      for (const ev of events) {
        const mapped = mapPiEvent(ev as never, createPiMapperState())
        const hit = mapped.find((o) => o.kind === 'mcp_notice')
        if (hit && hit.kind === 'mcp_notice' && hit.message.includes('locked')) notice = hit.message
      }
      if (!notice) await new Promise((resolve) => setTimeout(resolve, 100))
    }
    expect(lockedHits.length).toBeGreaterThan(0)
    expect(
      notice,
      `no MCP notice: ${JSON.stringify(events.filter((e) => e.type === 'extension_ui_request'))}`
    ).toMatch(/locked: needs sign-in/)
  }, 30_000)
})
