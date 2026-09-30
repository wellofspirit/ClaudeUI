/**
 * A harness ARRIVING: going from "cannot run" to "runs" (ADR-082 §8, "As built
 * (S7d)"). ClaudeUI writes nothing into a harness's own files while it cannot
 * run, so the moment it can is when it gets the current state: the shared
 * providers' keys and definitions, and the ChatGPT credential.
 *
 * The resolver rings `onHarnessChanged` on every invalidation — an install, a
 * selection change, a finished detection — whether or not anything changed for
 * the harness. This tracks each harness's last availability, so only a real
 * transition calls `onArrival`; a harness that stops running just records it.
 */
import type { HarnessId } from '../../shared/harness-types'
import { logger } from '../services/logger'
import { harnessWritable, onHarnessChanged } from './resolve'

export interface HarnessArrivalDeps {
  /** Whether a harness runs now. */
  runs?: (id: HarnessId) => boolean
  /** Subscribe to resolver changes; returns the unsubscribe function. */
  subscribe?: (listener: (id: HarnessId) => void) => () => void
}

/**
 * Call `onArrival(id)` each time one of `ids` goes from not running to
 * running. The starting availability is read now, so a harness that already
 * runs does not arrive. Returns the unsubscribe function.
 */
export function watchHarnessArrivals<Id extends HarnessId>(
  ids: readonly Id[],
  onArrival: (id: Id) => void,
  deps: HarnessArrivalDeps = {}
): () => void {
  const runs = deps.runs ?? harnessWritable
  const subscribe = deps.subscribe ?? onHarnessChanged
  const previous = new Map<HarnessId, boolean>(ids.map((id) => [id, runs(id)]))
  const watched = (id: HarnessId): id is Id => previous.has(id)
  return subscribe((id) => {
    if (!watched(id)) return
    const now = runs(id)
    const was = previous.get(id)
    previous.set(id, now)
    if (now && !was) {
      logger.info('harness', `${id} runs now — delivering what ClaudeUI holds for it`)
      onArrival(id)
    }
  })
}
