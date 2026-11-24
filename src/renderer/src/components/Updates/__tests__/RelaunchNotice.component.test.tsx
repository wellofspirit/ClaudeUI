/**
 * Layer 2: the relaunch result notice. What each result says (builds named by
 * commit when a rebuild kept the version, the running build as Settings names
 * it, What's new only for a release that changed the version), once per result
 * token per client (localStorage, which may throw), never for an old result,
 * a re-read every second while the helper has not written the result yet,
 * dismissible, and a success that hides itself ten seconds after it is on screen.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import type { RelaunchResult } from '../../../../../shared/relaunch'
import type { AppUpdateView } from '../../../../../shared/types/app-update'
import { localView } from './fixtures'
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
    source: 'release',
    ...patch
  }
}

const api = {
  lastRelaunch: vi.fn<() => Promise<RelaunchResult | null>>(),
  appUpdateState: vi.fn<() => Promise<AppUpdateView>>()
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
  vi.setSystemTime(NOW)
  window.localStorage.clear()
  api.lastRelaunch.mockReset()
  api.appUpdateState.mockReset()
  api.appUpdateState.mockRejectedValue(new Error('not in this test'))
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
    // What's new only for a release: a rebuild, or a job that did not say, has none.
    expect(relaunchNoticeModel(result({ source: 'rebuild' }))?.notesUrl).toBeUndefined()
    expect(relaunchNoticeModel(result({ source: undefined }))?.notesUrl).toBeUndefined()
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

describe('a rebuild that kept the version', () => {
  const rebuilt = (patch: Partial<RelaunchResult> = {}): RelaunchResult =>
    result({
      fromVersion: '3.9.0',
      toVersion: '3.9.0',
      fromBuild: 'abc1234',
      toBuild: 'def5678',
      source: 'rebuild',
      ...patch
    })

  it('updated names the build it runs now, with no What’s new', () => {
    expect(relaunchNoticeModel(rebuilt())).toEqual({
      tone: 'success',
      text: 'Rebuilt from def5678'
    })
    // Even a release-sourced job keeps What's new off when the version did not change.
    expect(relaunchNoticeModel(rebuilt({ source: 'release' }))?.notesUrl).toBeUndefined()
    expect(relaunchNoticeModel(rebuilt({ toBuild: undefined }))?.text).toBe('Rebuilt')
  })

  it('rolled back names both builds', () => {
    expect(
      relaunchNoticeModel(rebuilt({ status: 'rolled-back', reason: 'no healthy boot in 90 s' }))
    ).toEqual({
      tone: 'warning',
      text: "The rebuild from def5678 didn't start, so ClaudeUI went back to abc1234",
      detail: 'no healthy boot in 90 s'
    })
  })
})

describe('the running build, named as Settings names it', () => {
  it('a local build reads as its tag and distance', () => {
    const current = localView().current
    // Updated to a local build whose package version is 3.9.0.
    expect(
      relaunchNoticeModel(
        result({ fromVersion: '3.8.9', toVersion: '3.9.0', source: 'rebuild' }),
        current
      )
    ).toEqual({ tone: 'success', text: 'Updated to 3.9.1-pre.13 +5' })
    // Rolled back to it.
    expect(
      relaunchNoticeModel(
        result({ status: 'rolled-back', fromVersion: '3.9.0', toVersion: '3.9.2' }),
        current
      )?.text
    ).toBe("3.9.2 didn't start, so ClaudeUI went back to 3.9.1-pre.13 +5")
    // A version that is not the running one stays as it is.
    expect(relaunchNoticeModel(result(), current)?.text).toBe('Updated to 3.9.2')
  })

  it('the notice reads the running build from the host', async () => {
    api.appUpdateState.mockResolvedValue(localView())
    api.lastRelaunch.mockResolvedValue(
      result({ fromVersion: '3.8.9', toVersion: '3.9.0', source: 'rebuild' })
    )
    await mount()
    expect(screen.getByTestId('RelaunchNotice.text')).toHaveTextContent(
      'Updated to 3.9.1-pre.13 +5'
    )
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

  it('reads every second for the first 15 s, then backs off', () => {
    expect(READ_DELAYS_MS.slice(0, 16)).toEqual(Array.from({ length: 16 }, (_, i) => i * 1000))
    expect(READ_DELAYS_MS.slice(16).every((ms) => ms > 15_000)).toBe(true)
  })

  it('a success waits for a hidden window to show before its ten seconds start', async () => {
    let visibility: DocumentVisibilityState = 'hidden'
    vi.spyOn(document, 'visibilityState', 'get').mockImplementation(() => visibility)
    api.lastRelaunch.mockResolvedValue(result())
    await mount()
    expect(screen.getByTestId('RelaunchNotice')).toBeInTheDocument()
    await act(async () => {
      await vi.advanceTimersByTimeAsync(SUCCESS_HIDE_MS * 3)
    })
    expect(screen.getByTestId('RelaunchNotice')).toBeInTheDocument()
    visibility = 'visible'
    act(() => {
      document.dispatchEvent(new Event('visibilitychange'))
    })
    await act(async () => {
      await vi.advanceTimersByTimeAsync(SUCCESS_HIDE_MS - 1)
    })
    expect(screen.getByTestId('RelaunchNotice')).toBeInTheDocument()
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1)
    })
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
