/**
 * Layer 1: Unit tests for the mockup iframe → parent postMessage bridge.
 *
 * Exercises the two-factor origin check (source + origin) plus payload
 * schema validation. The iframe ref is faked so we can precisely control
 * what `event.source` matches against.
 */

import React, { useEffect, useMemo } from 'react'
import type { RefObject } from 'react'
import { describe, it, expect, beforeEach } from 'vitest'
import { render, act } from '@testing-library/react'
import { useMockupBridge, type MockupBridgeState } from '../useMockupBridge'

const MOCKUP_ID = 'abc12345'
const MOCKUP_ORIGIN = `mockup-asset://${MOCKUP_ID}.m`

interface HarnessOutput extends MockupBridgeState {
  clearLogs: () => void
}

// Out-of-component capture container. Writes happen only inside useEffect
// (post-commit) so the component body itself remains pure — satisfies the
// `react-hooks/globals` rule.
const captureRef: { current: HarnessOutput | null } = { current: null }
let iframeContentWindow: Window | null = null

function Harness({
  mockupId,
  version,
  source
}: {
  mockupId: string | null
  version: number
  source: Window | null
}): React.JSX.Element {
  // Build a synthetic RefObject each render so we never mutate an existing
  // ref during render (flagged by react-hooks/refs). The bridge only reads
  // `ref.current.contentWindow`; a plain object satisfies its contract.
  const ref = useMemo<RefObject<HTMLIFrameElement | null>>(
    () => ({
      current: source ? ({ contentWindow: source } as unknown as HTMLIFrameElement) : null
    }),
    [source]
  )
  const state = useMockupBridge(ref, mockupId, version)
  useEffect(() => {
    captureRef.current = state
  })
  return <div />
}

function dispatch(data: unknown, origin: string, source: Window | null): void {
  const ev = new MessageEvent('message', { data, origin, source })
  window.dispatchEvent(ev)
}

beforeEach(() => {
  captureRef.current = null
  // Use a real window-like — in jsdom, window.open returns another jsdom window;
  // simpler: use `window` itself as the "iframe" source and dispatch from same.
  iframeContentWindow = window
})

describe('useMockupBridge', () => {
  it('accepts a height message from the expected source + origin', () => {
    render(<Harness mockupId={MOCKUP_ID} version={1} source={iframeContentWindow} />)

    act(() => {
      dispatch({ type: 'mockup:height', height: 420 }, MOCKUP_ORIGIN, iframeContentWindow)
    })

    expect(captureRef.current?.height).toBe(420)
  })

  it('rejects a message whose origin does not match', () => {
    render(<Harness mockupId={MOCKUP_ID} version={1} source={iframeContentWindow} />)

    act(() => {
      dispatch(
        { type: 'mockup:height', height: 420 },
        'mockup-asset://otherid.m',
        iframeContentWindow
      )
    })

    expect(captureRef.current?.height).toBeNull()
  })

  it('rejects a message from a different source window even on the right origin', () => {
    const other = { postMessage: () => {} } as unknown as Window
    render(<Harness mockupId={MOCKUP_ID} version={1} source={iframeContentWindow} />)

    act(() => {
      dispatch({ type: 'mockup:height', height: 420 }, MOCKUP_ORIGIN, other)
    })

    expect(captureRef.current?.height).toBeNull()
  })

  it('ignores messages when mockupId is null', () => {
    render(<Harness mockupId={null} version={1} source={iframeContentWindow} />)

    act(() => {
      dispatch({ type: 'mockup:height', height: 420 }, MOCKUP_ORIGIN, iframeContentWindow)
    })

    expect(captureRef.current?.height).toBeNull()
  })

  it('rejects absurd heights (defense against hostile iframe)', () => {
    render(<Harness mockupId={MOCKUP_ID} version={1} source={iframeContentWindow} />)

    act(() => {
      dispatch({ type: 'mockup:height', height: 999999 }, MOCKUP_ORIGIN, iframeContentWindow)
    })
    expect(captureRef.current?.height).toBeNull()

    act(() => {
      dispatch({ type: 'mockup:height', height: -100 }, MOCKUP_ORIGIN, iframeContentWindow)
    })
    expect(captureRef.current?.height).toBeNull()

    act(() => {
      dispatch({ type: 'mockup:height', height: 'tall' }, MOCKUP_ORIGIN, iframeContentWindow)
    })
    expect(captureRef.current?.height).toBeNull()
  })

  it('collects console log entries with valid level + args', () => {
    render(<Harness mockupId={MOCKUP_ID} version={1} source={iframeContentWindow} />)

    act(() => {
      dispatch(
        { type: 'mockup:log', level: 'warn', args: ['deprecated api'] },
        MOCKUP_ORIGIN,
        iframeContentWindow
      )
    })

    expect(captureRef.current?.logs).toHaveLength(1)
    expect(captureRef.current?.logs[0]).toMatchObject({ level: 'warn', args: ['deprecated api'] })
  })

  it('rejects log messages with an invalid level', () => {
    render(<Harness mockupId={MOCKUP_ID} version={1} source={iframeContentWindow} />)

    act(() => {
      dispatch(
        { type: 'mockup:log', level: 'evil', args: ['x'] },
        MOCKUP_ORIGIN,
        iframeContentWindow
      )
    })

    expect(captureRef.current?.logs).toHaveLength(0)
  })

  it('collects error entries with stack info', () => {
    render(<Harness mockupId={MOCKUP_ID} version={1} source={iframeContentWindow} />)

    act(() => {
      dispatch(
        {
          type: 'mockup:error',
          message: 'kaboom',
          stack: 'Error: kaboom\n  at foo',
          filename: 'inline',
          lineno: 42
        },
        MOCKUP_ORIGIN,
        iframeContentWindow
      )
    })

    expect(captureRef.current?.errorCount).toBe(1)
    expect(captureRef.current?.errors[0]).toMatchObject({ message: 'kaboom', lineno: 42 })
  })

  it('ignores messages without a known type', () => {
    render(<Harness mockupId={MOCKUP_ID} version={1} source={iframeContentWindow} />)

    act(() => {
      dispatch({ type: 'steal', cookies: 'yum' }, MOCKUP_ORIGIN, iframeContentWindow)
    })

    expect(captureRef.current?.logs).toHaveLength(0)
    expect(captureRef.current?.errors).toHaveLength(0)
    expect(captureRef.current?.height).toBeNull()
  })

  it('ignores non-object data (string payloads)', () => {
    render(<Harness mockupId={MOCKUP_ID} version={1} source={iframeContentWindow} />)

    act(() => {
      dispatch('{"type":"mockup:height","height":500}', MOCKUP_ORIGIN, iframeContentWindow)
    })

    expect(captureRef.current?.height).toBeNull()
  })

  it('on version bump (same mockup), clears logs/errors but KEEPS height', () => {
    // Preserving height across in-place reloads avoids the iframe collapsing
    // to its default size for a frame, which otherwise triggers a layout
    // shift + scroll-anchor jump in the parent container.
    const { rerender } = render(
      <Harness mockupId={MOCKUP_ID} version={1} source={iframeContentWindow} />
    )

    act(() => {
      dispatch({ type: 'mockup:height', height: 300 }, MOCKUP_ORIGIN, iframeContentWindow)
      dispatch(
        { type: 'mockup:log', level: 'error', args: ['nope'] },
        MOCKUP_ORIGIN,
        iframeContentWindow
      )
    })
    expect(captureRef.current?.height).toBe(300)
    expect(captureRef.current?.logs).toHaveLength(1)

    rerender(<Harness mockupId={MOCKUP_ID} version={2} source={iframeContentWindow} />)

    // Height preserved across version bump; logs + errors cleared.
    expect(captureRef.current?.height).toBe(300)
    expect(captureRef.current?.logs).toHaveLength(0)
    expect(captureRef.current?.errors).toHaveLength(0)
  })

  it('on mockupId change (different mockup), resets height too', () => {
    // A completely different mockup should start from a clean slate — the
    // previous height belongs to a different document.
    const { rerender } = render(
      <Harness mockupId={MOCKUP_ID} version={1} source={iframeContentWindow} />
    )

    act(() => {
      dispatch({ type: 'mockup:height', height: 300 }, MOCKUP_ORIGIN, iframeContentWindow)
    })
    expect(captureRef.current?.height).toBe(300)

    rerender(<Harness mockupId="deadbeef" version={1} source={iframeContentWindow} />)

    expect(captureRef.current?.height).toBeNull()
  })

  it('caps entries at MAX_ENTRIES to avoid unbounded memory growth', () => {
    render(<Harness mockupId={MOCKUP_ID} version={1} source={iframeContentWindow} />)

    act(() => {
      for (let i = 0; i < 250; i++) {
        dispatch(
          { type: 'mockup:log', level: 'log', args: [String(i)] },
          MOCKUP_ORIGIN,
          iframeContentWindow
        )
      }
    })

    expect(captureRef.current?.logs.length).toBeLessThanOrEqual(200)
    // And the tail holds the newest entry.
    expect(captureRef.current?.logs.at(-1)?.args[0]).toBe('249')
  })

  it('clearLogs wipes both logs and errors', () => {
    render(<Harness mockupId={MOCKUP_ID} version={1} source={iframeContentWindow} />)

    act(() => {
      dispatch(
        { type: 'mockup:log', level: 'log', args: ['hi'] },
        MOCKUP_ORIGIN,
        iframeContentWindow
      )
      dispatch({ type: 'mockup:error', message: 'err' }, MOCKUP_ORIGIN, iframeContentWindow)
    })

    expect(captureRef.current?.logs).toHaveLength(1)
    expect(captureRef.current?.errors).toHaveLength(1)

    act(() => {
      captureRef.current?.clearLogs()
    })

    expect(captureRef.current?.logs).toHaveLength(0)
    expect(captureRef.current?.errors).toHaveLength(0)
  })
})
