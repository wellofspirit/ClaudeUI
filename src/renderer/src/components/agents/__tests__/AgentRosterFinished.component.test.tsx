/**
 * Layer 2: a FINISHED agent is not drawn as running (ADR-073, ADR-040).
 *
 * Seeded as the real events leave the store, then read through the list the panel
 * draws (`useAgentRoster` -> `AgentRosterList`) with the Running filter on.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import React from 'react'
import { render, screen, act, cleanup } from '@testing-library/react'
import { useSessionStore } from '../../../stores/session-store'
import { bootTestApp, type TestApp } from '@test/helpers/boot-test-app'
import { useAgentRoster } from '../../../hooks/useAgentRoster'
import { AgentRosterList } from '../AgentRosterList'
import type { ChatMessage, TaskNotification } from '../../../../../shared/types'
import {
  A,
  A_BG_BASH,
  B,
  nestedActiveTasks,
  nestedBuckets,
  nestedMessages
} from '@test/factories/nested-agents'

const ROUTE = 'route-roster-finished'

function List({ selectedIds }: { selectedIds: string[] }): React.JSX.Element {
  return <AgentRosterList roster={useAgentRoster()} selectedIds={selectedIds} onOpen={() => {}} />
}

function spawn(toolUseId: string, toolName: string, toolInput: Record<string, unknown>) {
  return {
    id: `a-${toolUseId}`,
    role: 'assistant',
    content: [{ type: 'tool_use', toolUseId, toolName, toolInput }],
    timestamp: Date.now()
  } as ChatMessage
}

function result(toolUseId: string, text: string) {
  return {
    id: `r-${toolUseId}`,
    role: 'user',
    content: [{ type: 'tool_result', toolUseId, toolResult: text, isError: false }],
    timestamp: Date.now()
  } as ChatMessage
}

function setSession(patch: Record<string, unknown>): void {
  useSessionStore.setState((state) => ({
    sessions: { ...state.sessions, [ROUTE]: { ...state.sessions[ROUTE], ...patch } }
  }))
}

async function renderList(selectedIds: string[] = []): Promise<void> {
  await act(async () => {
    render(<List selectedIds={selectedIds} />)
  })
}

describe('a finished agent in the roster', () => {
  let app: TestApp

  beforeEach(async () => {
    app = await bootTestApp()
    useSessionStore.getState().createNewSession(ROUTE, '/d/repo')
    useSessionStore.setState({ activeSessionId: ROUTE })
  })

  afterEach(() => {
    app.teardown()
    useSessionStore.setState({ activeSessionId: null, sessions: {} })
  })

  // Case A: a BLOCKING cross-engine dispatch. Its tool_result returned with the
  // child's answer and the dispatcher sent its final notification, which dropped
  // the lifecycle record the run armed at its start (ADR-105).
  const dispatchSession = (): void =>
    setSession({
      messages: [
        spawn('tu-disp', 'mcp__claude-ui-collab__dispatch_agent', {
          engine: 'pi',
          prompt: 'Read the image',
          name: 'img-check'
        }),
        result('tu-disp', 'The image shows HELLO')
      ],
      activeTasks: {},
      taskNotifications: [
        {
          taskId: 'child-session',
          toolUseId: 'tu-disp',
          status: 'completed',
          outputFile: '',
          summary: 'The image shows HELLO'
        } satisfies TaskNotification
      ]
    })

  // Case B: a native background Agent that finished through SubagentHandback.
  // cli.js armed a record at task_started; the terminal event dropped it.
  const handbackSession = (): void =>
    setSession({
      messages: [
        spawn('tu-bg', 'Agent', {
          description: 'Wait 20 seconds',
          subagent_type: 'general-purpose'
        }),
        result('tu-bg', 'Async agent launched successfully.')
      ],
      activeTasks: {},
      taskNotifications: [
        {
          taskId: 'a1',
          toolUseId: 'tu-bg',
          status: 'completed',
          outputFile: '',
          summary: 'Wait 20 seconds',
          handback: 'send',
          runIndex: 1
        } as TaskNotification
      ]
    })

  for (const [label, seed, id] of [
    ['a dispatch whose tool_result returned (case A)', dispatchSession, 'tu-disp'],
    ['a background Agent that handed back (case B)', handbackSession, 'tu-bg']
  ] as const) {
    describe(label, () => {
      it('is not under Running, and is not a running row', async () => {
        seed()
        await renderList()
        expect(screen.queryAllByTestId('AgentRow')).toHaveLength(0)
        expect(screen.getByTestId('AgentRoster.summary').textContent).not.toContain('running')
      })

      it('stays listed while open, as a grey DONE dot rather than running', async () => {
        seed()
        await renderList([id])
        const rowEl = screen.getByTestId('AgentRow')
        expect(rowEl.getAttribute('data-running')).toBe('false')
        const dot = screen.getByTestId('AgentRow.status')
        expect(dot.getAttribute('data-status')).toBe('done')
        expect(dot.getAttribute('data-state')).toBe('inactive')
      })
    })
  }

  // A dispatch RUN in flight (ADR-105): the dispatcher arms a `dispatch` record at its
  // start, blocking or background, and the final notification disarms it.
  describe('a dispatch run in flight', () => {
    const inFlight = (background: boolean, launched: boolean): void =>
      setSession({
        messages: [
          spawn('tu-run', 'mcp__claude-ui-collab__dispatch_agent', {
            engine: 'pi',
            prompt: 'go',
            name: 'runner',
            ...(background ? { run_in_background: true } : {})
          }),
          ...(launched ? [result('tu-run', 'X-Agent runner launched on pi (id s-run).')] : [])
        ],
        activeTasks: {
          'tu-run': {
            taskId: 's-run',
            taskType: 'dispatch',
            isBackgrounded: background,
            wakesParent: true
          }
        },
        taskNotifications: []
      })
    const finish = (): void =>
      setSession({
        activeTasks: {},
        taskNotifications: [
          {
            taskId: 's-run',
            toolUseId: 'tu-run',
            status: 'completed',
            outputFile: '',
            summary: 'all done'
          } satisfies TaskNotification
        ]
      })

    for (const [label, background, launched] of [
      ['a blocking run (record, no tool_result yet)', false, false],
      ['a background run (launch ack + record)', true, true]
    ] as const) {
      it(`${label} is a running row, and a grey DONE one once it notifies`, async () => {
        inFlight(background, launched)
        await renderList()
        expect(screen.getAllByTestId('AgentRow')).toHaveLength(1)
        expect(screen.getByTestId('AgentRow').getAttribute('data-running')).toBe('true')

        cleanup()
        finish()
        await renderList(['tu-run'])
        expect(screen.getByTestId('AgentRow').getAttribute('data-running')).toBe('false')
        expect(screen.getByTestId('AgentRow.status').getAttribute('data-status')).toBe('done')
      })
    }
  })

  // A finished agent is alive in effect while anything it launched still runs
  // (ADR-073 §11): steady green. Grey only once nothing below it runs. Never dimmed.
  describe('a finished agent with live descendants', () => {
    const done = (toolUseId: string): TaskNotification => ({
      taskId: `n-${toolUseId}`,
      toolUseId,
      status: 'completed',
      outputFile: '',
      summary: ''
    })
    const nested = (activeTasks: Record<string, unknown>, finished: string[]): void =>
      setSession({
        messages: nestedMessages(),
        subagentMessages: nestedBuckets(),
        activeTasks,
        taskNotifications: finished.map(done)
      })
    const rowOf = (id: string): HTMLElement =>
      screen
        .getAllByTestId('AgentRow')
        .find((r) => r.getAttribute('data-tool-use-id') === id) as HTMLElement
    const dotOf = (id: string): HTMLElement =>
      rowOf(id).querySelector('[data-testid="AgentRow.status"]') as HTMLElement

    it('is steady green while a background shell it launched runs, then grey', async () => {
      nested({ [A_BG_BASH]: nestedActiveTasks()[A_BG_BASH] }, [A, B])
      await renderList()
      // The Running filter keeps A as context for the running shell below it.
      expect(rowOf(A).getAttribute('data-context')).toBe('true')
      expect(dotOf(A).getAttribute('data-state')).toBe('idle')
      expect(dotOf(A).getAttribute('data-status')).toBe('subagents')
      expect(dotOf(A).classList.contains('status-dot--ripple')).toBe(false)
      expect(dotOf(A_BG_BASH).getAttribute('data-state')).toBe('running')
      // Nothing is dimmed: not the finished context row, not the running shell.
      expect(rowOf(A).className).not.toMatch(/opacity/)
      expect(rowOf(A_BG_BASH).className).not.toMatch(/opacity/)

      // The shell ends: nothing runs below A any more, so it is grey (kept open here).
      cleanup()
      nested({}, [A, B, A_BG_BASH])
      await renderList([A])
      expect(dotOf(A).getAttribute('data-state')).toBe('inactive')
      expect(dotOf(A).getAttribute('data-status')).toBe('done')
    })

    it('is steady green while a nested agent runs, at any depth', async () => {
      nested({ [B]: nestedActiveTasks()[B] }, [A])
      await renderList()
      expect(dotOf(A).getAttribute('data-state')).toBe('idle')
      expect(dotOf(B).getAttribute('data-state')).toBe('running')
      expect(rowOf(A).className).not.toMatch(/opacity/)
    })
  })
})
