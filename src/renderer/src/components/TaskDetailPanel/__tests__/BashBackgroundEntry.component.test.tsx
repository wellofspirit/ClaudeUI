/**
 * Layer 2: the background shell's panel entry (ADR-073 §10) — the whole command
 * (the header used to cut it at 60 characters and nothing else showed it), who
 * launched it, and Copy.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, screen, fireEvent, act } from '@testing-library/react'
import { useSessionStore } from '../../../stores/session-store'
import { bootTestApp, type TestApp } from '@test/helpers/boot-test-app'
import { mirrorStoreIntoReplica } from '@test/helpers/replica-seed'
import type { ChatMessage } from '../../../../../shared/types'
import { BashBackgroundEntry } from '../BashBackgroundEntry'

const ROUTE = 'route-bash-entry'
const AGENT = 'tu-agent'
const SHELL = 'tu-shell'
const COMMAND =
  'until grep -q "END compare" /d/repo/.cache/compare.log; do sleep 5; done && echo finished-waiting'

function bashCall(input: Record<string, unknown>): ChatMessage {
  return {
    id: 'm-sh',
    role: 'assistant',
    content: [{ type: 'tool_use', toolUseId: SHELL, toolName: 'Bash', toolInput: input }],
    timestamp: 0
  }
}

function seedSession(opts: { owner: boolean; input?: Record<string, unknown> }): void {
  const call = bashCall({ command: COMMAND, run_in_background: true, ...opts.input })
  const agentSpawn: ChatMessage = {
    id: 'm-agent',
    role: 'assistant',
    content: [
      {
        type: 'tool_use',
        toolUseId: AGENT,
        toolName: 'Agent',
        toolInput: { name: 'scroll-compare', subagent_type: 'Explore', description: 'compare' }
      }
    ],
    timestamp: 0
  }
  useSessionStore.setState((state) => ({
    activeSessionId: ROUTE,
    sessions: {
      ...state.sessions,
      [ROUTE]: {
        ...state.sessions[ROUTE],
        messages: opts.owner ? [agentSpawn] : [call],
        subagentMessages: opts.owner ? { [AGENT]: [call] } : ({} as Record<string, ChatMessage[]>),
        activeTasks: {
          [AGENT]: { taskId: 't-agent', taskType: 'local_agent', runIndex: 1 },
          [SHELL]: { taskId: 't-shell', taskType: 'local_bash', runIndex: 1, isBackgrounded: true }
        }
      }
    }
  }))
  mirrorStoreIntoReplica()
}

describe('BashBackgroundEntry', () => {
  let app: TestApp

  beforeEach(async () => {
    app = await bootTestApp()
    useSessionStore.getState().createNewSession(ROUTE, '/d/repo')
    // The entry watches its output file while it is open.
    for (const channel of ['session:watch-background', 'session:unwatch-background']) {
      app.bridge.ipcMain.handle(channel, async () => null)
    }
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
    app.teardown()
    useSessionStore.setState({ activeSessionId: null, sessions: {} })
    mirrorStoreIntoReplica()
  })

  it('shows the whole command, in the header and in the command block', () => {
    seedSession({ owner: false })
    render(<BashBackgroundEntry toolUseId={SHELL} />)
    // Longer than the 60 characters the header used to keep.
    expect(COMMAND.length).toBeGreaterThan(60)
    expect(screen.getByTestId('BashBackgroundEntry.toggle').textContent).toContain(COMMAND)
    const block = screen.getByTestId('BashBackgroundEntry.command')
    expect(block.querySelector('pre')?.textContent).toBe(`$ ${COMMAND}`)
  })

  it('shows the label the panel gives the launching agent, as a button that opens its entry', () => {
    seedSession({ owner: true, input: { description: 'Wait for the compare log' } })
    render(<BashBackgroundEntry toolUseId={SHELL} ownerLabel="scroll-compare" />)
    const meta = screen.getByTestId('BashBackgroundEntry.commandMeta')
    const owner = screen.getByTestId('BashBackgroundEntry.owner')
    expect(owner.textContent).toBe('scroll-compare')
    expect(meta.textContent).toContain('launched by')
    // The Bash call's own description rides along.
    expect(meta.textContent).toContain('Wait for the compare log')

    fireEvent.click(owner)
    const session = useSessionStore.getState().sessions[ROUTE]
    expect(session.openedTaskToolUseIds).toContain(AGENT)
    expect(session.rightPanel).toBe('task')
  })

  it('still links to the owner, as "an agent", when the panel gave no label', () => {
    seedSession({ owner: true })
    render(<BashBackgroundEntry toolUseId={SHELL} />)
    const owner = screen.getByTestId('BashBackgroundEntry.owner')
    expect(owner.textContent).toBe('an agent')
    fireEvent.click(owner)
    expect(useSessionStore.getState().sessions[ROUTE].openedTaskToolUseIds).toContain(AGENT)
  })

  it('has no launcher for a shell the main session ran', () => {
    seedSession({ owner: false })
    render(<BashBackgroundEntry toolUseId={SHELL} />)
    expect(screen.queryByTestId('BashBackgroundEntry.owner')).toBeNull()
    expect(screen.getByTestId('BashBackgroundEntry.commandMeta').textContent).not.toContain(
      'launched by'
    )
    expect(screen.getByTestId('BashBackgroundEntry.copy')).toBeTruthy()
  })

  it('copies the full command and says so for a moment', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const writeText = vi.fn().mockResolvedValue(undefined)
    vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText } })
    seedSession({ owner: false })
    render(<BashBackgroundEntry toolUseId={SHELL} />)

    await act(async () => {
      fireEvent.click(screen.getByTestId('BashBackgroundEntry.copy'))
    })
    expect(writeText).toHaveBeenCalledWith(COMMAND)
    expect(screen.getByTestId('BashBackgroundEntry.copy').textContent).toBe('Copied')

    await act(async () => {
      vi.advanceTimersByTime(1600)
    })
    expect(screen.getByTestId('BashBackgroundEntry.copy').textContent).toBe('Copy')
  })

  it('stays quiet when the clipboard refuses', async () => {
    const writeText = vi.fn().mockRejectedValue(new Error('denied'))
    vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText } })
    seedSession({ owner: false })
    render(<BashBackgroundEntry toolUseId={SHELL} />)
    await act(async () => {
      fireEvent.click(screen.getByTestId('BashBackgroundEntry.copy'))
    })
    expect(screen.getByTestId('BashBackgroundEntry.copy').textContent).toBe('Copy')
  })
})
