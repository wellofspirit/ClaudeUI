/**
 * Layer 2: the roster selector (ADR-073).
 *
 * The roster must be engine-neutral — agents are built from the `task`
 * ToolView kind, not from Claude's `activeTasks` — and it must keep the ADR-040
 * split: an engine that reports lifecycle events gets exact running state, one
 * that does not keeps the legacy tool_result heuristic.
 *
 * §7: agents are listed at every depth, as a tree; background shells come
 * from the live records and are listed only while they run.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import React from 'react'
import { render, act } from '@testing-library/react'
import { useSessionStore } from '../../stores/session-store'
import { bootTestApp, type TestApp } from '@test/helpers/boot-test-app'
import {
  useAgentRoster,
  scanTranscriptCached,
  scanAgentTree,
  rosterScanStats,
  type AgentRoster
} from '../useAgentRoster'
import type { ChatMessage } from '../../../../shared/types'
import { PI_ASYNC_LAUNCHED_PREFIX } from '../../../../shared/pi-agent-result'
import {
  A,
  A_BG_BASH,
  A_FG_BASH,
  B,
  B_FG_BASH,
  nestedActiveTasks,
  nestedBuckets,
  nestedMessages
} from '@test/factories/nested-agents'

const ROUTE = 'route-roster'

let seen: AgentRoster | null = null
function Probe(): React.JSX.Element | null {
  seen = useAgentRoster()
  return null
}

function assistantWithTool(
  id: string,
  toolUseId: string,
  toolName: string,
  toolInput: Record<string, unknown>
): ChatMessage {
  return {
    id,
    role: 'assistant',
    content: [{ type: 'tool_use', toolUseId, toolName, toolInput }],
    timestamp: Date.now()
  } as ChatMessage
}

function toolResult(id: string, toolUseId: string, isError = false): ChatMessage {
  return {
    id,
    role: 'user',
    content: [{ type: 'tool_result', toolUseId, toolResult: 'done', isError }],
    timestamp: Date.now()
  } as ChatMessage
}

function withEngine(engineId: string): Record<string, unknown> {
  return { status: { ...useSessionStore.getState().sessions[ROUTE].status, engineId } }
}

function setSession(patch: Record<string, unknown>): void {
  useSessionStore.setState((state) => ({
    sessions: { ...state.sessions, [ROUTE]: { ...state.sessions[ROUTE], ...patch } }
  }))
}

async function renderProbe(): Promise<void> {
  await act(async () => {
    render(React.createElement(Probe))
  })
}

describe('useAgentRoster', () => {
  let app: TestApp

  beforeEach(async () => {
    app = await bootTestApp()
    seen = null
    useSessionStore.getState().createNewSession(ROUTE, '/d/repo')
    useSessionStore.setState({ activeSessionId: ROUTE })
  })

  afterEach(() => {
    app.teardown()
    useSessionStore.setState({ activeSessionId: null, sessions: {} })
  })

  it('is empty for a session that spawned nothing', async () => {
    await renderProbe()
    expect(seen).toEqual({
      agents: [],
      shells: [],
      runningCount: 0,
      runningAgentCount: 0,
      runningShellCount: 0,
      totalCount: 0
    })
  })

  it('lists agents in transcript order and running background shells apart', async () => {
    setSession({
      messages: [
        assistantWithTool('m1', 'tu-a', 'Task', {
          name: 'reviewer',
          subagent_type: 'Explore',
          description: 'audit the reducer'
        }),
        assistantWithTool('m2', 'tu-sh', 'Bash', {
          command: 'bun run dev',
          run_in_background: true
        }),
        assistantWithTool('m3', 'tu-b', 'Task', { subagent_type: 'Plan', description: 'plan it' })
      ],
      activeTasks: { 'tu-sh': { taskId: 'b1', taskType: 'local_bash', isBackgrounded: true } }
    })
    await renderProbe()

    expect(seen?.agents.map((r) => r.name)).toEqual(['reviewer', 'Plan'])
    expect(seen?.agents[0].badge).toBe('Explore')
    expect(seen?.agents[0].description).toBe('audit the reducer')
    expect(seen?.shells.map((r) => r.name)).toEqual(['bun'])
    expect(seen?.shells[0].description).toBe('bun run dev')
    // Shells are not agents: the total counts agents only (§7).
    expect(seen?.totalCount).toBe(2)
    expect(seen?.runningShellCount).toBe(1)
  })

  // ADR-085 §3: the opencode host refuses a plan-mode `general` spawn before it
  // runs, and the refusal lands as a `permission_denial` on the task call.
  it('a refused spawn (a permission_denial on the task call) is no row', async () => {
    const refused: ChatMessage = {
      id: 'm1',
      role: 'assistant',
      content: [
        {
          type: 'tool_use',
          toolUseId: 'tu-refused',
          toolName: 'Task',
          toolInput: { subagent_type: 'general', description: 'edit things' }
        },
        {
          type: 'permission_denial',
          toolUseId: 'tu-refused',
          denialId: 'd1',
          source: 'mode',
          reason: 'Plan mode is read-only — present a plan and call exit_plan to proceed'
        }
      ],
      timestamp: Date.now()
    } as ChatMessage
    setSession({
      messages: [
        refused,
        toolResult('m2', 'tu-refused', true),
        assistantWithTool('m3', 'tu-ok', 'Task', { subagent_type: 'explore', description: 'look' })
      ]
    })
    await renderProbe()
    expect(seen?.agents.map((r) => r.toolUseId)).toEqual(['tu-ok'])
    expect(seen?.totalCount).toBe(1)
  })

  it('ignores ordinary tool calls', async () => {
    setSession({
      messages: [
        assistantWithTool('m1', 'tu-read', 'Read', { file_path: '/x' }),
        // A FOREGROUND bash is not a roster entry — it cannot outlive its turn.
        assistantWithTool('m2', 'tu-bash', 'Bash', { command: 'ls' })
      ]
    })
    await renderProbe()
    expect(seen?.totalCount).toBe(0)
    expect(seen?.shells).toEqual([])
  })

  // Seen live (2026-09-28): a Bash sent to the background with the card's button
  // never reached the roster, and the panel read "0 total" while it ran. Its
  // lifecycle record flips to isBackgrounded: true, and that record is what
  // lists it (§7).
  describe('a command cli.js moved to the background', () => {
    const movedResult = (id: string, toolUseId: string): ChatMessage =>
      ({
        id,
        role: 'user',
        content: [
          {
            type: 'tool_result',
            toolUseId,
            toolResult:
              'Command was manually backgrounded by user with ID: b7x2k9. Output is being written to: /tmp/claude/proj/session/tasks/b7x2k9.output.',
            isError: false
          }
        ],
        timestamp: Date.now()
      }) as ChatMessage
    const transcript = (): ChatMessage[] => [
      assistantWithTool('m1', 'tu-fg', 'Bash', { command: 'bun run build' }),
      movedResult('m2', 'tu-fg')
    ]
    const done = {
      taskId: 'b7x2k9',
      toolUseId: 'tu-fg',
      status: 'completed' as const,
      outputFile: '',
      summary: ''
    }

    it('is a background shell while its task runs, and is gone once it ends', async () => {
      setSession({
        messages: transcript(),
        activeTasks: { 'tu-fg': { taskId: 'b7x2k9', taskType: 'local_bash', isBackgrounded: true } }
      })
      await renderProbe()
      expect(seen?.shells.map((r) => r.name)).toEqual(['bun'])
      expect(seen?.shells[0].description).toBe('bun run build')
      expect(seen?.shells[0].isRunning).toBe(true)
      expect(seen?.runningCount).toBe(1)

      await act(async () => {
        setSession({ activeTasks: {}, taskNotifications: [done] })
      })
      expect(seen?.shells).toEqual([])
      expect(seen?.runningCount).toBe(0)
    })

    it('stays listed, finished, while its entry is open', async () => {
      setSession({
        messages: transcript(),
        taskNotifications: [done],
        openedTaskToolUseIds: ['tu-fg']
      })
      await renderProbe()
      expect(seen?.shells.map((r) => [r.toolUseId, r.isRunning])).toEqual([['tu-fg', false]])
      expect(seen?.runningCount).toBe(0)

      await act(async () => {
        setSession({ openedTaskToolUseIds: [] })
      })
      expect(seen?.shells).toEqual([])
    })

    it('is not a shell while its result is an ordinary one', async () => {
      setSession({
        messages: [
          assistantWithTool('m1', 'tu-fg', 'Bash', { command: 'ls' }),
          toolResult('m2', 'tu-fg')
        ]
      })
      await renderProbe()
      expect(seen?.totalCount).toBe(0)
      expect(seen?.shells).toEqual([])
    })
  })

  describe('nested agents (S0 shapes)', () => {
    it('lists a nested agent directly after the agent whose bucket holds its spawn', async () => {
      setSession({
        messages: [
          ...nestedMessages(),
          assistantWithTool('m-later', 'tu-later', 'Agent', { name: 'later', description: 'x' })
        ],
        subagentMessages: nestedBuckets()
      })
      await renderProbe()
      expect(seen?.agents.map((r) => [r.name, r.depth, r.parentToolUseId])).toEqual([
        ['probenesta', 0, undefined],
        ['probenestb', 1, A],
        ['later', 0, undefined]
      ])
      expect(seen?.totalCount).toBe(3)
    })

    it('nests again at depth 2, depth-first', async () => {
      const buckets = nestedBuckets()
      buckets[B] = [
        ...buckets[B],
        assistantWithTool('b-2', 'tu-c', 'Agent', { name: 'grandchild', description: 'deeper' })
      ]
      buckets[A] = [
        ...buckets[A],
        assistantWithTool('a-4', 'tu-b2', 'Agent', { name: 'second-child', description: 'y' })
      ]
      setSession({ messages: nestedMessages(), subagentMessages: buckets })
      await renderProbe()
      expect(seen?.agents.map((r) => [r.name, r.depth])).toEqual([
        ['probenesta', 0],
        ['probenestb', 1],
        ['grandchild', 2],
        ['second-child', 1]
      ])
      expect(seen?.agents[2].parentToolUseId).toBe(B)
    })

    it('counts a running nested agent whose parent has finished', async () => {
      setSession({
        messages: nestedMessages(),
        subagentMessages: nestedBuckets(),
        // A handed back and went idle while B still runs: the reported bug.
        activeTasks: { [B]: nestedActiveTasks()[B] },
        taskNotifications: [
          {
            taskId: 'af110ad6ad039a313',
            toolUseId: A,
            status: 'completed',
            outputFile: '',
            summary: ''
          }
        ]
      })
      await renderProbe()
      expect(seen?.agents.map((r) => r.isRunning)).toEqual([false, true])
      expect(seen?.runningCount).toBe(1)
      expect(seen?.runningAgentCount).toBe(1)
    })

    it('terminates on a bucket that holds its own spawn, and on a cycle', async () => {
      const root = [assistantWithTool('s-1', 'tu-s', 'Agent', { name: 'self' })]
      setSession({
        messages: root,
        subagentMessages: {
          'tu-s': [...root, assistantWithTool('s-2', 'tu-t', 'Agent', { name: 'child' })],
          // tu-t's bucket spawns tu-s again: a cycle back to the root.
          'tu-t': root
        }
      })
      await renderProbe()
      expect(seen?.agents.map((r) => [r.name, r.depth])).toEqual([
        ['self', 0],
        ['child', 1]
      ])
    })

    it('re-walks only the bucket whose array changed', () => {
      const messages = nestedMessages()
      const buckets = nestedBuckets()
      scanAgentTree(messages, buckets, 'claude')
      const before = rosterScanStats.walks
      // Nothing changed: every bucket is a cache hit.
      scanAgentTree(messages, buckets, 'claude')
      expect(rosterScanStats.walks).toBe(before)
      // A streaming delta replaces B's array only, as the reducer does.
      scanAgentTree(messages, { ...buckets, [B]: [...buckets[B]] }, 'claude')
      expect(rosterScanStats.walks).toBe(before + 1)
    })
  })

  // ADR-073 §7: a nested row that no lifecycle event describes cannot outlive
  // its parent. Without this, a refused Codex v2 grandchild (a `started` card
  // that never gets a result) or a pi/opencode child aborted mid-call reads
  // "running" forever.
  describe('a nested row with no lifecycle record', () => {
    const doneNotification = (toolUseId: string) => ({
      taskId: `task-${toolUseId}`,
      toolUseId,
      status: 'completed' as const,
      outputFile: '',
      summary: ''
    })

    it('settles as loaded, not running, under a finished parent (Codex v2 refused spawn)', async () => {
      setSession({
        ...withEngine('codex'),
        messages: [
          assistantWithTool('m1', 'tu-child', 'collab:spawnAgent', {
            agentPath: '/root/child',
            receiverThreadIds: ['thr-child'],
            agentsStates: {}
          })
        ],
        subagentMessages: {
          // The grandchild's `subAgentActivity started` card: no result, ever.
          'tu-child': [
            assistantWithTool('c1', 'tu-grandchild', 'collab:spawnAgent', {
              agentPath: '/root/child/grandchild',
              receiverThreadIds: ['thr-grandchild'],
              agentsStates: {}
            })
          ]
        },
        taskNotifications: [doneNotification('tu-child')]
      })
      await renderProbe()
      expect(seen?.agents.map((r) => [r.name, r.depth, r.isRunning, r.isLoaded])).toEqual([
        ['child', 0, false, false],
        ['grandchild', 1, false, true]
      ])
      expect(seen?.runningCount).toBe(0)
    })

    it('is not running once its parent is done (pi child aborted mid-call)', async () => {
      setSession({
        ...withEngine('pi'),
        messages: [
          assistantWithTool('m1', 'tu-parent', 'subagent', { agent: 'scout', task: 'look' }),
          toolResult('m2', 'tu-parent')
        ],
        subagentMessages: {
          'tu-parent': [
            assistantWithTool('p1', 'tu-nested', 'subagent', { agent: 'worker', task: 'dig' })
          ]
        }
      })
      await renderProbe()
      expect(seen?.agents.map((r) => [r.depth, r.isRunning, r.isLoaded])).toEqual([
        [0, false, false],
        [1, false, true]
      ])
    })

    it('reads done, not loaded, when it has a result', async () => {
      setSession({
        ...withEngine('pi'),
        messages: [
          assistantWithTool('m1', 'tu-parent', 'subagent', { agent: 'scout', task: 'look' }),
          toolResult('m2', 'tu-parent')
        ],
        subagentMessages: {
          'tu-parent': [
            assistantWithTool('p1', 'tu-nested', 'subagent', { agent: 'worker', task: 'dig' }),
            toolResult('p2', 'tu-nested')
          ]
        }
      })
      await renderProbe()
      expect(seen?.agents[1].isRunning).toBe(false)
      expect(seen?.agents[1].isLoaded).toBe(false)
    })

    it('settles top-down: a grandchild follows its settled parent', async () => {
      setSession({
        ...withEngine('pi'),
        messages: [
          assistantWithTool('m1', 'tu-a', 'subagent', { agent: 'a', task: 'x' }),
          toolResult('m2', 'tu-a')
        ],
        subagentMessages: {
          'tu-a': [assistantWithTool('a1', 'tu-b', 'subagent', { agent: 'b', task: 'y' })],
          'tu-b': [assistantWithTool('b1', 'tu-c', 'subagent', { agent: 'c', task: 'z' })]
        }
      })
      await renderProbe()
      expect(seen?.agents.map((r) => [r.depth, r.isRunning, r.isLoaded])).toEqual([
        [0, false, false],
        [1, false, true],
        [2, false, true]
      ])
    })

    it('keeps running while its parent runs', async () => {
      setSession({
        ...withEngine('pi'),
        messages: [
          assistantWithTool('m1', 'tu-parent', 'subagent', { agent: 'scout', task: 'look' })
        ],
        subagentMessages: {
          'tu-parent': [
            assistantWithTool('p1', 'tu-nested', 'subagent', { agent: 'worker', task: 'dig' })
          ]
        }
      })
      await renderProbe()
      expect(seen?.agents.map((r) => r.isRunning)).toEqual([true, true])
    })

    it('does not touch a Claude nested row WITH a record under an idle parent (the original bug)', async () => {
      setSession({
        messages: nestedMessages(),
        subagentMessages: nestedBuckets(),
        activeTasks: { [B]: nestedActiveTasks()[B] },
        taskNotifications: [doneNotification(A)]
      })
      await renderProbe()
      expect(seen?.agents.map((r) => [r.depth, r.isRunning])).toEqual([
        [0, false],
        [1, true]
      ])
    })
  })

  describe('a pi `agent` call with no lifecycle record', () => {
    // pi reads "background" from the launch result (ADR-089): the roster must
    // too, or a call refused before launch reads as a background run that
    // never notifies — "running" with a Stop button forever.
    const piResult = (toolUseId: string, toolResult: string, isError: boolean): ChatMessage =>
      ({
        id: `r-${toolUseId}`,
        role: 'user',
        content: [{ type: 'tool_result', toolUseId, toolResult, isError }],
        timestamp: Date.now()
      }) as ChatMessage

    it('a judge-denied or failed-to-start spawn is settled and failed, not running', async () => {
      setSession({
        ...withEngine('pi'),
        messages: [
          assistantWithTool('m1', 'tu-denied', 'agent', { description: 'd', prompt: 'go' }),
          piResult('tu-denied', 'Auto mode blocked this call', true),
          assistantWithTool('m2', 'tu-nomodel', 'agent', { description: 'd', prompt: 'go', model: 'x/y' }),
          piResult('tu-nomodel', 'Model not found: x/y', true)
        ]
      })
      await renderProbe()
      expect(seen?.agents.map((r) => [r.isRunning, r.isError])).toEqual([
        [false, true],
        [false, true]
      ])
      expect(seen?.runningCount).toBe(0)
    })

    it('a foreground run that returned is done; a launched one runs until notified', async () => {
      setSession({
        ...withEngine('pi'),
        messages: [
          assistantWithTool('m1', 'tu-fg', 'agent', { description: 'd', prompt: 'go' }),
          piResult('tu-fg', 'the answer', false),
          assistantWithTool('m2', 'tu-bg', 'agent', { description: 'd', prompt: 'go' }),
          piResult('tu-bg', `${PI_ASYNC_LAUNCHED_PREFIX} id=1`, false)
        ]
      })
      await renderProbe()
      expect(seen?.agents.map((r) => r.isRunning)).toEqual([false, true])
    })
  })

  describe('the shell rule (S0 shapes)', () => {
    const live = (): Record<string, unknown> => ({
      messages: nestedMessages(),
      subagentMessages: nestedBuckets(),
      activeTasks: nestedActiveTasks()
    })

    it("lists a subagent's run_in_background Bash, and no agent's foreground Bash", async () => {
      setSession(live())
      await renderProbe()
      expect(seen?.shells.map((r) => [r.toolUseId, r.name, r.description, r.depth])).toEqual([
        [A_BG_BASH, 'sleep', 'sleep 8; echo bg', 0]
      ])
      // Two agents and one shell run; the two foreground Bashes count nowhere.
      expect(seen?.runningAgentCount).toBe(2)
      expect(seen?.runningShellCount).toBe(1)
      expect(seen?.runningCount).toBe(3)
      expect(seen?.totalCount).toBe(2)
    })

    it('lists a top-level run_in_background Bash from its record', async () => {
      setSession({
        messages: [
          assistantWithTool('m1', 'tu-sh', 'Bash', {
            command: 'bun run dev',
            run_in_background: true
          })
        ],
        activeTasks: { 'tu-sh': { taskId: 'b1', taskType: 'local_bash', isBackgrounded: true } }
      })
      await renderProbe()
      expect(seen?.shells.map((r) => r.toolUseId)).toEqual(['tu-sh'])
    })

    it('lists a foreground Bash once a task_updated flip re-sends it as backgrounded', async () => {
      setSession(live())
      await renderProbe()
      expect(seen?.shells.map((r) => r.toolUseId)).toEqual([A_BG_BASH])

      // A timeout (or "Send to background") moves B's command: same run, now true.
      await act(async () => {
        setSession({
          activeTasks: {
            ...nestedActiveTasks(),
            [B_FG_BASH]: { ...nestedActiveTasks()[B_FG_BASH], isBackgrounded: true }
          }
        })
      })
      expect(seen?.shells.map((r) => r.toolUseId)).toEqual([A_BG_BASH, B_FG_BASH])
      expect(seen?.shells.map((r) => r.toolUseId)).not.toContain(A_FG_BASH)
    })

    it('does not list a record whose call cannot be found', async () => {
      setSession({
        activeTasks: { 'tu-ghost': { taskId: 'b9', taskType: 'local_bash', isBackgrounded: true } }
      })
      await renderProbe()
      expect(seen?.shells).toEqual([])
    })

    it('drops a finished shell unless its entry is open', async () => {
      const rest = { ...nestedActiveTasks() }
      delete rest[A_BG_BASH]
      const notification = {
        taskId: 'bxfh7umpu',
        toolUseId: A_BG_BASH,
        status: 'completed' as const,
        outputFile: '',
        summary: ''
      }
      setSession({ ...live(), activeTasks: rest, taskNotifications: [notification] })
      await renderProbe()
      expect(seen?.shells).toEqual([])

      await act(async () => {
        setSession({ openedTaskToolUseIds: [A_BG_BASH] })
      })
      expect(seen?.shells.map((r) => [r.toolUseId, r.isRunning])).toEqual([[A_BG_BASH, false]])
    })

    it('lists no shells in a reopened session', async () => {
      setSession({ ...live(), isHistorical: true })
      await renderProbe()
      expect(seen?.shells).toEqual([])
      expect(seen?.agents.map((r) => r.isRunning)).toEqual([false, false])
    })
  })

  it('takes running state from the lifecycle record when there is one', async () => {
    setSession({
      messages: [
        assistantWithTool('m1', 'tu-a', 'Task', { subagent_type: 'Explore' }),
        // The immediate "async agent launched" result must NOT read as finished.
        toolResult('m2', 'tu-a')
      ],
      activeTasks: { 'tu-a': { taskId: 'a1', taskType: 'local_agent' } }
    })
    await renderProbe()
    expect(seen?.agents[0].isRunning).toBe(true)
    expect(seen?.runningCount).toBe(1)
  })

  it('falls back to the legacy heuristic for an engine with no lifecycle events', async () => {
    setSession({
      messages: [assistantWithTool('m1', 'tu-a', 'Task', { subagent_type: 'Explore' })]
    })
    await renderProbe()
    // No result, no record → still running, exactly as the card decides.
    expect(seen?.agents[0].isRunning).toBe(true)

    setSession({
      messages: [
        assistantWithTool('m1', 'tu-a', 'Task', { subagent_type: 'Explore' }),
        toolResult('m2', 'tu-a')
      ]
    })
    await renderProbe()
    expect(seen?.agents[0].isRunning).toBe(false)
  })

  it('reports the latest run, its error state and its resume count', async () => {
    setSession({
      messages: [assistantWithTool('m1', 'tu-a', 'Task', { name: 'impl' })],
      taskNotifications: [
        {
          taskId: 'a1',
          toolUseId: 'tu-a',
          status: 'completed',
          outputFile: '',
          summary: '',
          runIndex: 1
        },
        {
          taskId: 'a1',
          toolUseId: 'tu-a',
          status: 'failed',
          outputFile: '',
          summary: '',
          runIndex: 2
        }
      ]
    })
    await renderProbe()

    const row = seen!.agents[0]
    expect(row.isRunning).toBe(false)
    expect(row.isError).toBe(true) // run 2's status, not run 1's
    expect(row.runIndex).toBe(2)
  })

  it('carries the live progress metrics when the engine sends them', async () => {
    setSession({
      messages: [assistantWithTool('m1', 'tu-a', 'Task', { name: 'reviewer' })],
      activeTasks: { 'tu-a': { taskId: 'a1', taskType: 'local_agent', runIndex: 2 } },
      taskProgressMap: {
        'tu-a': {
          toolUseId: 'tu-a',
          toolName: 'Task',
          parentToolUseId: null,
          elapsedTimeSeconds: 134,
          lastToolName: 'Grep',
          usage: { totalTokens: 34000, toolUses: 12, durationMs: 134000 }
        }
      }
    })
    await renderProbe()

    const row = seen!.agents[0]
    expect(row.elapsedSeconds).toBe(134)
    expect(row.lastToolName).toBe('Grep')
    expect(row.usage?.totalTokens).toBe(34000)
    expect(row.runIndex).toBe(2)
  })

  it("reports a finished run's final usage, not the last progress tick before it", async () => {
    // cli.js's last task_progress lands before the run's final turns; the
    // terminal notification carries the run's real total. Pre-fix the row kept
    // the stale tick (22.1k) while the card showed the final figure (23.7k).
    const progress = {
      toolUseId: 'tu-a',
      toolName: 'Task',
      parentToolUseId: null,
      elapsedTimeSeconds: 40,
      usage: { totalTokens: 22100, toolUses: 1, durationMs: 40000 }
    }
    const final = {
      taskId: 'a1',
      toolUseId: 'tu-a',
      status: 'completed' as const,
      outputFile: '',
      summary: 'TWO',
      runIndex: 2,
      usage: { totalTokens: 23700, toolUses: 1, durationMs: 50300 }
    }
    setSession({
      messages: [assistantWithTool('m1', 'tu-a', 'Task', { name: 'impl' })],
      taskProgressMap: { 'tu-a': progress },
      taskNotifications: [final]
    })
    await renderProbe()
    expect(seen!.agents[0].usage?.totalTokens).toBe(23700)

    // While a run is live the progress tick is the freshest figure there is.
    await act(async () => {
      setSession({
        activeTasks: { 'tu-a': { taskId: 'a1', taskType: 'local_agent', runIndex: 3 } }
      })
    })
    expect(seen!.agents[0].usage?.totalTokens).toBe(22100)

    // A stop reported for a dead process carries no usage — keep the last tick.
    await act(async () => {
      setSession({
        activeTasks: {},
        taskNotifications: [final, { ...final, status: 'stopped', runIndex: 3, usage: undefined }]
      })
    })
    expect(seen!.agents[0].usage?.totalTokens).toBe(22100)
  })

  it('shows nothing as running in a historical transcript', async () => {
    setSession({
      isHistorical: true,
      messages: [assistantWithTool('m1', 'tu-a', 'Task', { name: 'old' })],
      activeTasks: { 'tu-a': { taskId: 'a1', taskType: 'local_agent' } }
    })
    await renderProbe()
    expect(seen?.agents[0].isRunning).toBe(false)
    expect(seen?.runningCount).toBe(0)
  })

  it('walks the transcript once per message array, however many surfaces ask', async () => {
    const messages = [
      assistantWithTool('m1', 'tu-1', 'Agent', { description: 'one', subagent_type: 'Explore' })
    ]
    const first = scanTranscriptCached(messages, 'claude')
    expect(first).toHaveLength(1)
    // Same array identity → the very same result, no second walk.
    expect(scanTranscriptCached(messages, 'claude')).toBe(first)
    // A different engine reads the same blocks through a different tool map.
    expect(scanTranscriptCached(messages, 'opencode')).not.toBe(first)
    // A new array (what the store produces on every change) is a new walk.
    expect(scanTranscriptCached([...messages], 'claude')).not.toBe(first)
    expect(scanTranscriptCached([...messages], 'claude')).toEqual(first)
  })
})
