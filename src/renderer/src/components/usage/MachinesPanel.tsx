/**
 * The machine list (ADR-072 §7, slice S5c, mockup `47cfbd90`'s Machines A).
 *
 * The owner ruled this a CARD at the bottom of the Spend tab rather than the
 * popover the mockup drew behind the sync chip: four machines in a popover cover
 * the summary they are meant to qualify, and the one question a reader brings to
 * it — "is everything in the figures above" — is better answered underneath
 * them. The chip is a link here.
 *
 * WHAT THIS CARD IS FOR. Every other widget on the tab shows combined dollars.
 * This is the only one that says which machines those dollars came from and,
 * more importantly, WHICH ARE MISSING: a machine that stopped pushing is spend
 * the combined hero does not have and the plan-value numerator is short by
 * (ADR-030 — the absence is shown, never quietly absorbed). That is what the
 * `behind` tag and the footnote are.
 *
 * BEHIND IS COMPUTED HERE, not in the query. The threshold is against the
 * reader's own clock — a dashboard left open overnight should start flagging the
 * machine that went quiet — and the query's `now` is fixed at the instant the
 * range was taken.
 */

import { useCallback, useState } from 'react'
import type { DashboardMachine, UsageDashboardData, UsageHubStatus } from '../../../../shared/types'
import type { SettingsTarget } from '../SettingsDialog/settings-target'
import {
  formatBehind,
  formatCost,
  formatDuration,
  SEVERITY_ICON,
  SEVERITY_TEXT_CLASS
} from './usage-utils'

/**
 * The scroll target the header chip aims at. An id rather than a ref, because
 * the chip lives in the header and this card is mounted by the panel below it —
 * threading a ref through the shell for one scroll would be more plumbing than
 * the behaviour is worth.
 */
export const MACHINES_PANEL_ANCHOR = 'usage-machines-panel'

/** How long a machine may go without pushing before it is called behind. */
const BEHIND_MS = 24 * 60 * 60 * 1000

/** Where `Hub settings →` goes — the group S5b added (ADR-065's page model). */
const HUB_SETTINGS_TARGET: SettingsTarget = { page: 'remote', group: 'usage-hub' }

interface MachinesPanelProps {
  data: UsageDashboardData
  /** The hub's client state, or null when the channel could not be read. */
  status: UsageHubStatus | null
  /** Hands the shell the status a pressed Sync answered with, so the chip moves too. */
  onSynced: (status: UsageHubStatus) => void
}

/**
 * How far behind a machine is, or null when it is not.
 *
 * A RETIRED machine is never behind: the owner has said it is history, which is
 * the whole point of the flag on the hub. Nor is one that has never pushed —
 * there is no instant to measure from, and `—` says that better than a duration
 * counted from the epoch.
 */
export function machineBehindMs(machine: DashboardMachine, now: number): number | null {
  if (machine.retired || machine.lastPushAt === null) return null
  const age = now - machine.lastPushAt
  return age > BEHIND_MS ? age : null
}

/** A machine's display name: the one its owner set, else a short form of its id. */
function machineLabel(machine: DashboardMachine): string {
  return machine.deviceName.trim() === '' ? machine.deviceId.slice(0, 8) : machine.deviceName
}

export function MachinesPanel({ data, status, onSynced }: MachinesPanelProps): React.JSX.Element {
  const [syncing, setSyncing] = useState(false)
  const now = Date.now()
  const behind = data.machines.filter((m) => machineBehindMs(m, now) !== null)

  const handleSync = useCallback(async () => {
    // One press, one pass. The core single-flights a sync of its own, but a
    // disabled button is what tells the reader the press was taken.
    setSyncing(true)
    try {
      onSynced(await window.api.syncUsageHubNow())
    } catch {
      // The failure is already on the chip and in the settings group, which is
      // where the error text belongs; this card must not grow a third sink.
    } finally {
      setSyncing(false)
    }
  }, [onSynced])

  const busy = syncing || status?.state === 'syncing'

  return (
    <div
      id={MACHINES_PANEL_ANCHOR}
      data-testid="MachinesPanel"
      className="bg-bg-secondary rounded-xl border border-border/50 p-3"
    >
      <div className="flex flex-wrap items-baseline justify-between gap-2 mb-2">
        <div className="flex items-baseline gap-2">
          <h3 className="text-[11px] font-semibold text-text-secondary uppercase tracking-wider">
            Machines
          </h3>
          <span className="text-[9px] text-text-muted">
            as the hub reports them
            {status !== null && status.remote.epoch !== null && ` · epoch ${status.remote.epoch}`}
          </span>
        </div>
      </div>

      <div className="overflow-x-auto">
        <table className="w-full text-[10px] border-collapse">
          <thead>
            <tr className="text-text-muted">
              <th className="text-left font-medium pb-1">Machine</th>
              <th className="text-left font-medium pb-1 pl-3 whitespace-nowrap">Last push</th>
              <th className="text-right font-medium pb-1 pl-3 whitespace-nowrap min-w-[64px]">
                Spend
              </th>
              <th className="text-right font-medium pb-1 pl-3 w-[110px]">Share</th>
            </tr>
          </thead>
          <tbody>
            {data.machines.map((machine) => (
              <MachineRow key={machine.deviceId} machine={machine} now={now} />
            ))}
          </tbody>
        </table>
      </div>

      {behind.length > 0 && (
        <p data-testid="MachinesPanel.behindNote" className="text-[9px] text-warning mt-2">
          {behind.map((machine) => (
            <span key={machine.deviceId} className="block">
              {SEVERITY_ICON.warn} {machineLabel(machine)} is{' '}
              {formatBehind(machineBehindMs(machine, now) ?? 0)} behind: its spend since then is
              missing from the combined figures and the plan-value numerator.
            </span>
          ))}
        </p>
      )}

      <div className="flex flex-wrap items-center gap-2 mt-3">
        <button
          data-testid="MachinesPanel.syncNow"
          onClick={() => void handleSync()}
          disabled={busy}
          title="Push this machine's new rows and pull everyone else's, now."
          className="[-webkit-app-region:no-drag] text-[10px] text-text-secondary hover:text-text-primary border border-border/50 rounded px-2 py-0.5 disabled:opacity-50 transition-colors cursor-default"
        >
          {busy ? 'Syncing…' : 'Sync now'}
        </button>
        <button
          data-testid="MachinesPanel.settings"
          onClick={() => {
            window.dispatchEvent(new CustomEvent('open-settings', { detail: HUB_SETTINGS_TARGET }))
          }}
          title="Open Settings › Remote access › Usage hub."
          className="[-webkit-app-region:no-drag] text-[10px] text-text-muted hover:text-text-primary transition-colors cursor-default"
        >
          Hub settings →
        </button>
      </div>
    </div>
  )
}

function MachineRow({
  machine,
  now
}: {
  machine: DashboardMachine
  now: number
}): React.JSX.Element {
  const behindMs = machineBehindMs(machine, now)
  const severity = behindMs === null ? 'ok' : 'warn'
  const share = Math.round(machine.share * 100)

  return (
    <tr
      data-testid="MachinesPanel.row"
      data-device-id={machine.deviceId}
      data-self={machine.self ? 'true' : undefined}
      data-behind={behindMs === null ? undefined : 'true'}
      data-retired={machine.retired ? 'true' : undefined}
      className={machine.retired ? 'text-text-muted' : 'text-text-secondary'}
    >
      <td className="py-0.5">
        <span className="flex flex-wrap items-center gap-1.5">
          <span
            aria-hidden="true"
            className={machine.retired ? 'text-text-muted' : SEVERITY_TEXT_CLASS[severity]}
          >
            {SEVERITY_ICON[severity]}
          </span>
          <span className="text-text-primary">{machineLabel(machine)}</span>
          {machine.self && <Tag>this machine</Tag>}
          {machine.retired && <Tag>retired</Tag>}
          <span className="text-text-muted whitespace-nowrap">
            {machine.os} · {machine.appVersion}
          </span>
          {behindMs !== null && (
            <span
              data-testid="MachinesPanel.row.behind"
              className="text-[9px] px-1 py-px rounded border border-warning/50 text-warning whitespace-nowrap"
              title="Its spend since then is missing from every combined figure on this screen."
            >
              behind {formatBehind(behindMs)}
            </span>
          )}
        </span>
      </td>
      <td className="pl-3 text-text-muted whitespace-nowrap">
        {machine.lastPushAt === null
          ? '—'
          : `${formatDuration(Math.max(0, now - machine.lastPushAt))} ago`}
      </td>
      <td className="pl-3 text-right font-mono whitespace-nowrap text-text-primary">
        {formatCost(machine.totals.displayCostUsd)}
      </td>
      <td className="pl-3">
        {/* A retired machine's share is a DASH, not 0%: it spent what it spent
            before it was retired, and the range may well contain some of it —
            what the row is saying is that the figure is no longer maintained. */}
        {machine.retired ? (
          <span
            data-testid="MachinesPanel.row.share"
            className="block text-right font-mono text-text-muted pr-[34px]"
            title="Retired on the hub — its share is no longer tracked."
          >
            —
          </span>
        ) : (
          <span
            data-testid="MachinesPanel.row.share"
            className="flex items-center gap-1.5 justify-end"
          >
            <span className="w-[56px] h-[4px] rounded-sm bg-bg-tertiary overflow-hidden">
              <span
                className="block h-full rounded-sm bg-text-secondary"
                style={{
                  width: `${Math.min(100, machine.share * 100)}%`,
                  minWidth: machine.share > 0 ? 2 : 0
                }}
              />
            </span>
            <span className="font-mono w-[30px] text-right text-text-muted">{share}%</span>
          </span>
        )}
      </td>
    </tr>
  )
}

function Tag({ children }: { children: React.ReactNode }): React.JSX.Element {
  return (
    <span className="text-[9px] px-1 py-px rounded bg-bg-tertiary text-text-secondary whitespace-nowrap">
      {children}
    </span>
  )
}
