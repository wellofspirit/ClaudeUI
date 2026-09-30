/**
 * The words behind the pill's and the tab's bare number (ADR-073 §7): both
 * show a dot and a number, and this is their tooltip and `aria-label`, so a
 * screen reader hears what the number counts.
 *
 *   1 agent, 1 shell running · 28 agents in this session
 *   1 shell running · 2 agents in this session
 *   28 agents in this session
 */
import type { AgentRoster } from '../../hooks/useAgentRoster'

function count(n: number, noun: string): string {
  return `${n} ${noun}${n === 1 ? '' : 's'}`
}

export function rosterSummary(
  roster: Pick<AgentRoster, 'runningAgentCount' | 'runningShellCount' | 'totalCount'>
): string {
  const running = [
    roster.runningAgentCount > 0 ? count(roster.runningAgentCount, 'agent') : '',
    roster.runningShellCount > 0 ? count(roster.runningShellCount, 'shell') : ''
  ].filter(Boolean)
  const total = roster.totalCount > 0 ? `${count(roster.totalCount, 'agent')} in this session` : ''
  return [running.length > 0 ? `${running.join(', ')} running` : '', total]
    .filter(Boolean)
    .join(' · ')
}
