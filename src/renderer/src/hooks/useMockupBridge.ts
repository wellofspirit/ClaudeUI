import { useCallback, useEffect, useRef, useState } from 'react'
import type { RefObject } from 'react'
import { mockupOriginFor } from '../../../shared/mockup-url'

export interface MockupLogEntry {
  id: number
  timestamp: number
  level: 'log' | 'info' | 'warn' | 'error' | 'debug'
  args: string[]
}

export interface MockupErrorEntry {
  id: number
  timestamp: number
  message: string
  stack: string
  filename: string
  lineno: number
}

export interface MockupBridgeState {
  height: number | null
  logs: MockupLogEntry[]
  errors: MockupErrorEntry[]
  errorCount: number
}

const MAX_ENTRIES = 200

/**
 * Bridges the mockup iframe's `postMessage` channel to React state.
 *
 * Two-factor origin check:
 *   1. `event.source` must be the iframe's contentWindow we hold a ref to.
 *      Catches any stray postMessage from a sibling window or a rogue
 *      window.open() — only the actual iframe is trusted.
 *   2. `event.origin` must match this specific mockup's sub-origin
 *      (`mockup-asset://<id>.m`). Per-mockup origin isolation means another
 *      mockup in the same session can't impersonate this one.
 *
 * Anything failing either check is dropped silently. The payload is
 * whitelisted to the five message types our own bootstrap script emits.
 */
export function useMockupBridge(
  iframeRef: RefObject<HTMLIFrameElement | null>,
  mockupId: string | null,
  /** Bumped on source reload so we reset logs + height. */
  version: number
): MockupBridgeState & { clearLogs: () => void } {
  const [height, setHeight] = useState<number | null>(null)
  const [logs, setLogs] = useState<MockupLogEntry[]>([])
  const [errors, setErrors] = useState<MockupErrorEntry[]>([])
  const [resetKey, setResetKey] = useState({ mockupId, version })
  const seqRef = useRef(0)

  // Sanctioned "reset state when prop changes" pattern (setState during
  // render, guarded by equality). See react.dev/reference/react/useState
  // §"Storing information from previous renders". Avoids the cascading-render
  // trap of calling setState inside useEffect. The seq counter is allowed to
  // keep climbing across resets — ids just need to be unique, not consecutive.
  //
  // On version bump (in-place reload of the same mockup), we clear logs and
  // errors but KEEP the previous height — otherwise the iframe briefly
  // collapses to its default size, causing a layout shift that can trigger
  // scroll-anchoring in the parent container. New height arrives shortly
  // via postMessage and replaces it. On mockupId change (a different mockup
  // altogether) we reset everything.
  if (resetKey.mockupId !== mockupId) {
    setResetKey({ mockupId, version })
    setHeight(null)
    setLogs([])
    setErrors([])
  } else if (resetKey.version !== version) {
    setResetKey({ mockupId, version })
    setLogs([])
    setErrors([])
  }

  useEffect(() => {
    if (!mockupId) return

    const expectedOrigin = mockupOriginFor(mockupId)

    const handler = (event: MessageEvent): void => {
      const iframe = iframeRef.current
      if (!iframe || event.source !== iframe.contentWindow) return
      if (event.origin !== expectedOrigin) return

      const data = event.data
      if (!data || typeof data !== 'object') return

      switch ((data as { type?: unknown }).type) {
        case 'mockup:height': {
          const h = (data as { height?: unknown }).height
          if (typeof h === 'number' && Number.isFinite(h) && h >= 0 && h <= 20000) {
            setHeight(Math.round(h))
          }
          break
        }
        case 'mockup:log': {
          const level = (data as { level?: unknown }).level
          const args = (data as { args?: unknown }).args
          if (
            typeof level === 'string' &&
            ['log', 'info', 'warn', 'error', 'debug'].includes(level) &&
            Array.isArray(args)
          ) {
            const safeArgs = args.filter((a): a is string => typeof a === 'string').slice(0, 50)
            const entry: MockupLogEntry = {
              id: ++seqRef.current,
              timestamp: Date.now(),
              level: level as MockupLogEntry['level'],
              args: safeArgs
            }
            setLogs((prev) =>
              prev.length >= MAX_ENTRIES ? [...prev.slice(1), entry] : [...prev, entry]
            )
          }
          break
        }
        case 'mockup:error': {
          const message = (data as { message?: unknown }).message
          if (typeof message === 'string') {
            const entry: MockupErrorEntry = {
              id: ++seqRef.current,
              timestamp: Date.now(),
              message,
              stack:
                typeof (data as { stack?: unknown }).stack === 'string'
                  ? (data as { stack: string }).stack
                  : '',
              filename:
                typeof (data as { filename?: unknown }).filename === 'string'
                  ? (data as { filename: string }).filename
                  : '',
              lineno:
                typeof (data as { lineno?: unknown }).lineno === 'number'
                  ? (data as { lineno: number }).lineno
                  : 0
            }
            setErrors((prev) =>
              prev.length >= MAX_ENTRIES ? [...prev.slice(1), entry] : [...prev, entry]
            )
          }
          break
        }
      }
    }

    window.addEventListener('message', handler)
    return () => window.removeEventListener('message', handler)
  }, [iframeRef, mockupId])

  const clearLogs = useCallback(() => {
    setLogs([])
    setErrors([])
  }, [])

  return { height, logs, errors, errorCount: errors.length, clearLogs }
}
