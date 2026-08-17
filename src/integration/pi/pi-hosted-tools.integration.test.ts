/**
 * pi hosted-tools integration GUARD test (M4a).
 *
 * This is the proof for M4a: the ClaudeUI-owned bridge extension
 * (pi-bridge-source.ts) + PiBridgeHost, spawned exactly the way
 * PiSession.doStart() spawns them (real PiRpcClient, real `-e <bridge file>`,
 * real env vars — including CLAUDEUI_PI_HOSTED_TOOLS=1), provably registers
 * `render_mermaid` as a callable tool and a real model's real tool call
 * against it round-trips end-to-end through PiBridgeHost's `/hosted-tool`
 * route to a real hosted-tool handler (the SAME `createMermaidServer()`
 * handler PiSession.handleHostedTool delegates to — real product code, not a
 * reimplementation). If the hosted-tool wiring regresses (wrong env var,
 * extension fails to load, the route never answers, the parameters schema
 * the model sees is malformed, …) this test fails; unit tests mocking
 * createMermaidServer or sandboxing the extension source in-process (see
 * pi-bridge-source.test.ts) would never catch a real end-to-end break.
 *
 * dispatch_agent end-to-end (pi→claude/opencode) is deliberately NOT
 * exercised here — it needs a second engine live and is verified in the
 * real-app drive by the orchestrator (ADR-026), not in this gated unit-level
 * integration file. This file only asserts dispatch_agent (and the OTHER two
 * hosted tools) are correctly REGISTERED alongside render_mermaid when
 * CLAUDEUI_PI_DISPATCH_ENABLED=1 is also set — no model turn against it.
 *
 * Gated: PI_INTEGRATION_TESTS=1 AND a real `openai-codex` credential in
 * ~/.pi/agent/auth.json (read-only — this file never writes to it). Uses the
 * REAL vendored pi binary and makes REAL model API calls against a small/cheap
 * model (gpt-5.6-luna — already verified end-to-end in
 * pi-bridge.integration.test.ts and docs/protocol-pi/README.md's M0 auth
 * notes). Same shared-refresh-token caveat as that file applies here.
 *
 * Session files land under a tmp `--session-dir`; generous timeouts (real
 * API + tool-execution latency).
 *
 * Run manually:
 *   PI_INTEGRATION_TESTS=1 bunx vitest run --project integration -t pi
 */

// @vitest-environment node

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { existsSync, mkdtempSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir, homedir } from 'node:os'
import { join } from 'node:path'
import { PiRpcClient } from '../../core/pi/PiRpcClient'
import { PiBridgeHost, writeBridgeExtension } from '../../core/pi/PiBridgeHost'
import type { PiHostedToolPayload, PiHostedToolResult } from '../../core/pi/PiBridgeHost'
import { createMermaidServer } from '../../core/services/mermaid-tool'

const SKIP = !process.env.PI_INTEGRATION_TESTS
const BINARY_NAME = process.platform === 'win32' ? 'pi.exe' : 'pi'
const ROOT = join(__dirname, '..', '..', '..')
const MODEL = { provider: 'openai-codex', modelId: 'gpt-5.6-luna' }

function findBinary(): string | null {
  const candidate = join(ROOT, 'vendor', 'pi-cli', BINARY_NAME)
  return existsSync(candidate) ? candidate : null
}

/** Read-only check for a real openai-codex credential — never writes to auth.json. */
function hasCodexCredentials(): boolean {
  try {
    const raw = readFileSync(join(homedir(), '.pi', 'agent', 'auth.json'), 'utf-8')
    const parsed = JSON.parse(raw) as Record<string, unknown>
    return Boolean(parsed['openai-codex'])
  } catch {
    return false
  }
}

// Evaluated once at collection time so every `it`/describe.skipIf below can
// gate on it — "skip gracefully" even when PI_INTEGRATION_TESTS=1 is set.
const BINARY_MISSING = !findBinary()
const CREDENTIALS_MISSING = !hasCodexCredentials()

/** Find the render_mermaid toolResult message in a batch of raw wire events (loose-typed — see pi-rpc.integration.test.ts's identical precedent for why this file doesn't fight PiEvent's discriminated union in test code). */
function findMermaidToolResult(events: Record<string, unknown>[]): { isError: boolean; text: string } | null {
  for (const ev of events) {
    if (ev.type !== 'message_end') continue
    const msg = ev.message as Record<string, unknown> | undefined
    if (!msg || msg.role !== 'toolResult' || msg.toolName !== 'render_mermaid') continue
    const content = (msg.content as Array<{ type: string; text?: string }>) ?? []
    const text = content
      .filter((b) => b.type === 'text')
      .map((b) => b.text ?? '')
      .join('')
    return { isError: Boolean(msg.isError), text }
  }
  return null
}

describe.skipIf(SKIP || BINARY_MISSING || CREDENTIALS_MISSING)('pi hosted-tools integration (M4a)', () => {
  let client: PiRpcClient
  let bridgeHost: PiBridgeHost
  let tmpDir: string
  const events: Record<string, unknown>[] = []

  beforeAll(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'pi-hosted-tools-guard-'))

    // Gate handler: real product code, always-allow (the hosted-tool
    // auto-allow gating itself is unit-tested in permission-engine.test.ts —
    // this integration test only proves the TRANSPORT, not the gate policy).
    const gateHandler = async (): Promise<{ behavior: 'allow' }> => ({ behavior: 'allow' })
    // Hosted-tool handler: the SAME real createMermaidServer() handler
    // PiSession.handleHostedTool delegates to (real product code) for
    // render_mermaid; the other three names are handled minimally since no
    // model turn is driven against them in this file (see the file header).
    const mermaidServer = createMermaidServer()
    const hostedToolHandler = async (payload: PiHostedToolPayload): Promise<PiHostedToolResult> => {
      if (payload.toolName === 'render_mermaid') {
        const tool = mermaidServer.tools.find((t) => t.name === 'render_mermaid')!
        return (await tool.handler(payload.input, undefined)) as unknown as PiHostedToolResult
      }
      return { content: [{ type: 'text', text: `unhandled in this guard test: ${payload.toolName}` }] }
    }
    bridgeHost = new PiBridgeHost(gateHandler, hostedToolHandler)
    const { url, token } = await bridgeHost.start()
    // Also real product code — the SAME file writer PiSession.doStart() calls.
    const bridgePath = writeBridgeExtension()

    const binary = findBinary()!
    client = new PiRpcClient(binary, {
      cwd: tmpDir,
      args: ['--mode', 'rpc', '-e', bridgePath, '--session-dir', tmpDir],
      env: {
        CLAUDEUI_PI_BRIDGE_URL: url,
        CLAUDEUI_PI_BRIDGE_TOKEN: token,
        // The exact env vars PiSession.doStart() sets when capabilities.hostedMcp
        // / capabilities.crossEngineDispatch are true (M4a+b) — proves the real
        // bridge extension registers under this real gating, not a synthetic one.
        CLAUDEUI_PI_HOSTED_TOOLS: '1',
        CLAUDEUI_PI_DISPATCH_ENABLED: '1'
      }
    })
    client.onEvent((ev) => events.push(ev as unknown as Record<string, unknown>))
    await client.start()

    const setModelResp = await client.request({ type: 'set_model', provider: MODEL.provider, modelId: MODEL.modelId }, 45_000)
    expect(setModelResp.success, `set_model failed: ${JSON.stringify(setModelResp)}`).toBe(true)
  }, 45_000)

  afterAll(async () => {
    client?.dispose()
    bridgeHost?.dispose()
    // Windows holds the cwd handle briefly after the parent process exits —
    // wait, with a bounded fallback, before touching the tmp dir. Mirrors
    // pi-bridge.integration.test.ts's identical precedent.
    await new Promise((resolve) => setTimeout(resolve, 1_000))
    if (tmpDir) rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
  })

  /** Poll the shared events buffer until an `agent_settled` appears since `fromIndex` — the real turn-complete signal (docs/protocol-pi/README.md). */
  async function waitForTurnEnd(fromIndex: number, timeoutMs = 60_000): Promise<Record<string, unknown>[]> {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      const slice = events.slice(fromIndex)
      if (slice.some((ev) => ev.type === 'agent_settled')) return slice
      await new Promise((resolve) => setTimeout(resolve, 200))
    }
    throw new Error(`turn did not settle within ${timeoutMs}ms — events so far: ${JSON.stringify(events.slice(fromIndex))}`)
  }

  it('a real model turn calls render_mermaid and the tool_execution/message shows a successful tool result', async () => {
    const fromIndex = events.length
    const resp = await client.request({
      type: 'prompt',
      message:
        "Call the render_mermaid tool exactly once with EXACTLY source 'graph TD; A-->B' and nothing else " +
        '-- no explanation, no other tool calls, do not modify the source in any way.'
    })
    expect(resp.success).toBe(true)

    const turnEvents = await waitForTurnEnd(fromIndex)
    const toolResult = findMermaidToolResult(turnEvents)

    expect(
      toolResult,
      `model never called render_mermaid -- events: ${JSON.stringify(turnEvents)}`
    ).not.toBeNull()
    expect(toolResult!.isError).toBe(false)
    expect(toolResult!.text).toMatch(/rendered successfully/i)
  }, 90_000)
})
