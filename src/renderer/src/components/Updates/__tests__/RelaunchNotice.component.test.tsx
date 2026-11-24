/**
 * Layer 2: the relaunch result notice. What each result says, once per result
 * token per client (localStorage, which may throw), never for an old result,
 * a re-read while the helper has not written the result yet, dismissible, and
 * a success that hides itself after ten seconds.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import type { RelaunchResult } from '../../../../../shared/relaunch'
import {
  READ_DELAYS_MS,
  RelaunchNotice,
  SEEN_KEY,
  SUCCESS_HIDE_MS,
  relaunchNoticeModel
} from '../RelaunchNotice'

const NOW = Date.parse('2026-11-25T10:00:00.000Z')
const TOKEN = 'a'.repeat(32)

function result(patch: Partial<RelaunchResult> = {}): RelaunchResult {
  return {
    token: TOKEN,
    status: 'updated',
    mode: 'swap',
    fromVersion: '3.9.1',
    toVersion: '3.9.2',
    at: NOW - 30_000,
    ...patch
  }
}

const api = { lastRelaunch: vi.fn<() => Promise<RelaunchResult | null>>() }

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
  vi.setSystemTime(NOW)
  window.localStorage.clear()
  api.lastRelaunch.mockReset()
  ;(globalThis as unknown as { window: { api: unknown } }).window.api = api
})

afterEach(() => {
  cleanup()
  vi.useRealTimers()
  vi.restoreAllMocks()
})

async function mount(): Promise<void> {
  render(<RelaunchNotice />)
  await act(async () => {
    await vi.advanceTimersByTimeAsync(0)
  })
}

describe('what a result says', () => {
  it('updated, with What’s new for a release; relaunched; rolled back with the reason', () => {
    expect(relaunchNoticeModel(result())).toEqual({
      tone: 'success',
      text: 'Updated to 3.9.2',
      notesUrl: 'https://github.com/wellofspirit/ClaudeUI/releases/tag/v3.9.2'
    })
    // A rebuild's version has no release page.
    expect(
      relaunchNoticeModel(result({ toVersion: '3.9.2-pre.1+5.abc' }))?.notesUrl
    ).toBeUndefined()
    expect(relaunchNoticeModel(result({ status: 'ok', mode: 'relaunch' }))).toEqual({
      tone: 'success',
      text: 'Relaunched'
    })
    expect(
      relaunchNoticeModel(result({ status: 'rolled-back', reason: 'no healthy boot in 90 s' }))
    ).toEqual({
      tone: 'warning',
      text: "3.9.2 didn't start, so ClaudeUI went back to 3.9.1",
      detail: 'no healthy boot in 90 s'
    })
    expect(
      relaunchNoticeModel(result({ status: 'aborted', reason: 'files in use' }))
    ).toMatchObject({
      tone: 'warning',
      text: "The update to 3.9.2 didn't happen; nothing changed",
      detail: 'files in use'
    })
  })
})

describe('the notice', () => {
  it('shows a new result once, with What’s new, and hides a success after ten seconds', async () => {
    api.lastRelaunch.mockResolvedValue(result())
    await mount()
    expect(screen.getByTestId('RelaunchNotice')).toHaveAttribute('data-state', 'success')
    expect(screen.getByTestId('RelaunchNotice.text')).toHaveTextContent(
      "Updated to 3.9.2 · What's new"
    )
    expect(window.localStorage.getItem(SEEN_KEY)).toBe(TOKEN)
    await act(async () => {
      await vi.advanceTimersByTimeAsync(SUCCESS_HIDE_MS)
    })
    expect(screen.queryByTestId('RelaunchNotice')).toBeNull()
    // The later reads do not bring it back.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(READ_DELAYS_MS[READ_DELAYS_MS.length - 1])
    })
    expect(screen.queryByTestId('RelaunchNotice')).toBeNull()
  })

  it('a result this client already showed is not shown again', async () => {
    window.localStorage.setItem(SEEN_KEY, TOKEN)
    api.lastRelaunch.mockResolvedValue(result())
    await mount()
    expect(screen.queryByTestId('RelaunchNotice')).toBeNull()
  })

  it('an old result is not news', async () => {
    api.lastRelaunch.mockResolvedValue(result({ at: NOW - 60 * 60_000 }))
    await mount()
    expect(screen.queryByTestId('RelaunchNotice')).toBeNull()
  })

  it('reads again while the helper has not written the result yet', async () => {
    api.lastRelaunch.mockResolvedValue(null)
    await mount()
    expect(screen.queryByTestId('RelaunchNotice')).toBeNull()
    api.lastRelaunch.mockResolvedValue(result({ status: 'rolled-back', reason: 'crashed' }))
    await act(async () => {
      await vi.advanceTimersByTimeAsync(READ_DELAYS_MS[1])
    })
    expect(screen.getByTestId('RelaunchNotice')).toHaveAttribute('data-state', 'warning')
    expect(screen.getByTestId('RelaunchNotice.detail')).toHaveTextContent('crashed')
    // A warning stays until dismissed.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(SUCCESS_HIDE_MS)
    })
    expect(screen.getByTestId('RelaunchNotice')).toBeInTheDocument()
    fireEvent.click(screen.getByTestId('RelaunchNotice.dismiss'))
    expect(screen.queryByTestId('RelaunchNotice')).toBeNull()
  })

  it('storage that throws still shows the notice', async () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('blocked')
    })
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('blocked')
    })
    api.lastRelaunch.mockResolvedValue(result({ status: 'ok', mode: 'relaunch' }))
    await mount()
    expect(screen.getByTestId('RelaunchNotice.text')).toHaveTextContent('Relaunched')
  })

  it('a host that cannot answer shows nothing', async () => {
    api.lastRelaunch.mockRejectedValue(new Error('no handler'))
    await mount()
    expect(screen.queryByTestId('RelaunchNotice')).toBeNull()
  })
})
