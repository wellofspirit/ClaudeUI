/**
 * @vitest-environment jsdom
 *
 * The web client's "Syncing state..." overlay grows a real progress bar
 * (ADR-102 amendment: the host answers an opted-in `sync` as `sync-full-chunk`
 * frames). The overlay OWNS the subscription — root state would re-render the
 * whole app tree on every chunk (R1) — so these tests drive a stub connection
 * through the one method the overlay's contract names and read the shared
 * ProgressBar's own attributes.
 */

import { describe, it, expect, afterEach, vi, type Mock } from 'vitest'
import { act, cleanup, render, screen } from '@testing-library/react'
import { ConnectionOverlay } from '../components/ConnectionOverlay'
import type { SyncProgress } from '../connection'

afterEach(cleanup)

/**
 * Stand-in for `RemoteConnection`: the overlay only ever calls
 * `setSyncProgressHandler`, and `emit` pushes an update the way a chunk does.
 */
type ProgressCallback = (progress: SyncProgress | null) => void

function stubConnection(): {
  setSyncProgressHandler: Mock<(cb: ProgressCallback | null) => void>
  emit: (progress: SyncProgress | null) => void
} {
  let handler: ProgressCallback | null = null
  const setSyncProgressHandler = vi.fn((cb: ProgressCallback | null) => {
    handler = cb
  })
  return {
    setSyncProgressHandler,
    emit: (progress) => handler?.(progress)
  }
}

const BAR = 'ConnectionOverlay.syncProgress'
const DETAIL = 'ConnectionOverlay.syncDetail'

describe('ConnectionOverlay — full-sync progress', () => {
  it('is indeterminate before the first chunk and shows no detail yet', () => {
    render(<ConnectionOverlay state="syncing" connection={stubConnection()} />)

    expect(screen.getByTestId('ConnectionOverlay')).toHaveTextContent('Syncing state...')
    const bar = screen.getByTestId(BAR)
    expect(bar).toHaveAttribute('role', 'progressbar')
    expect(bar).not.toHaveAttribute('aria-valuenow') // null percent = pulsing
    // Phone width at uiFontScale 1.5: a fixed width that can never exceed its column.
    expect(bar).toHaveClass('w-56', 'max-w-full')
    expect(screen.queryByTestId(DETAIL)).toBeNull()
  })

  it('is determinate from the announced totals, in JSON characters as MB', () => {
    const connection = stubConnection()
    render(<ConnectionOverlay state="syncing" connection={connection} />)

    act(() => connection.emit({ receivedChars: 12_300_000, totalChars: 40_700_000 }))

    const bar = screen.getByTestId(BAR)
    expect(Number(bar.getAttribute('aria-valuenow'))).toBeCloseTo(30.2, 1)
    expect(screen.getByTestId(DETAIL)).toHaveTextContent('12.3 of 40.7 MB')
  })

  it('follows the chunks to 100 %, and a dropped transfer goes back to indeterminate', () => {
    const connection = stubConnection()
    render(<ConnectionOverlay state="syncing" connection={connection} />)

    act(() => connection.emit({ receivedChars: 10_000_000, totalChars: 40_700_000 }))
    expect(Number(screen.getByTestId(BAR).getAttribute('aria-valuenow'))).toBeCloseTo(24.6, 1)

    act(() => connection.emit({ receivedChars: 40_700_000, totalChars: 40_700_000 }))
    expect(screen.getByTestId(BAR)).toHaveAttribute('aria-valuenow', '100')
    expect(screen.getByTestId(DETAIL)).toHaveTextContent('40.7 of 40.7 MB')

    act(() => connection.emit(null))
    expect(screen.getByTestId(BAR)).not.toHaveAttribute('aria-valuenow')
    expect(screen.queryByTestId(DETAIL)).toBeNull()
  })

  it('stays indeterminate rather than dividing by a zero total (no NaN width)', () => {
    const connection = stubConnection()
    render(<ConnectionOverlay state="syncing" connection={connection} />)

    act(() => connection.emit({ receivedChars: 0, totalChars: 0 }))
    expect(screen.getByTestId(BAR)).not.toHaveAttribute('aria-valuenow')
  })

  it('renders no bar outside the syncing state', () => {
    const connection = stubConnection()
    const { rerender } = render(<ConnectionOverlay state="connecting" connection={connection} />)
    for (const state of ['reconnecting', 'failed', 'auth-rejected'] as const) {
      rerender(<ConnectionOverlay state={state} connection={connection} />)
      expect(screen.queryByTestId(BAR)).toBeNull()
      expect(screen.queryByTestId(DETAIL)).toBeNull()
    }
  })

  it('subscribes while syncing and drops the subscription on the way out', () => {
    const connection = stubConnection()
    const { rerender } = render(<ConnectionOverlay state="connecting" connection={connection} />)
    // Nothing is in flight before the connection reaches `syncing`.
    expect(connection.setSyncProgressHandler).not.toHaveBeenCalled()

    rerender(<ConnectionOverlay state="syncing" connection={connection} />)
    const handler = connection.setSyncProgressHandler.mock.calls.at(-1)?.[0]
    expect(typeof handler).toBe('function')

    act(() => connection.emit({ receivedChars: 5, totalChars: 10 }))
    expect(screen.getByTestId(BAR)).toHaveAttribute('aria-valuenow', '50')

    rerender(<ConnectionOverlay state="reconnecting" connection={connection} />)
    expect(connection.setSyncProgressHandler).toHaveBeenLastCalledWith(null)
    expect(screen.queryByTestId(BAR)).toBeNull()
  })

  it('keeps the plain probing overlay (no connection) indeterminate on syncing', () => {
    render(<ConnectionOverlay state="syncing" />)
    expect(screen.getByTestId(BAR)).not.toHaveAttribute('aria-valuenow')
    expect(screen.queryByTestId(DETAIL)).toBeNull()
  })
})
