/**
 * The words behind the pill's and the tab's bare number (ADR-073 §7): both
 * show a dot and a number, and this is their tooltip and `aria-label`, so a
 * screen reader hears what the number counts.
 *
 *   1 agent, 1 shell running · 28 agents in this session
 *   1 shell running · 2 agents in this session
 *   28 agents in this session
 *
 * The roster list's header (§10) says the same thing in the same words, minus
 * "in this session" (the list is the session): `rosterSummaryParts` is the one
 * place the counts become words.
 */
import type { AgentRoster } from '../../hooks/useAgentRoster'

function count(n: number, noun: string): string {
  return `${n} ${noun}${n === 1 ? '' : 's'}`
}

type Counts = Pick<AgentRoster, 'runningAgentCount' | 'runningShellCount' | 'totalCount'>

/** `running`: "2 agents, 1 shell running"; `total`: "28 agents". Either is '' when it is zero. */
export function rosterSummaryParts(roster: Counts): { running: string; total: string } {
  const running = [
    roster.runningAgentCount > 0 ? count(roster.runningAgentCount, 'agent') : '',
    roster.runningShellCount > 0 ? count(roster.runningShellCount, 'shell') : ''
  ].filter(Boolean)
  return {
    running: running.length > 0 ? `${running.join(', ')} running` : '',
    total: roster.totalCount > 0 ? count(roster.totalCount, 'agent') : ''
  }
}

export function rosterSummary(roster: Counts): string {
  const { running, total } = rosterSummaryParts(roster)
  return [running, total ? `${total} in this session` : ''].filter(Boolean).join(' · ')
}
