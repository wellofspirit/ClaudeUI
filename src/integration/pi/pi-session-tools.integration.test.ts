/**
 * pi + the session tools (bridge v15, session tools slice 2), end to end, with NO
 * credential and NO network.
 *
 * The real pinned pi binary, the real bridge extension (`writeBridgeExtension`) and
 * the real `PiBridgeHost`, spawned the way `PiSession.doStart()` spawns them, with
 * the real `CLAUDEUI_PI_SESSION_TOOLS` value (`piSessionToolsEnv`). The model is a
 * local OpenAI-compatible fixture provider (the same technique as
 * pi-mcp.integration.test.ts) scripted to call a session tool once and then answer.
 * The gate and the hosted-tool handler are the test's own: the subject is the
 * carrier, not the service (its rules have their own suites).
 *
 * What it proves against the real pi: the nine tools are registered and DECLARED to
 * the model with the shared schemas, the guidance reaches the system prompt through
 * `promptGuidelines`, a gated call round-trips through `/hosted-tool`, and a call the
 * gate denies comes back as an error carrying the reason and never reaches the
 * handler. No model call leaves the machine.
 *
 * Isolation as in pi-mcp: `PI_CODING_AGENT_DIR` is a temp dir, pi runs offline.
 */

// @vitest-environment node

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { createServer, type Server } from 'node:http'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { locatePiLaunch } from '../../core/pi/pi-locate'
import { PiRpcClient } from '../../core/pi/PiRpcClient'
import { PiBridgeHost, writeBridgeExtension } from '../../core/pi/PiBridgeHost'
import type {
  GateDecision,
  PiHostedToolPayload,
  PiHostedToolResult,
  PiToolCallPayload
} from '../../core/pi/PiBridgeHost'
import { piSessionToolsEnv } from '../../core/services/session-tool-specs'
import {
  SESSION_TOOL_NAMES,
  sessionToolsGuidanceParts
} from '../../shared/session-tools-description'

const LAUNCH = locatePiLaunch()

const PROVIDER = 'cui-fixture'
const MODEL_ID = 'fixture-model'

interface ChatMessage {
  role: string
  content?: unknown
}

interface ProviderTool {
  function?: { name?: string; description?: string; parameters?: unknown }
}

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

const textOf = (content: unknown): string =>
  typeof content === 'string' ? content : JSON.stringify(content)

describe.skipIf(!LAUNCH)('pi + the session tools (credential-free, slice 2)', () => {
  let dir: string
  let provider: Server
  let bridgeHost: PiBridgeHost
  let client: PiRpcClient
  const requests: Array<{ tools: ProviderTool[]; messages: ChatMessage[] }> = []
  const gateCalls: PiToolCallPayload[] = []
  const handled: PiHostedToolPayload[] = []
  const events: Record<string, unknown>[] = []

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'pi-session-tools-it-'))
    const agentDir = join(dir, 'agent')
    const cwd = join(dir, 'work')
    mkdirSync(agentDir, { recursive: true })
    mkdirSync(cwd, { recursive: true })

    provider = createServer((req, res) => {
      let raw = ''
      req.on('data', (c) => (raw += c))
      req.on('end', () => {
        if (req.method !== 'POST' || !req.url?.endsWith('/chat/completions')) {
          res.writeHead(404).end()
          return
        }
        const body = JSON.parse(raw) as { messages: ChatMessage[]; tools?: ProviderTool[] }
        requests.push({ tools: body.tools ?? [], messages: body.messages })
        const last = body.messages[body.messages.length - 1]
        const user = [...body.messages].reverse().find((m) => m.role === 'user')
        const step =
          last?.role === 'tool'
            ? { text: `fixture saw: ${textOf(last.content)}` }
            : textOf(user?.content).includes('STOP')
              ? { tool: 'session_stop', args: { session: 's-other1' } }
              : { tool: 'session_list', args: { scope: 'linked' } }
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

    // The gate the session would apply: reads allowed, stopping a session refused.
    const gate = async (payload: PiToolCallPayload): Promise<GateDecision> => {
      gateCalls.push(payload)
      return payload.toolName === 'session_stop'
        ? { behavior: 'deny', reason: 'Refused: not within your family' }
        : { behavior: 'allow' }
    }
    const hosted = async (payload: PiHostedToolPayload): Promise<PiHostedToolResult> => {
      handled.push(payload)
      return { content: [{ type: 'text', text: 'ref s-abc123 · Fix the flaky test' }] }
    }
    bridgeHost = new PiBridgeHost(gate, hosted)
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
        CLAUDEUI_PI_SESSION_TOOLS: piSessionToolsEnv(),
        CLAUDEUI_PI_MCP: '',
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

  it('declares the nine tools to the model with the shared schemas, and the guidance in the system prompt', async () => {
    await turn('Please LIST my sessions.')
    const declared = requests[0].tools.map((tool) => tool.function)
    for (const spec of JSON.parse(piSessionToolsEnv()) as Array<{
      name: string
      description: string
      parameters: unknown
    }>) {
      const seen = declared.find((tool) => tool?.name === spec.name)
      expect(seen, `${spec.name} not declared`).toBeDefined()
      expect(seen!.description).toBe(spec.description)
      expect(seen!.parameters).toMatchObject(spec.parameters as object)
    }
    expect(SESSION_TOOL_NAMES.every((name) => declared.some((tool) => tool?.name === name))).toBe(
      true
    )
    // promptGuidelines of session_list land in the system prompt's guidelines.
    const system = textOf(requests[0].messages.find((m) => m.role === 'system')?.content)
    const { bullets } = sessionToolsGuidanceParts({ toolPrefix: '' })
    for (const bullet of bullets) expect(system).toContain(bullet)
  }, 60_000)

  it('a gated read round-trips through /hosted-tool and its text reaches the model', async () => {
    gateCalls.length = 0
    handled.length = 0
    const slice = await turn('Please LIST my sessions again.')
    expect(gateCalls.map((call) => call.toolName)).toEqual(['session_list'])
    expect(gateCalls[0].input).toEqual({ scope: 'linked' })
    expect(handled).toHaveLength(1)
    expect(handled[0]).toMatchObject({ toolName: 'session_list', input: { scope: 'linked' } })
    expect(handled[0].toolCallId).toBe(gateCalls[0].toolCallId)
    const result = toolResult(slice, 'session_list')
    expect(result, JSON.stringify(slice).slice(0, 3000)).not.toBeNull()
    expect(result!.isError).toBe(false)
    expect(result!.text).toBe('ref s-abc123 · Fix the flaky test')
  }, 60_000)

  it('a call the gate denies is an error with the reason and never reaches the handler', async () => {
    gateCalls.length = 0
    handled.length = 0
    const slice = await turn('Please STOP that other session.')
    expect(gateCalls.map((call) => call.toolName)).toEqual(['session_stop'])
    expect(handled).toHaveLength(0)
    const result = toolResult(slice, 'session_stop')
    expect(result, JSON.stringify(slice).slice(0, 3000)).not.toBeNull()
    expect(result!.isError).toBe(true)
    expect(result!.text).toContain('Refused: not within your family')
  }, 60_000)
})
