/**
 * The sidebar dot must keep showing work after the main turn ends: cli.js
 * 2.1.219+ runs agents in the background, so `status.state` goes idle at the
 * launch ack while `activeTasks` still holds the running agent.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { EMPTY_SESSION_STATE, useSessionStore } from '../../../stores/session-store'
import type { ActiveTask, SessionInfo } from '../../../../../shared/types'
import { SessionItem } from '../SessionItem'

const info: SessionInfo = {
  sessionId: 's-1',
  cwd: '/d/WorkPlace/demo',
  projectKey: '-d-workplace-demo',
  title: 'Session',
  timestamp: 0,
  lastActivityAt: 0
}

function seedIdleLive(activeTasks: Record<string, ActiveTask>): void {
  useSessionStore.setState({
    sessions: { 's-1': { ...EMPTY_SESSION_STATE, sdkActive: true, activeTasks } }
  })
}

const task = (taskType: string): ActiveTask => ({ taskId: `t-${taskType}`, taskType })

let initial: ReturnType<typeof useSessionStore.getState>
beforeEach(() => {
  initial = useSessionStore.getState()
})
afterEach(() => {
  cleanup()
  useSessionStore.setState(initial, true)
})

describe('SessionItem status dot', () => {
  it('ripples violet while a background subagent runs after the turn ended', () => {
    seedIdleLive({ 'tu-1': task('local_agent') })
    render(<SessionItem info={info} active={false} onClick={() => {}} />)

    const dot = screen.getByTestId('SessionItem.statusDot')
    expect(dot.getAttribute('data-state')).toBe('subagents')
    expect(dot.getAttribute('data-subagents')).toBe('1')
    expect(dot.getAttribute('title')).toBe('1 subagent running')
    expect(dot.classList.contains('status-dot--ripple')).toBe(true)
  })

  it('a background shell alone leaves the session idle', () => {
    seedIdleLive({ 'tu-1': task('local_bash') })
    render(<SessionItem info={info} active={false} onClick={() => {}} />)

    const dot = screen.getByTestId('SessionItem.statusDot')
    expect(dot.getAttribute('data-state')).toBe('idle')
    expect(dot.getAttribute('title')).toBe('Idle')
    expect(dot.classList.contains('status-dot--ripple')).toBe(false)
  })
})
