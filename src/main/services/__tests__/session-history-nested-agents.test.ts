/**
 * @vitest-environment node
 *
 * ADR-073 §7 — a reopened session loads its NESTED agents.
 *
 * `loadSessionHistory` learns each depth-1 agent from its spawn result in the
 * main transcript. A nested agent's spawn result lives in its parent agent's
 * transcript, so pre-fix it was never in `agentIdToToolUseId`, the Sidebar
 * never loaded its transcript, and the roster never listed it. Every agent has
 * a sidecar (`subagents/agent-<id>.meta.json`); a nested one names its
 * `parentAgentId` and its origin `toolUseId`. Shapes are the S0 probe's
 * (cli.js 2.1.280, 2026-09-30).
 *
 * `CLAUDE_PROJECTS_DIR` derives from os.homedir() at module load, so homedir is
 * mocked to a temp dir BEFORE importing session-history. Never the real one.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'

vi.mock('os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('os')>()
  const { join } = await import('path')
  const home = join(actual.tmpdir(), `claudeui-nested-history-${process.pid}`)
  return { ...actual, homedir: (): string => home }
})

import { loadSessionHistory } from '../../../core/services/session-history'

const TMP_HOME = os.homedir()
const PROJECT_KEY = 'test-project-nested'
const SESSION_ID = '11111111-2222-3333-4444-555555555555'
const TS = '2026-09-30T04:03:00.000Z'

const AGENT_A = 'af110ad6ad039a313'
const AGENT_B = 'ae1c808a813a4dcb5'
const ORIGIN_A = 'toolu_0154emGrqXM4zdunsk8jurMs'
const ORIGIN_B = 'toolu_01Qgsza72xfqotM1PXQbVMoj'

const sessionDir = (): string => path.join(TMP_HOME, '.claude', 'projects', PROJECT_KEY)
const subagentsDir = (): string => path.join(sessionDir(), SESSION_ID, 'subagents')

function writeMain(lines: object[]): void {
  fs.mkdirSync(sessionDir(), { recursive: true })
  fs.writeFileSync(
    path.join(sessionDir(), `${SESSION_ID}.jsonl`),
    lines.map((l) => JSON.stringify(l)).join('\n') + '\n'
  )
}

function writeSidecar(agentId: string, meta: Record<string, unknown>): void {
  fs.mkdirSync(subagentsDir(), { recursive: true })
  fs.writeFileSync(path.join(subagentsDir(), `agent-${agentId}.meta.json`), JSON.stringify(meta))
}

/** Main transcript: A's spawn and its async-launch result, then B's notification (S0 finding 4). */
const MAIN = [
  {
    type: 'assistant',
    message: {
      id: 'msg_a',
      role: 'assistant',
      content: [
        {
          type: 'tool_use',
          id: ORIGIN_A,
          name: 'Agent',
          input: { name: 'probenesta', description: 'probe nested a', run_in_background: true }
        }
      ]
    },
    uuid: 'a1',
    timestamp: TS
  },
  {
    type: 'user',
    message: {
      role: 'user',
      content: [
        {
          type: 'tool_result',
          tool_use_id: ORIGIN_A,
          content: `Async agent launched successfully.\nagentId: ${AGENT_A} (internal ID)`
        }
      ]
    },
    toolUseResult: { agentId: AGENT_A, isAsync: true },
    uuid: 'r1',
    timestamp: TS
  },
  {
    type: 'user',
    message: {
      role: 'user',
      content: `<task-notification>\n<task-id>${AGENT_B}</task-id>\n<tool-use-id>${ORIGIN_B}</tool-use-id>\n<status>failed</status>\n<summary>Agent "probenestb" failed</summary>\n</task-notification>`
    },
    uuid: 'n1',
    timestamp: TS
  }
]

beforeEach(() => {
  fs.rmSync(TMP_HOME, { recursive: true, force: true })
  writeMain(MAIN)
  writeSidecar(AGENT_A, {
    agentType: 'general-purpose',
    name: 'probenesta',
    toolUseId: ORIGIN_A,
    spawnDepth: 1
  })
  writeSidecar(AGENT_B, {
    agentType: 'general-purpose',
    name: 'probenestb',
    toolUseId: ORIGIN_B,
    parentAgentId: AGENT_A,
    spawnDepth: 2
  })
})

afterEach(() => {
  fs.rmSync(TMP_HOME, { recursive: true, force: true })
})

describe('loadSessionHistory — nested agents', () => {
  it('maps a nested agent to its origin through its sidecar', async () => {
    const { agentIdToToolUseId } = await loadSessionHistory(SESSION_ID, PROJECT_KEY)
    expect(agentIdToToolUseId).toEqual({ [AGENT_A]: ORIGIN_A, [AGENT_B]: ORIGIN_B })
  })

  it("attributes the nested agent's notification to its origin", async () => {
    const { taskNotifications } = await loadSessionHistory(SESSION_ID, PROJECT_KEY)
    const b = taskNotifications.find((n) => n.taskId === AGENT_B)
    expect(b?.toolUseId).toBe(ORIGIN_B)
    expect(b?.status).toBe('failed')
  })

  it('ignores sidecars without a parent, with a bad id, or unreadable', async () => {
    writeSidecar('c0ffee', { toolUseId: 'toolu_top', spawnDepth: 1 })
    fs.writeFileSync(path.join(subagentsDir(), 'agent-bad.id.meta.json'), '{"toolUseId":"x"}')
    fs.writeFileSync(path.join(subagentsDir(), 'agent-broken.meta.json'), '{not json')
    const { agentIdToToolUseId } = await loadSessionHistory(SESSION_ID, PROJECT_KEY)
    expect(agentIdToToolUseId).toEqual({ [AGENT_A]: ORIGIN_A, [AGENT_B]: ORIGIN_B })
  })

  it('maps nothing extra when there is no subagents directory', async () => {
    fs.rmSync(path.join(sessionDir(), SESSION_ID), { recursive: true, force: true })
    const { agentIdToToolUseId } = await loadSessionHistory(SESSION_ID, PROJECT_KEY)
    expect(agentIdToToolUseId).toEqual({ [AGENT_A]: ORIGIN_A })
  })
})
