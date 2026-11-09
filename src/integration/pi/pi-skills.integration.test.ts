/**
 * pi + ClaudeUI's shared Claude skill catalog, end to end, with NO credential and NO network.
 *
 * The real pinned pi binary, the real bridge extension (`writeBridgeExtension`) and the real
 * `PiBridgeHost` serving `/skills`, against an OpenAI-compatible chat-completions stand-in on
 * 127.0.0.1 (declared in the ISOLATED agent dir's `models.json`) that records every request. The
 * observable: the system prompt of the request the model receives lists the catalog's
 * model-invocable skills (added at `before_agent_start`), not a hidden one, and a skill pi already
 * lists under the same name keeps pi's own description. The catalog is a hand-built fixture (a
 * real resolver is not this test's subject).
 *
 * Isolation as pi-mcp.integration.test.ts: `PI_CODING_AGENT_DIR` is a temp dir, pi runs offline.
 * Skips when no pi is installed.
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
import { buildPiSkillDescriptors } from '../../core/pi/pi-skill-bridge'
import type { ClaudeSkillEntry } from '../../core/services/claude-skill-catalog'

const LAUNCH = locatePiLaunch()
const PROVIDER = 'cui-fixture'
const MODEL_ID = 'fixture-model'

function entry(over: Partial<ClaudeSkillEntry>): ClaudeSkillEntry {
  const name = over.name ?? 'x'
  return {
    name,
    kind: 'skill',
    source: 'user',
    file: `/claude/skills/${name}/SKILL.md`,
    baseDir: `/claude/skills/${name}`,
    description: '',
    argumentNames: [],
    body: '',
    userInvocable: true,
    modelInvocable: true,
    claudeOnly: [],
    ...over
  }
}

const SSE_ANSWER =
  `data: ${JSON.stringify({ id: 'c', object: 'chat.completion.chunk', created: 0, model: MODEL_ID, choices: [{ index: 0, delta: { role: 'assistant', content: 'ok' }, finish_reason: null }] })}\n\n` +
  `data: ${JSON.stringify({ id: 'c', object: 'chat.completion.chunk', created: 0, model: MODEL_ID, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })}\n\n` +
  `data: ${JSON.stringify({ id: 'c', object: 'chat.completion.chunk', created: 0, model: MODEL_ID, choices: [], usage: { prompt_tokens: 10, completion_tokens: 1, total_tokens: 11 } })}\n\n` +
  'data: [DONE]\n\n'

describe.skipIf(!LAUNCH)('pi + the shared Claude skill catalog (credential-free)', () => {
  let dir: string
  let provider: Server
  let bridgeHost: PiBridgeHost
  let client: PiRpcClient
  const requests: Array<{ messages: Array<{ role: string; content?: unknown }> }> = []
  const events: Record<string, unknown>[] = []

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'pi-skills-it-'))
    const agentDir = join(dir, 'agent')
    const cwd = join(dir, 'work')
    mkdirSync(cwd, { recursive: true })
    // pi's OWN skill of the name `dup`: it must keep its description (pi's skills win a clash).
    const own = join(agentDir, 'skills', 'dup')
    mkdirSync(own, { recursive: true })
    writeFileSync(
      join(own, 'SKILL.md'),
      '---\nname: dup\ndescription: PI-OWN-DESCRIPTION\n---\n\n# dup\n'
    )

    provider = createServer((req, res) => {
      let raw = ''
      req.on('data', (c) => (raw += c))
      req.on('end', () => {
        if (req.method !== 'POST' || !req.url?.endsWith('/chat/completions')) {
          res.writeHead(404).end()
          return
        }
        requests.push(JSON.parse(raw))
        res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
        res.end(SSE_ANSWER)
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

    const skills = buildPiSkillDescriptors({
      entries: [
        entry({ name: 'deploy', description: 'DEPLOY-DESCRIPTION', whenToUse: 'WHEN-TO-DEPLOY' }),
        entry({ name: 'p:helper', source: 'plugin', description: 'PLUGIN-DESCRIPTION' }),
        entry({ name: 'hidden', description: 'HIDDEN-DESCRIPTION', modelInvocable: false }),
        entry({ name: 'dup', description: 'CATALOG-DESCRIPTION' })
      ],
      skipped: []
    })
    bridgeHost = new PiBridgeHost(async () => ({ behavior: 'allow' }), undefined, { skills })
    const bridge = await bridgeHost.start()

    client = new PiRpcClient(LAUNCH!, {
      cwd,
      args: ['--mode', 'rpc', '--no-session', '-e', writeBridgeExtension()],
      env: {
        PI_CODING_AGENT_DIR: agentDir,
        PI_OFFLINE: '1',
        PI_SKIP_VERSION_CHECK: '1',
        PI_TELEMETRY: '0',
        CLAUDEUI_PI_BRIDGE_URL: bridge.url,
        CLAUDEUI_PI_BRIDGE_TOKEN: bridge.token,
        CLAUDEUI_PI_SKILLS: '1',
        CLAUDEUI_PI_MCP: '',
        CLAUDEUI_PI_HOSTED_TOOLS: '',
        CLAUDEUI_PI_DISPATCH_ENABLED: '',
        CLAUDEUI_PI_PLAN_TOOLS: '',
        CLAUDEUI_PI_AGENT_TOOL: '',
        CLAUDEUI_PI_SEND_MESSAGE: ''
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
    const exited = new Promise<void>((resolve) => {
      if (!client?.pid) return resolve()
      const timer = setTimeout(resolve, 5000)
      client.onExit(() => {
        clearTimeout(timer)
        resolve()
      })
    })
    client?.dispose()
    bridgeHost?.dispose()
    await exited
    await new Promise<void>((resolve) => (provider ? provider.close(() => resolve()) : resolve()))
    if (dir) rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
  })

  it("the model's request lists the catalog's model-invocable skills; pi's own same-named skill wins", async () => {
    const resp = await client.request({ type: 'prompt', message: 'hello' }, 30_000)
    expect(resp.success, JSON.stringify(resp)).toBe(true)
    const deadline = Date.now() + 45_000
    while (!events.some((ev) => ev.type === 'agent_settled') && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
    expect(requests.length).toBeGreaterThan(0)
    const system = JSON.stringify(
      requests[0].messages.filter((m) => m.role === 'system' || m.role === 'developer')
    )
    expect(system).toContain('<name>deploy</name>')
    expect(system).toContain('DEPLOY-DESCRIPTION - WHEN-TO-DEPLOY')
    expect(system).toContain('<name>p:helper</name>')
    expect(system).toContain('/claude/skills/deploy/SKILL.md')
    // Not model-invocable: never listed.
    expect(system).not.toContain('HIDDEN-DESCRIPTION')
    // pi's own skill of the same name keeps its text; the catalog's is not added beside it.
    expect(system).toContain('PI-OWN-DESCRIPTION')
    expect(system).not.toContain('CATALOG-DESCRIPTION')
  }, 90_000)
})
