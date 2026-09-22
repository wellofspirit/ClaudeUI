/**
 * `MachinesPanel` — the machine list (ADR-072 §7, slice S5c).
 *
 * The card's job is not the dollars, which every other widget on the tab shows:
 * it is which machines they came from and, above all, WHICH ARE MISSING. So the
 * cases here are the order, the 24-hour boundary, the footnote that names what
 * a behind machine costs the combined figures, and the two footer actions.
 *
 * The 24-hour threshold is asserted from both sides at one minute, because it is
 * measured against the reader's own clock rather than the query's `now` — see
 * the component's header for why.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { MachinesPanel, machineBehindMs } from '../MachinesPanel'
import type { UsageHubStatus } from '../../../../../shared/types'
import { makeDashboard, makeMachine, makeTotals } from './dashboard-fixtures'

const HOUR = 60 * 60 * 1000
const DAY = 24 * HOUR

function makeStatus(overrides: Partial<UsageHubStatus> = {}): UsageHubStatus {
  return {
    enabled: true,
    url: 'https://hub.example.test',
    deviceId: 'dev-self',
    deviceName: 'desk',
    clientId: 'abc.access',
    hasSecret: true,
    state: 'idle',
    lastPushAt: Date.now(),
    lastPullAt: Date.now(),
    lastError: null,
    pendingEvents: 0,
    ...overrides,
    remote: overrides.remote ?? { devices: [], epoch: 4 }
  }
}

let mockSync: ReturnType<typeof vi.fn>

beforeEach(() => {
  mockSync = vi.fn().mockResolvedValue(makeStatus())
  ;(window as any).api = { syncUsageHubNow: mockSync }
})

/** Three machines, as the query orders them: this one, a peer, a retired one. */
function threeMachines(): ReturnType<typeof makeDashboard> {
  const now = Date.now()
  return makeDashboard({
    scope: 'all',
    totals: makeTotals({ displayCostUsd: 100 }),
    localUsd: 60,
    remoteUsd: 40,
    machines: [
      makeMachine({
        deviceId: 'dev-self',
        deviceName: 'desk',
        os: 'win32',
        appVersion: '3.3.0',
        self: true,
        lastPushAt: now - 60_000,
        totals: makeTotals({ displayCostUsd: 60 }),
        share: 0.6
      }),
      makeMachine({
        deviceId: 'dev-peer',
        deviceName: 'studio',
        os: 'darwin',
        appVersion: '3.3.0',
        self: false,
        lastPushAt: now - 2 * HOUR,
        totals: makeTotals({ displayCostUsd: 40 }),
        share: 0.4
      }),
      makeMachine({
        deviceId: 'dev-old',
        deviceName: 'old-server',
        os: 'linux',
        appVersion: '3.1.0',
        self: false,
        retired: true,
        lastPushAt: now - 40 * DAY,
        totals: makeTotals({ displayCostUsd: 0 }),
        share: 0
      })
    ]
  })
}

describe('MachinesPanel — the rows', () => {
  it('draws one row per machine in the query order, with its facts', () => {
    render(<MachinesPanel data={threeMachines()} status={makeStatus()} onSynced={vi.fn()} />)

    const rows = screen.getAllByTestId('MachinesPanel.row')
    expect(rows.map((r) => r.getAttribute('data-device-id'))).toEqual([
      'dev-self',
      'dev-peer',
      'dev-old'
    ])
    expect(rows[0]).toHaveAttribute('data-self', 'true')
    expect(rows[0]).toHaveTextContent('this machine')
    expect(rows[0]).toHaveTextContent('desk')
    expect(rows[0]).toHaveTextContent('win32 · 3.3.0')
    expect(rows[0]).toHaveTextContent('$60.00')
    expect(rows[1]).not.toHaveAttribute('data-self')
    expect(rows[1]).toHaveTextContent('40%')
  })

  it('shows a retired machine last, dimmed, with a dash for its share', () => {
    render(<MachinesPanel data={threeMachines()} status={makeStatus()} onSynced={vi.fn()} />)

    const rows = screen.getAllByTestId('MachinesPanel.row')
    const retired = rows[rows.length - 1]
    expect(retired).toHaveAttribute('data-retired', 'true')
    expect(retired).toHaveTextContent('retired')
    expect(retired.className).toContain('text-text-muted')
    // A dash, not `0%`: the figure is no longer maintained, which is different
    // from being zero.
    const share = retired.querySelector('[data-testid="MachinesPanel.row.share"]')
    expect(share?.textContent).toBe('—')
    // And never flagged behind, however old its last push is.
    expect(retired).not.toHaveAttribute('data-behind')
  })

  it('names the machine by a short id when it has no name', () => {
    const data = makeDashboard({
      scope: 'all',
      machines: [makeMachine({ deviceId: 'abcdef0123456789', deviceName: '' })]
    })
    render(<MachinesPanel data={data} status={makeStatus()} onSynced={vi.fn()} />)
    expect(screen.getByTestId('MachinesPanel.row')).toHaveTextContent('abcdef01')
  })

  it('writes a dash for a machine that has never pushed', () => {
    const data = makeDashboard({
      scope: 'all',
      machines: [makeMachine({ lastPushAt: null })]
    })
    render(<MachinesPanel data={data} status={makeStatus()} onSynced={vi.fn()} />)
    expect(screen.getByTestId('MachinesPanel.row')).toHaveTextContent('—')
    expect(screen.getByTestId('MachinesPanel.row')).not.toHaveAttribute('data-behind')
  })
})

describe('MachinesPanel — behind', () => {
  it('is behind one minute past a day, and not one minute short of it', () => {
    const now = Date.now()
    const justUnder = makeMachine({ lastPushAt: now - (DAY - 60_000) })
    const justOver = makeMachine({ lastPushAt: now - (DAY + 60_000) })

    expect(machineBehindMs(justUnder, now)).toBeNull()
    expect(machineBehindMs(justOver, now)).toBeGreaterThan(DAY)

    // And the same boundary through the render, which is what a reader sees.
    const { unmount } = render(
      <MachinesPanel
        data={makeDashboard({ scope: 'all', machines: [justUnder] })}
        status={makeStatus()}
        onSynced={vi.fn()}
      />
    )
    expect(screen.getByTestId('MachinesPanel.row')).not.toHaveAttribute('data-behind')
    expect(screen.queryByTestId('MachinesPanel.behindNote')).not.toBeInTheDocument()
    unmount()

    render(
      <MachinesPanel
        data={makeDashboard({ scope: 'all', machines: [justOver] })}
        status={makeStatus()}
        onSynced={vi.fn()}
      />
    )
    expect(screen.getByTestId('MachinesPanel.row')).toHaveAttribute('data-behind', 'true')
    expect(screen.getByTestId('MachinesPanel.row.behind')).toHaveTextContent('behind 24h')
  })

  it('says what a behind machine costs the combined figures, once per machine', () => {
    const now = Date.now()
    const data = makeDashboard({
      scope: 'all',
      machines: [
        makeMachine({ deviceId: 'dev-self', deviceName: 'desk', self: true, lastPushAt: now }),
        makeMachine({
          deviceId: 'dev-late',
          deviceName: 'laptop',
          self: false,
          lastPushAt: now - 31 * HOUR
        })
      ]
    })
    render(<MachinesPanel data={data} status={makeStatus()} onSynced={vi.fn()} />)

    const note = screen.getByTestId('MachinesPanel.behindNote')
    expect(note).toHaveTextContent('laptop is 31h behind')
    // The two things it is missing from — the point of the note (ADR-030).
    expect(note).toHaveTextContent('missing from the combined figures and the plan-value numerator')
    expect(note).not.toHaveTextContent('desk is')
  })

  it('has no footnote when every machine is current', () => {
    render(<MachinesPanel data={threeMachines()} status={makeStatus()} onSynced={vi.fn()} />)
    expect(screen.queryByTestId('MachinesPanel.behindNote')).not.toBeInTheDocument()
  })
})

describe('MachinesPanel — the footer', () => {
  it('syncs once and hands the answer back to the shell', async () => {
    const onSynced = vi.fn()
    const answer = makeStatus({ state: 'idle', lastPullAt: Date.now() })
    mockSync.mockResolvedValue(answer)
    render(<MachinesPanel data={threeMachines()} status={makeStatus()} onSynced={onSynced} />)

    fireEvent.click(screen.getByTestId('MachinesPanel.syncNow'))

    await waitFor(() => expect(onSynced).toHaveBeenCalledWith(answer))
    expect(mockSync).toHaveBeenCalledTimes(1)
  })

  it('is disabled while a pass is in flight, from either side', async () => {
    // The client's own state, reported by the shell.
    const { unmount } = render(
      <MachinesPanel
        data={threeMachines()}
        status={makeStatus({ state: 'syncing' })}
        onSynced={vi.fn()}
      />
    )
    expect(screen.getByTestId('MachinesPanel.syncNow')).toBeDisabled()
    expect(screen.getByTestId('MachinesPanel.syncNow')).toHaveTextContent('Syncing…')
    unmount()

    // And this card's own press, before any status has come back.
    let resolve!: (s: UsageHubStatus) => void
    mockSync.mockReturnValue(new Promise((r) => (resolve = r)))
    render(<MachinesPanel data={threeMachines()} status={makeStatus()} onSynced={vi.fn()} />)
    fireEvent.click(screen.getByTestId('MachinesPanel.syncNow'))
    await waitFor(() => expect(screen.getByTestId('MachinesPanel.syncNow')).toBeDisabled())

    resolve(makeStatus())
    await waitFor(() => expect(screen.getByTestId('MachinesPanel.syncNow')).not.toBeDisabled())
  })

  it('keeps the card standing when a sync fails', async () => {
    mockSync.mockRejectedValue(new Error('the hub refused the service token'))
    render(<MachinesPanel data={threeMachines()} status={makeStatus()} onSynced={vi.fn()} />)

    fireEvent.click(screen.getByTestId('MachinesPanel.syncNow'))

    await waitFor(() => expect(screen.getByTestId('MachinesPanel.syncNow')).not.toBeDisabled())
    expect(screen.getAllByTestId('MachinesPanel.row')).toHaveLength(3)
  })

  it('opens the hub settings group through the deep link', () => {
    const detail: unknown[] = []
    const listener = (e: Event): void => {
      detail.push((e as CustomEvent).detail)
    }
    window.addEventListener('open-settings', listener)
    try {
      render(<MachinesPanel data={threeMachines()} status={makeStatus()} onSynced={vi.fn()} />)
      fireEvent.click(screen.getByTestId('MachinesPanel.settings'))
      expect(detail).toEqual([{ page: 'remote', group: 'usage-hub' }])
    } finally {
      window.removeEventListener('open-settings', listener)
    }
  })

  it('names the hub generation it is showing', () => {
    render(
      <MachinesPanel
        data={threeMachines()}
        status={makeStatus({ remote: { devices: [], epoch: 7 } })}
        onSynced={vi.fn()}
      />
    )
    expect(screen.getByTestId('MachinesPanel')).toHaveTextContent('epoch 7')
  })
})
