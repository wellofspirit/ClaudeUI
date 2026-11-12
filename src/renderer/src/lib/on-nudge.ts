/**
 * Re-read on a payload-free nudge channel, and after every answered sync.
 *
 * A nudge channel only says "something changed, read again". A full sync
 * replays no events, so a listener that waits for the event never re-reads
 * after a reconnect that fell back to one; `onSyncAnswered` covers that. Any
 * of the channels or an answered sync arms ONE timer, so a burst is one read.
 *
 * Built on the client registry alone, so the desktop renderer and the web
 * client get it alike. For channels whose listener uses the payload, keep the
 * listener and add an `onSyncAnswered` re-read beside it.
 */
import { onSyncAnswered, onSyncEvent } from '../../../core/shared/sync/client-registry'
import type { SyncEventMap } from '../../../core/shared/sync/events'

export function onNudge(
  channels: keyof SyncEventMap | readonly (keyof SyncEventMap)[],
  refetch: () => void,
  debounceMs: number
): () => void {
  let timer: ReturnType<typeof setTimeout> | undefined
  const arm = (): void => {
    clearTimeout(timer)
    timer = setTimeout(() => {
      timer = undefined
      refetch()
    }, debounceMs)
  }
  const list = typeof channels === 'string' ? [channels] : channels
  // The payload is ignored; the cast keeps one no-arg listener for every channel.
  const offs = list.map((channel) => onSyncEvent(channel, arm as never))
  offs.push(onSyncAnswered(arm))
  return () => {
    clearTimeout(timer)
    timer = undefined
    for (const off of offs) off()
  }
}
