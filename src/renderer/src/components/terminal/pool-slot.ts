import type { TerminalTab } from '../../../../shared/types'

/**
 * Which slot of the cwd's terminal POOL should the next tab ask for?
 *
 * Terminals are an ordered pool per cwd (`cwd#0`, `cwd#1`, …) resolved in the
 * main process: asking for slot N attaches to the live pty there, or spawns one
 * if the slot is free. So the client's only job is to name a slot — the lowest
 * one THIS surface is not already showing, which makes closing a middle tab and
 * pressing `+` reuse that slot (and, if a phone still has it open, re-attach to
 * the very same shell) rather than pile up a new one at the end.
 *
 * Tabs created before the pool existed carry no `poolIndex`; their position
 * stands in for it, which is what it effectively was.
 */
export function nextFreeSlot(tabs: readonly TerminalTab[]): number {
  const used = new Set(tabs.map((tab, position) => tab.poolIndex ?? position))
  let slot = 0
  while (used.has(slot)) slot++
  return slot
}
