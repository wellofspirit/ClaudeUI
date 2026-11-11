import { useCallback, useEffect, useRef, useState } from 'react'
import type { RefObject } from 'react'
import { mockupReloadTarget } from '../components/mockup-transport'

export type MockupReloadStatus = 'idle' | 'reloading' | 'updated'

export interface MockupReloadApi {
  reload: () => void
  status: MockupReloadStatus
  /** Incremented per reload(); feeds useMockupBridge's log/error reset. */
  version: number
  /** Use as the iframe's React `key`; bumps when the in-place reload got no ack. */
  frameKey: number
  /** Wire to the iframe's `onLoad`. */
  onFrameLoad: () => void
}

const ACK_TIMEOUT_MS = 1500
const UPDATED_VISIBLE_MS = 1500

/**
 * In-place mockup reload with feedback. Posts `mockup:reload` to the iframe;
 * the bootstrap acks with `mockup:reloading` just before `location.reload()`.
 * No ack in time (old bootstrap, dead page) → remount the iframe via `frameKey`.
 */
export function useMockupReload(
  iframeRef: RefObject<HTMLIFrameElement | null>,
  mockupId: string | null,
  expectedOrigin: string | undefined
): MockupReloadApi {
  const [status, setStatus] = useState<MockupReloadStatus>('idle')
  const [version, setVersion] = useState(1)
  const [frameKey, setFrameKey] = useState(0)
  const statusRef = useRef<MockupReloadStatus>('idle')
  const ackTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const updatedTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const awaitingAck = useRef(false)

  const setBoth = useCallback((s: MockupReloadStatus) => {
    statusRef.current = s
    setStatus(s)
  }, [])

  const clearTimers = useCallback(() => {
    if (ackTimer.current) clearTimeout(ackTimer.current)
    if (updatedTimer.current) clearTimeout(updatedTimer.current)
    ackTimer.current = null
    updatedTimer.current = null
    awaitingAck.current = false
  }, [])

  const fallback = useCallback(() => {
    awaitingAck.current = false
    setFrameKey((k) => k + 1)
  }, [])

  const reload = useCallback(() => {
    clearTimers()
    setVersion((v) => v + 1)
    // No iframe mounted (the view shows its error pane): nothing can load, so no
    // spinner — the iframe loads fresh whenever the view mounts it again.
    if (!iframeRef.current) {
      setBoth('idle')
      return
    }
    setBoth('reloading')
    const win = iframeRef.current.contentWindow
    if (!win || !mockupId) {
      fallback()
      return
    }
    awaitingAck.current = true
    try {
      win.postMessage({ type: 'mockup:reload' }, mockupReloadTarget(mockupId))
    } catch {
      // the ack timer below remounts the frame
    }
    ackTimer.current = setTimeout(() => {
      ackTimer.current = null
      fallback()
    }, ACK_TIMEOUT_MS)
  }, [iframeRef, mockupId, clearTimers, setBoth, fallback])

  useEffect(() => {
    const onMessage = (event: MessageEvent): void => {
      if (!awaitingAck.current) return
      if (event.source !== iframeRef.current?.contentWindow) return
      if (event.origin !== expectedOrigin) return
      const d = event.data as { type?: unknown } | null
      if (!d || d.type !== 'mockup:reloading') return
      awaitingAck.current = false
      if (ackTimer.current) clearTimeout(ackTimer.current)
      ackTimer.current = null
    }
    window.addEventListener('message', onMessage)
    return () => window.removeEventListener('message', onMessage)
  }, [iframeRef, expectedOrigin])

  const onFrameLoad = useCallback(() => {
    if (statusRef.current !== 'reloading') return
    clearTimers()
    setBoth('updated')
    updatedTimer.current = setTimeout(() => {
      updatedTimer.current = null
      setBoth('idle')
    }, UPDATED_VISIBLE_MS)
  }, [clearTimers, setBoth])

  // Drop pending timers and feedback when the mockup changes or on unmount.
  useEffect(() => {
    return () => {
      clearTimers()
      statusRef.current = 'idle'
      setStatus('idle')
    }
  }, [mockupId, clearTimers])

  return { reload, status, version, frameKey, onFrameLoad }
}
