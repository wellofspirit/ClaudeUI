/**
 * A per-message height estimate that is computed once per message OBJECT.
 *
 * The store replaces a message object only when that message changed (a stream
 * delta rebuilds the one it lands in; `overlayItemStreams` hands every other
 * message back as-is), so a WeakMap keyed on the object makes the estimate of an
 * untouched message stable and free across renders. The map is dropped when the
 * column bucket or an option changes, since those change every estimate.
 */
import { useCallback, useMemo } from 'react'
import type { ChatMessage } from '../../../../../shared/types'
import { estimateMessageHeight, type EstimateOptions } from './estimate-height'

export function useMessageHeightEstimator(
  columnWidthPx: number,
  options: EstimateOptions
): (message: ChatMessage) => number {
  const cache = useMemo(
    () => ({ columnWidthPx, options, heights: new WeakMap<ChatMessage, number>() }),
    [columnWidthPx, options]
  )
  return useCallback(
    (message: ChatMessage) => {
      let height = cache.heights.get(message)
      if (height === undefined) {
        height = estimateMessageHeight(message, cache.columnWidthPx, cache.options)
        cache.heights.set(message, height)
      }
      return height
    },
    [cache]
  )
}
