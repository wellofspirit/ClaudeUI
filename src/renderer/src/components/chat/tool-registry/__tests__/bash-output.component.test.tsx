/**
 * Bash streaming output boxes: the live (foreground) box and the background tail.
 * Both are max-height `<pre>` scrollers, so what grows is the wrapper inside the
 * pre (src/test/helpers/scroll-geometry.ts models the layout jsdom lacks).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, screen, act, fireEvent } from '@testing-library/react'
import { useSessionStore } from '../../../../stores/session-store'
import { bootTestApp, type TestApp } from '@test/helpers/boot-test-app'
import {
  dispatchScroll,
  dispatchWheel,
  distanceFromBottom,
  fireResize,
  geo,
  installScrollGeometry,
  setDefaultGeometry
} from '@test/helpers/scroll-geometry'
import { BackgroundBashOutput, LiveBashOutput } from '../kinds/bash-output'

const ROUTE = 'route-bash-output'
const TOOL_USE_ID = 'toolu_bash_output'

let restoreGeometry: () => void
let clock = 1000

beforeEach(() => {
  restoreGeometry = installScrollGeometry()
  setDefaultGeometry({ scrollHeight: 800, clientHeight: 172 })
  clock = 1000
  vi.spyOn(performance, 'now').mockImplementation(() => clock)
})

afterEach(() => {
  vi.restoreAllMocks()
  restoreGeometry()
})

describe('LiveBashOutput', () => {
  const pre = (): HTMLElement => {
    const el = screen.getByTestId('LiveBashOutput').querySelector('pre')
    if (!el) throw new Error('no pre')
    return el
  }
  const inner = (): HTMLElement => pre().firstElementChild as HTMLElement

  it('keeps its text and follows growth that changes no text', () => {
    render(<LiveBashOutput output={'a\nb'} totalLines={2} totalBytes={3} theme="dark" />)
    expect(pre().textContent).toBe('a\nb')
    expect(pre().scrollTop).toBe(0) // pinned only once the browser reports it laid out
    act(() => fireResize())
    expect(distanceFromBottom(pre())).toBe(0)

    geo(pre()).scrollHeight += 400
    act(() => fireResize(inner()))
    expect(distanceFromBottom(pre())).toBe(0)
  })

  it('keeps its text nodes when the follow state re-renders it', () => {
    render(<LiveBashOutput output={'a\nb'} totalLines={2} totalBytes={3} theme="dark" />)
    act(() => fireResize())
    const node = inner().firstChild
    act(() => dispatchWheel(pre(), -120))
    pre().scrollTop = 0
    act(() => dispatchScroll(pre()))
    expect(inner().firstChild).toBe(node)
    expect(node?.isConnected).toBe(true)
  })

  it('leaves a user who scrolled up alone', () => {
    render(<LiveBashOutput output="a" totalLines={1} totalBytes={1} theme="dark" />)
    act(() => fireResize())
    act(() => dispatchWheel(pre(), -120))
    pre().scrollTop = 50
    act(() => dispatchScroll(pre()))
    clock += 1000

    geo(pre()).scrollHeight += 400
    act(() => fireResize(inner()))
    expect(pre().scrollTop).toBe(50)
  })
})

describe('BackgroundBashOutput', () => {
  let app: TestApp
  const readBackgroundRange = vi.fn()

  const pre = (): HTMLElement => {
    const el = screen.getByTestId('BackgroundBashOutput').querySelector('pre')
    if (!el) throw new Error('no pre')
    return el
  }
  const inner = (): HTMLElement => pre().firstElementChild as HTMLElement

  beforeEach(async () => {
    app = await bootTestApp()
    Object.assign(window.api, {
      watchBackground: vi.fn(),
      unwatchBackground: vi.fn(),
      readBackgroundRange
    })
    useSessionStore.getState().createNewSession(ROUTE, '/d/repo')
    useSessionStore.setState({ activeSessionId: ROUTE })
    useSessionStore.getState().setBackgroundOutput(ROUTE, TOOL_USE_ID, 'tail line', 5000)
  })

  afterEach(() => {
    app.teardown()
    useSessionStore.setState({ activeSessionId: null, sessions: {} })
    readBackgroundRange.mockReset()
  })

  it('follows the streaming tail', () => {
    render(<BackgroundBashOutput toolUseId={TOOL_USE_ID} />)
    act(() => fireResize())
    expect(distanceFromBottom(pre())).toBe(0)
    geo(pre()).scrollHeight += 300
    act(() => {
      useSessionStore.getState().setBackgroundOutput(ROUTE, TOOL_USE_ID, 'tail line\nmore', 5010)
    })
    act(() => fireResize(inner()))
    expect(distanceFromBottom(pre())).toBe(0)
  })

  it('Load earlier does not pin the view back to the end', async () => {
    readBackgroundRange.mockResolvedValue('earlier output\n')
    render(<BackgroundBashOutput toolUseId={TOOL_USE_ID} />)
    act(() => fireResize()) // laid out, so pinned at the end ...
    // The user reads from the top; the box is still "following" (never scrolled).
    pre().scrollTop = 0
    clock += 1000

    await act(async () => {
      fireEvent.click(screen.getByTestId('BackgroundBashOutput.loadEarlier'))
    })
    geo(pre()).scrollHeight += 300
    act(() => fireResize(inner()))

    expect(pre().textContent).toContain('earlier output')
    expect(pre().scrollTop).toBe(0)
  })
})
