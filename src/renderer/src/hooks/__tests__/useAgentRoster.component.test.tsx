/**
 * Layer 2: the roster selector (ADR-073).
 *
 * The roster must be engine-neutral — it is built from the `task` ToolView
 * kind, not from Claude's `activeTasks` — and it must keep the ADR-040 split:
 * an engine that reports lifecycle events gets exact running state, one that
 * does not keeps the legacy tool_result heuristic.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import React from 'react'
import { render, act } from '@testing-library/react'
import { useSessionStore } from '../../stores/session-store'
import { bootTestApp, type TestApp } from '@test/helpers/boot-test-app'
import { useAgentRoster, scanTranscriptCached, type AgentRoster } from '../useAgentRoster'
import type { ChatMessage } from '../../../../shared/types'

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
    expect(seen).toEqual({ agents: [], shells: [], runningCount: 0, totalCount: 0 })
  })

  it('lists agents and background shells separately, in transcript order', async () => {
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
      ]
    })
    await renderProbe()

    expect(seen?.agents.map((r) => r.name)).toEqual(['reviewer', 'Plan'])
    expect(seen?.agents[0].badge).toBe('Explore')
    expect(seen?.agents[0].description).toBe('audit the reducer')
    expect(seen?.shells.map((r) => r.name)).toEqual(['bun'])
    expect(seen?.totalCount).toBe(3)
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
