/**
 * pi in-pi subagent integration GUARD test (M5b).
 *
 * This is the proof for M5b: the ClaudeUI-owned subagent extension
 * (pi-subagent-source.ts) + the approval bridge (pi-bridge-source.ts), BOTH
 * spawned exactly the way PiSession.doStart() spawns them (real PiRpcClient,
 * real `-e <bridge file> -e <subagent file>`, real env vars — including
 * CLAUDEUI_PI_SUBAGENTS=1 and CLAUDEUI_PI_AGENTS_DIR pointing at a fixture
 * agent def), provably registers `subagent` as a callable tool and a real
 * model's real tool call against it spawns a REAL child `pi` process (the
 * SAME vendored binary) that runs a real model turn of its own and reports
 * back. Mirrors pi-hosted-tools.integration.test.ts's identical
 * "unit tests mock the seam, this file proves the seam is real" rationale —
 * pi-subagent-source.test.ts already covers the extension's own logic
 * (discovery/delta-streaming/abort/cleanup) against a MOCKED child process;
 * this file is the one place that proves two REAL pi processes talk to each
 * other correctly.
 *
 * Gated: PI_INTEGRATION_TESTS=1 AND a real `openai-codex` credential in
 * ~/.pi/agent/auth.json (read-only — this file never writes to it). Uses the
 * REAL vendored pi binary and makes REAL model API calls against a small/
 * cheap model (gpt-5.6-luna — already verified end-to-end in
 * pi-bridge.integration.test.ts / pi-hosted-tools.integration.test.ts). Same
 * shared-refresh-token caveat as those files applies here. The CHILD process
 * (spawned by the extension itself, not by this test) inherits whatever
 * model/auth the vendored binary resolves from ~/.pi/agent/settings.json —
 * CLAUDEUI_PI_SUBAGENT_DEFAULT_MODEL is deliberately set below so the child
 * uses the SAME cheap model as the parent, rather than whatever default the
 * dev machine's settings.json happens to have.
 *
 * ONE model turn (parent) + ONE child turn (subagent), per the kickoff spec —
 * kept minimal to bound cost/flakiness. Session files land under a tmp
 * `--session-dir`; generous timeouts (two real API calls + two process
 * spawns in sequence).
 *
 * Run manually:
 *   PI_INTEGRATION_TESTS=1 bunx vitest run --project integration -t pi
 */

// @vitest-environment node

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { existsSync, mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir, homedir } from 'node:os'
import { join } from 'node:path'
import { PiRpcClient } from '../../core/pi/PiRpcClient'
import { PiBridgeHost, writeBridgeExtension, writeSubagentExtension } from '../../core/pi/PiBridgeHost'

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

// Evaluated once at collection time so describe.skipIf can gate on it even
// when PI_INTEGRATION_TESTS=1 is set — "skip gracefully", not a hard failure.
const BINARY_MISSING = !findBinary()
const CREDENTIALS_MISSING = !hasCodexCredentials()

/**
 * Fixture agent def — a trivial "echoer" that only ever needs `read` (an
 * agent-scope minimal enough to prove the wire without depending on any
 * other tool behaving correctly). Instructed to answer with a fixed,
 * greppable marker so the assertions below don't depend on model creativity.
 */
const ECHOER_MD = `---
name: echoer
description: Echoes back the task with a fixed marker prefix
tools: read
---
You are a trivial test agent. When given a task, respond with EXACTLY:
"ECHO: <the task text>" and nothing else. Do not call any tools. Do not add
any other commentary, punctuation, or formatting.
`

/** Find every `tool_execution_update` for the `subagent` tool carrying a `cuiSubagent` details payload, in wire order (loose-typed — see pi-rpc.integration.test.ts's identical precedent for why this file doesn't fight PiEvent's discriminated union in test code). */
function findSubagentUpdates(events: Record<string, unknown>[]): Array<Record<string, unknown>> {
  return events.filter((ev) => {
    if (ev.type !== 'tool_execution_update' || ev.toolName !== 'subagent') return false
    const partialResult = ev.partialResult as { details?: { cuiSubagent?: unknown } } | undefined
    return Boolean(partialResult?.details?.cuiSubagent)
  })
}

/** Find the `subagent` toolResult message_end and return its text content. */
function findSubagentToolResultText(events: Record<string, unknown>[]): string | null {
  for (const ev of events) {
    if (ev.type !== 'message_end') continue
    const msg = ev.message as Record<string, unknown> | undefined
    if (!msg || msg.role !== 'toolResult' || msg.toolName !== 'subagent') continue
    const content = (msg.content as Array<{ type: string; text?: string }>) ?? []
    return content
      .filter((b) => b.type === 'text')
      .map((b) => b.text ?? '')
      .join('')
  }
  return null
}

describe.skipIf(SKIP || BINARY_MISSING || CREDENTIALS_MISSING)('pi in-pi subagent integration (M5b)', () => {
  let client: PiRpcClient
  let bridgeHost: PiBridgeHost
  let tmpDir: string
  let agentsDir: string
  const events: Record<string, unknown>[] = []

  beforeAll(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'pi-subagent-guard-'))
    agentsDir = mkdtempSync(join(tmpdir(), 'pi-subagent-guard-agents-'))
    writeFileSync(join(agentsDir, 'echoer.md'), ECHOER_MD, 'utf-8')

    // Gate handler: real product code, always-allow (the 'task'-kind gating
    // policy for `subagent` itself is unit-tested in permission-engine.test.ts
    // — this integration test only proves the TRANSPORT + the extension's OWN
    // child-spawn logic, not the approval policy).
    const gateHandler = async (): Promise<{ behavior: 'allow' }> => ({ behavior: 'allow' })
    bridgeHost = new PiBridgeHost(gateHandler)
    const { url, token } = await bridgeHost.start()
    // Real product code — the SAME two file writers PiSession.doStart() calls.
    const bridgePath = writeBridgeExtension()
    const subagentPath = writeSubagentExtension()

    const binary = findBinary()!
    client = new PiRpcClient(binary, {
      cwd: tmpDir,
      args: ['--mode', 'rpc', '-e', bridgePath, '-e', subagentPath, '--session-dir', tmpDir],
      env: {
        CLAUDEUI_PI_BRIDGE_URL: url,
        CLAUDEUI_PI_BRIDGE_TOKEN: token,
        // The exact env vars PiSession.doStart() sets when capabilities.subagents
        // is true (M5b) — proves the real subagent extension registers under
        // this real gating, not a synthetic one. CLAUDEUI_PI_AGENTS_DIR
        // overrides the default `~/.pi/agent/agents` so this test never
        // touches the dev machine's real agent definitions.
        CLAUDEUI_PI_SUBAGENTS: '1',
        CLAUDEUI_PI_AGENTS_DIR: agentsDir,
        CLAUDEUI_PI_SUBAGENT_DEFAULT_MODEL: `${MODEL.provider}/${MODEL.modelId}`
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
    // Windows holds the cwd handle briefly after the parent (and any child)
    // process exits — wait, with a bounded fallback, before touching the tmp
    // dirs. Mirrors pi-hosted-tools.integration.test.ts's identical precedent.
    await new Promise((resolve) => setTimeout(resolve, 1_000))
    if (tmpDir) rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
    if (agentsDir) rmSync(agentsDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
  })

  /** Poll the shared events buffer until an `agent_settled` appears since `fromIndex` — the real turn-complete signal (docs/protocol-pi/README.md). Generous timeout: this turn spawns a SECOND real pi process that makes its OWN real model call. */
  async function waitForTurnEnd(fromIndex: number, timeoutMs = 120_000): Promise<Record<string, unknown>[]> {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      const slice = events.slice(fromIndex)
      if (slice.some((ev) => ev.type === 'agent_settled')) return slice
      await new Promise((resolve) => setTimeout(resolve, 300))
    }
    throw new Error(`turn did not settle within ${timeoutMs}ms — events so far: ${JSON.stringify(events.slice(fromIndex))}`)
  }

  it('a real model turn calls subagent -> a real child pi process runs -> cuiSubagent updates arrive -> the final result contains the child\'s answer', async () => {
    const fromIndex = events.length
    const resp = await client.request({
      type: 'prompt',
      message:
        "Call the subagent tool EXACTLY once with agent 'echoer' and task 'ping' -- no other tool calls, " +
        'no explanation, just make the call and then report back exactly what it returned.'
    })
    expect(resp.success).toBe(true)

    const turnEvents = await waitForTurnEnd(fromIndex, 120_000)

    const subagentUpdates = findSubagentUpdates(turnEvents)
    expect(
      subagentUpdates.length,
      `no tool_execution_update carried a cuiSubagent payload — events: ${JSON.stringify(turnEvents)}`
    ).toBeGreaterThan(0)

    const toolResultText = findSubagentToolResultText(turnEvents)
    expect(toolResultText, `subagent toolResult never arrived — events: ${JSON.stringify(turnEvents)}`).not.toBeNull()
    expect(toolResultText).toMatch(/ECHO:\s*ping/i)
  }, 150_000)
})
