/**
 * How a host-run or engine-native subagent is named on a card or in a message
 * (ADR-089 review F5): a model-authored description can carry quotes, markup or
 * line breaks, so the label has no `"`, `<`, `>` or line break, is trimmed, and
 * is at most 64 characters (`agent` when nothing is left).
 *
 * Shared by pi's delivered titles and summaries (`pi/pi-subagents.ts`) and
 * opencode's child approval cards, blocked-call labels and stop note, so the
 * two engines cannot drift.
 */
const attr = (v: string): string => v.replace(/["<>\r\n]/g, ' ')

export const cleanAgentLabel = (v: string): string => attr(v).trim().slice(0, 64) || 'agent'
