/**
 * pi approval-bridge integration GUARD test.
 *
 * This is the proof for M2a: the ClaudeUI-owned bridge extension
 * (pi-bridge-source.ts) + PiBridgeHost, spawned exactly the way
 * PiSession.doStart() spawns them (real PiRpcClient, real `-e <bridge file>`,
 * real env vars), provably BLOCK a real model's real tool call end-to-end
 * against the pinned standalone pi binary — and that an allowed call still
 * goes through. If the bridge wiring regresses (wrong env var name, extension
 * fails to load, host never answers, …) this test fails; a change that only
 * touches test doubles elsewhere would never catch that.
 *
 * Gated: PI_INTEGRATION_TESTS=1 AND a real `openai-codex` credential in
 * ~/.pi/agent/auth.json (read-only — this file never writes to it). Uses the
 * REAL vendored pi binary and makes REAL model API calls against a small/cheap
 * model (gpt-5.6-luna — already verified end-to-end in docs/protocol-pi/
 * README.md's M0 auth notes). NOTE: pi auto-refreshes an expired OAuth token
 * in place; if this machine's ~/.pi openai-codex credential is a transplant
 * sharing a refresh token with an opencode `openai` credential, running this
 * test for real can rotate that shared token (see README.md's "Refresh-
 * rotation caveat") — accepted risk, per the M2a kickoff spec.
 *
 * Session files land under a tmp `--session-dir` (keeps ~/.pi/agent/sessions
 * clean); generous timeouts (real API + tool-execution latency).
 *
 * Run manually:
 *   PI_INTEGRATION_TESTS=1 bunx vitest run --project integration -t pi
 */

// @vitest-environment node

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { existsSync, mkdtempSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir, homedir } from 'node:os'
import { join } from 'node:path'
import { PiRpcClient } from '../../main/pi/PiRpcClient'
import { PiBridgeHost, writeBridgeExtension } from '../../main/pi/PiBridgeHost'
import type { GateDecision, PiToolCallPayload } from '../../main/pi/PiBridgeHost'

const SKIP = !process.env.PI_INTEGRATION_TESTS
const BINARY_NAME = process.platform === 'win32' ? 'pi.exe' : 'pi'
const ROOT = join(__dirname, '..', '..', '..')
const MODEL = { provider: 'openai-codex', modelId: 'gpt-5.6-luna' }
const DENY_TRIGGER = 'CLAUDEUI_DENY_ME'
const DENY_REASON = 'blocked by integration guard'

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

/** POSIX-ify a Windows path for use inside a bash command string — Git Bash + coreutils accept drive-letter paths with forward slashes; backslashes are shell escape characters. */
function toBashPath(p: string): string {
  return p.replace(/\\/g, '/')
}

/** Find the bash toolResult message in a batch of raw wire events (loose-typed — see pi-rpc.integration.test.ts's identical precedent for why this file doesn't fight PiEvent's discriminated union in test code). */
function findBashToolResult(events: Record<string, unknown>[]): { isError: boolean; text: string } | null {
  for (const ev of events) {
    if (ev.type !== 'message_end') continue
    const msg = ev.message as Record<string, unknown> | undefined
    if (!msg || msg.role !== 'toolResult' || msg.toolName !== 'bash') continue
    const content = (msg.content as Array<{ type: string; text?: string }>) ?? []
    const text = content
      .filter((b) => b.type === 'text')
      .map((b) => b.text ?? '')
      .join('')
    return { isError: Boolean(msg.isError), text }
  }
  return null
}

describe.skipIf(SKIP || BINARY_MISSING || CREDENTIALS_MISSING)('pi approval-bridge integration guard', () => {
  let client: PiRpcClient
  let bridgeHost: PiBridgeHost
  let tmpDir: string
  let markerPath: string
  const events: Record<string, unknown>[] = []

  beforeAll(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'pi-bridge-guard-'))
    markerPath = join(tmpDir, 'marker.txt')

    // The scripted local host: DENIES any bash command containing the trigger
    // string, ALLOWS everything else — real product code (PiBridgeHost), not
    // a reimplementation.
    const handler = async (payload: PiToolCallPayload): Promise<GateDecision> => {
      if (payload.toolName === 'bash' && String(payload.input.command ?? '').includes(DENY_TRIGGER)) {
        return { behavior: 'deny', reason: DENY_REASON }
      }
      return { behavior: 'allow' }
    }
    bridgeHost = new PiBridgeHost(handler)
    const { url, token } = await bridgeHost.start()
    // Also real product code — the SAME file writer PiSession.doStart() calls.
    const bridgePath = writeBridgeExtension()

    const binary = findBinary()!
    client = new PiRpcClient(binary, {
      cwd: tmpDir,
      args: ['--mode', 'rpc', '-e', bridgePath, '--session-dir', tmpDir],
      env: { CLAUDEUI_PI_BRIDGE_URL: url, CLAUDEUI_PI_BRIDGE_TOKEN: token }
    })
    client.onEvent((ev) => events.push(ev as unknown as Record<string, unknown>))
    await client.start()

    const setModelResp = await client.request({ type: 'set_model', provider: MODEL.provider, modelId: MODEL.modelId }, 45_000)
    expect(setModelResp.success, `set_model failed: ${JSON.stringify(setModelResp)}`).toBe(true)
  }, 45_000)

  afterAll(async () => {
    client?.dispose()
    bridgeHost?.dispose()
    // Windows holds the cwd handle briefly after the parent process exits
    // (bash sub-children under the `bash` tool release it slightly later) —
    // wait, with a bounded fallback, before touching the tmp dir. Mirrors
    // pi-rpc.integration.test.ts's identical precedent.
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

  it('denies a bash tool call containing the trigger string — the marker file is provably never created', async () => {
    const fromIndex = events.length
    const resp = await client.request({
      type: 'prompt',
      message:
        'Call the bash tool exactly once with EXACTLY this command and nothing else -- no explanation, ' +
        `no other tool calls, do not modify it in any way: touch ${toBashPath(markerPath)} # ${DENY_TRIGGER}`
    })
    expect(resp.success).toBe(true)

    const turnEvents = await waitForTurnEnd(fromIndex)
    const toolResult = findBashToolResult(turnEvents)

    expect(toolResult, `model never called the bash tool -- events: ${JSON.stringify(turnEvents)}`).not.toBeNull()
    expect(toolResult!.isError).toBe(true)
    expect(toolResult!.text).toContain(DENY_REASON)

    // The tool provably did not run.
    expect(existsSync(markerPath)).toBe(false)
  }, 90_000)

  it('allows a subsequent echo command -- the tool actually runs', async () => {
    const fromIndex = events.length
    const token = `claudeui-guard-${Date.now()}`
    const resp = await client.request({
      type: 'prompt',
      message: `Call the bash tool exactly once with EXACTLY this command and nothing else: echo ${token}`
    })
    expect(resp.success).toBe(true)

    const turnEvents = await waitForTurnEnd(fromIndex)
    const toolResult = findBashToolResult(turnEvents)

    expect(toolResult, `model never called the bash tool -- events: ${JSON.stringify(turnEvents)}`).not.toBeNull()
    expect(toolResult!.isError).toBe(false)
    expect(toolResult!.text).toContain(token)
  }, 90_000)
})
