import { useState } from 'react'

export type SessionDotState =
  'attention' | 'running' | 'subagents' | 'idle' | 'watching' | 'inactive'

export interface SessionDotInput {
  active: boolean
  needsAttention: boolean
  isRunning: boolean
  isSdkActive: boolean
  isWatching: boolean
  /** Running auto-continuing tasks (see `countAutoContinuingTasks`). */
  runningSubagents: number
}

/**
 * First match wins. `subagents` exists because cli.js 2.1.219+ runs agents in
 * the background by default: the main turn ends at the launch ack while the
 * agents keep working, so `running` alone would show a busy session as idle.
 * It needs `isSdkActive` — `activeTasks` is only cleared on disconnect, and a
 * dead process has no agents running whatever its last records say.
 */
export function deriveSessionDotState(i: SessionDotInput): SessionDotState {
  if (i.needsAttention && !i.active) return 'attention'
  if (i.isRunning) return 'running'
  if (i.isSdkActive && i.runningSubagents > 0) return 'subagents'
  if (i.isSdkActive) return 'idle'
  if (i.isWatching) return 'watching'
  return 'inactive'
}

const LABELS: Record<SessionDotState, string> = {
  attention: 'Needs attention',
  running: 'Working',
  subagents: 'Subagents working',
  idle: 'Idle',
  watching: 'Watching',
  inactive: 'Not running'
}

const RIPPLE: ReadonlySet<SessionDotState> = new Set(['attention', 'running', 'subagents'])

/** Ripple cycle length in seconds — keep in step with the `status-dot-*` keyframes in main.css. */
const CYCLE_S = 3.2

export function statusDotLabel(state: SessionDotState, runningSubagents: number): string {
  if (runningSubagents <= 0) return LABELS[state]
  const count = `${runningSubagents} subagent${runningSubagents === 1 ? '' : 's'} running`
  return state === 'subagents' ? count : `${LABELS[state]} · ${count}`
}

export function StatusDot({
  state,
  runningSubagents,
  testid = 'StatusDot',
  className = ''
}: {
  state: SessionDotState
  runningSubagents: number
  testid?: string
  className?: string
}): React.JSX.Element {
  // A random phase per mount, so a list of busy sessions doesn't ripple in unison.
  const [phase] = useState(() => `-${(Math.random() * CYCLE_S).toFixed(2)}s`)
  const label = statusDotLabel(state, runningSubagents)
  return (
    <span
      data-testid={testid}
      data-state={state}
      data-subagents={runningSubagents}
      role="img"
      title={label}
      aria-label={label}
      style={{ '--dot-phase': phase } as React.CSSProperties}
      className={`status-dot relative inline-block w-[6px] h-[6px] rounded-full ${
        RIPPLE.has(state) ? 'status-dot--ripple' : ''
      } ${className}`}
    />
  )
}
