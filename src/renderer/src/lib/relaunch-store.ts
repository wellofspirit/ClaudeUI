/**
 * "Relaunch ClaudeUI": the one flow behind the sidebar's settings menu and the
 * macOS app menu (relaunch arc, S1's minimal entry point; S6 replaces the UI).
 *
 * Before relaunching it reads what a restart would interrupt
 * (`app:restart-impact`); when anything would be, the user confirms first
 * (`RelaunchConfirm`, the shared ConfirmModal). Nothing to interrupt: it
 * relaunches straight away, and only a refusal is shown.
 */

import { create } from 'zustand'
import type { RestartImpact } from '../../../shared/relaunch'
import { ipcErrorMessage } from '../utils/ipc-error'

interface RelaunchState {
  /** The confirm is up for this impact. */
  pending: RestartImpact | null
  /** A relaunch that went ahead without a confirm was refused: shown in the same dialog. */
  failure: string | null
}

export const useRelaunchStore = create<RelaunchState>(() => ({ pending: null, failure: null }))

const NONE: RestartImpact = { workingSessions: 0, terminals: 0, remoteClients: 0 }

export const impactIsEmpty = (impact: RestartImpact): boolean =>
  impact.workingSessions === 0 && impact.terminals === 0 && impact.remoteClients === 0

const plural = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`

/** The confirm's lines, one per thing a restart interrupts. */
export function impactLines(impact: RestartImpact): string[] {
  const lines: string[] = []
  if (impact.workingSessions > 0)
    lines.push(
      `${plural(impact.workingSessions, 'working session', 'working sessions')} will be interrupted`
    )
  if (impact.terminals > 0)
    lines.push(`${plural(impact.terminals, 'terminal', 'terminals')} will close`)
  if (impact.remoteClients > 0)
    lines.push(
      `${plural(impact.remoteClients, 'remote client', 'remote clients')} will disconnect and reconnect`
    )
  return lines
}

/** Start the flow: read the impact, confirm when anything would be interrupted. */
export async function requestRelaunch(): Promise<void> {
  let impact: RestartImpact
  try {
    impact = await window.api.restartImpact()
  } catch {
    // Unknown impact: ask, rather than restart blind.
    useRelaunchStore.setState({ pending: NONE, failure: null })
    return
  }
  if (!impactIsEmpty(impact)) {
    useRelaunchStore.setState({ pending: impact, failure: null })
    return
  }
  try {
    await window.api.relaunchApp()
  } catch (err) {
    useRelaunchStore.setState({ pending: NONE, failure: ipcErrorMessage(err) })
  }
}

/** The confirm's action: rejects with the refusal, which the dialog shows inline. */
export async function confirmRelaunch(): Promise<void> {
  await window.api.relaunchApp()
}

export function dismissRelaunch(): void {
  useRelaunchStore.setState({ pending: null, failure: null })
}
