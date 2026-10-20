import { useState } from 'react'

export const SESSION_DOT_STATES = [
  'attention',
  'running',
  'subagents',
  'idle',
  'watching',
  'inactive',
  'failed'
] as const
/**
 * `failed` is not a session state (no session derives it): it is the agent
 * roster's, which draws its rows' dots with this same element (see AgentRow).
 */
export type SessionDotState = (typeof SESSION_DOT_STATES)[number]

export interface SessionDotInput {
  active: boolean
  needsAttention: boolean
  isRunning: boolean
  isSdkActive: boolean
  isWatching: boolean
  /**
   * Running background tasks that will wake the agent: subagents, shells, monitors and
   * dispatched X-Agents (see `countDotTasks`, which also decides what a session whose engine
   * is not live counts).
   */
  runningSubagents: number
}

/**
 * First match wins. `subagents` exists because cli.js 2.1.219+ runs agents in
 * the background by default: the main turn ends at the launch ack while the
 * agents keep working, so `running` alone would show a busy session as idle.
 * The count is already judged by liveness (`countDotTasks`): a dead process has no
 * native agents running whatever its last records say, but a dispatched X-Agent outlives
 * its parent's process (ADR-105 §5), so a disconnected or reopened parent still shows it.
 */
export function deriveSessionDotState(i: SessionDotInput): SessionDotState {
  if (i.needsAttention && !i.active) return 'attention'
  if (i.isRunning) return 'running'
  if (i.runningSubagents > 0) return 'subagents'
  if (i.isSdkActive) return 'idle'
  if (i.isWatching) return 'watching'
  return 'inactive'
}

const LABELS: Record<SessionDotState, string> = {
  attention: 'Needs attention',
  running: 'Working',
  subagents: 'Background tasks working',
  idle: 'Idle',
  watching: 'Watching',
  inactive: 'Not running',
  failed: 'Failed'
}

const RIPPLE: ReadonlySet<SessionDotState> = new Set(['attention', 'running', 'subagents'])

/**
 * Ripple cycle length in seconds — keep in step with the `status-dot-*` animations in app.css
 * (StatusDot.unit.test.ts checks it).
 */
export const CYCLE_S = 2

export function statusDotLabel(state: SessionDotState, runningSubagents: number): string {
  if (runningSubagents <= 0) return LABELS[state]
  const count = `${runningSubagents} background task${runningSubagents === 1 ? '' : 's'} running`
  return state === 'subagents' ? count : `${LABELS[state]} · ${count}`
}

export function StatusDot({
  state,
  runningSubagents,
  testid = 'StatusDot',
  className = '',
  label: labelOverride,
  status
}: {
  state: SessionDotState
  runningSubagents: number
  testid?: string
  className?: string
  /** Replaces the state's own words, for a surface whose states mean something else (a roster row's "Done"). */
  label?: string
  /** The surface's own name for the state, as `data-status` (the roster's `done`, `stopped`, ...). */
  status?: string
}): React.JSX.Element {
  // A random phase per mount, so a list of busy sessions doesn't ripple in unison.
  const [phase] = useState(() => `-${(Math.random() * CYCLE_S).toFixed(2)}s`)
  const label = labelOverride ?? statusDotLabel(state, runningSubagents)
  return (
    <span
      data-testid={testid}
      data-state={state}
      {...(status ? { 'data-status': status } : {})}
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
