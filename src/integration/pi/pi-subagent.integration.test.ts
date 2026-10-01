/**
 * pi host-run subagent integration GUARD test (ADR-088).
 *
 * The proof that a host-run child is real (S3: in the background by default,
 * notifying through a delivery, then resumed by send_message): `PiSubagentManager` spawns a REAL
 * `pi --mode rpc` child through the real `defaultSpawnPiChild` (real
 * PiBridgeHost, the real bridge extension file, the real child flags —
 * `--session-dir`/`--session-id`/`--append-system-prompt <file>`/`--tools` —
 * and the real child env), the child runs a real model turn, its output
 * streams under the spawning call id, the lifecycle events arrive in order,
 * and the persisted child session file lands under the manager's root.
 *
 * A HOST-RUN SMOKE, not a full PiSession drive (the kickoff allows this when a
 * full drive is impractical, and it is here): PiSession has no session-dir
 * seam, so a real PiSession turn would write the PARENT's session into
 * `~/.pi/agent/sessions` — which these tests never do. The parent half (the
 * bridge registering `agent` under CLAUDEUI_PI_AGENT_TOOL, the spawn rung, the
 * child gate and judge) is covered by pi-bridge-source.test.ts (the extension
 * source executed in-process) and PiSession.test.ts against mocks; this file
 * proves the child transport the mocks stand in for.
 *
 * Gated: PI_INTEGRATION_TESTS=1 AND a real `openai-codex` credential in
 * ~/.pi/agent/auth.json (read-only — this file never writes to it). TWO child
 * model turns (launch + resume) against a small/cheap model; the child's session lands under a
 * tmp root, never ~/.pi/agent/sessions.
 *
 * Run manually:
 *   PI_INTEGRATION_TESTS=1 bunx vitest run --project integration -t pi
 */

// @vitest-environment node

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir, homedir } from 'node:os'
import { join } from 'node:path'
import { locatePiBinary } from '../../core/pi/pi-locate'
import { loadPiAgentRegistry } from '../../core/pi/pi-agent-registry'
import { PiSubagentManager, type PiSubagentHost } from '../../core/pi/pi-subagents'
import type { PiAgentDelivery } from '../../core/pi/pi-delivery'

const SKIP = !process.env.PI_INTEGRATION_TESTS
const MODEL = 'openai-codex/gpt-5.6-luna'

/** Read-only check for a real openai-codex credential — never writes to auth.json. */
function hasCodexCredentials(): boolean {
  try {
    const agentDir = process.env.PI_CODING_AGENT_DIR ?? join(homedir(), '.pi', 'agent')
    const raw = readFileSync(join(agentDir, 'auth.json'), 'utf-8')
    const parsed = JSON.parse(raw) as Record<string, unknown>
    return Boolean(parsed['openai-codex'])
  } catch {
    return false
  }
}

const BINARY_MISSING = !locatePiBinary()
const CREDENTIALS_MISSING = !hasCodexCredentials()

describe.skipIf(SKIP || BINARY_MISSING || CREDENTIALS_MISSING)(
  'pi host-run subagent integration (ADR-088)',
  () => {
    let cwd: string
    let root: string
    const sent: Array<[string, unknown]> = []

    beforeAll(() => {
      cwd = mkdtempSync(join(tmpdir(), 'pi-subagent-cwd-'))
      root = mkdtempSync(join(tmpdir(), 'pi-subagent-root-'))
    })

    afterAll(async () => {
      // Windows holds the cwd handle briefly after the child exits.
      await new Promise((resolve) => setTimeout(resolve, 1_000))
      for (const dir of [cwd, root]) {
        if (dir) rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
      }
    })

    it('a real background Explore child runs, streams under the call id, notifies the parent through a delivery, persists its session, and resumes on it via send_message', async () => {
      const delivered: PiAgentDelivery[] = []
      const host: PiSubagentHost = {
        routingId: 'rid-integration',
        cwd,
        currentModel: () => MODEL,
        skillDirsEnv: () => ({}),
        send: (channel, data) => {
          sent.push([channel, data])
        },
        // Transport proof only: the gating policy is unit-tested.
        gateChild: async () => ({ behavior: 'allow' }),
        childAbandoned: () => {},
        retractChildGates: () => {},
        // The parent here is the test: a root-owned notification lands in this list.
        deliverToSession: (payload) => {
          delivered.push(payload)
        },
        backgroundWorkChanged: () => {}
      }
      const manager = new PiSubagentManager(host, {
        registry: loadPiAgentRegistry({ cwd, userAgentsDir: join(cwd, 'no-user-agents') }),
        sessionsRoot: root
      })

      // Background is the default (ADR-088 S3, D2): the call returns at once.
      const result = await manager.run(
        {
          description: 'Echo a marker',
          prompt: 'Do not call any tools. Reply with exactly: ECHO ping',
          subagent_type: 'Explore',
          name: 'echoer'
        },
        'call-integration-1',
        null
      )
      expect(result.isError, JSON.stringify(result)).toBeUndefined()
      expect(result.content[0].text).toMatch(/^Async agent launched successfully\./)

      // The completion arrives as a task-notification delivery to the root.
      await vi.waitFor(() => expect(delivered).toHaveLength(1), { timeout: 120_000, interval: 250 })
      expect(delivered[0]).toMatchObject({
        kind: 'task-notification',
        wake: true,
        details: { toolUseId: 'call-integration-1', status: 'completed', runIndex: 1 }
      })
      expect(delivered[0].text).toMatch(/<result>[\s\S]*ECHO:?\s*ping/i)

      const channels = sent.map(([c]) => c)
      const startIdx = channels.indexOf('session:task-started')
      const noteIdx = channels.indexOf('session:task-notification')
      expect(startIdx).toBeGreaterThanOrEqual(0)
      expect(noteIdx).toBeGreaterThan(startIdx)
      const streamed = sent.filter(
        ([c, d]) =>
          (c === 'session:item-seal' &&
            (d as { ownerToolUseId?: string }).ownerToolUseId === 'call-integration-1') ||
          (c === 'session:subagent-message' &&
            (d as { toolUseId?: string }).toolUseId === 'call-integration-1')
      )
      expect(streamed.length).toBeGreaterThan(0)

      const details = result.details as { cuiAgent: { agentId: string } }
      const childDir = join(root, details.cuiAgent.agentId)
      const files = readdirSync(childDir)
      expect(files).toContain('system-prompt.md')
      expect(files.some((f) => f.endsWith(`_${details.cuiAgent.agentId}.jsonl`))).toBe(true)

      // A second turn: send_message resumes the finished agent on the SAME
      // session file (one more small model turn), started by a host-built
      // delivery, and it notifies again with runIndex 2.
      const resumed = await manager.sendMessage(
        { to: 'echoer', message: 'Do not call any tools. Reply with exactly: ECHO pong' },
        null
      )
      expect(resumed.content[0].text).toBe(
        'Resuming agent echoer. You will be notified when it completes.'
      )
      await vi.waitFor(() => expect(delivered).toHaveLength(2), { timeout: 120_000, interval: 250 })
      expect(delivered[1].details).toMatchObject({ runIndex: 2, status: 'completed' })
      expect(delivered[1].text).toMatch(/ECHO:?\s*pong/i)
      expect(
        readdirSync(childDir).filter((f) => f.endsWith(`_${details.cuiAgent.agentId}.jsonl`))
      ).toHaveLength(1)
    }, 300_000)
  }
)
