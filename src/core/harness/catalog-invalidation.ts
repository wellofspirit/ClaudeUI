/**
 * Model catalogs follow the harness that answers them (ADR-082).
 *
 * pi and opencode discovery cache what the binary they spawned reported, until
 * something invalidates it. An install, an uninstall, a selection change or an
 * update replaces that binary, so its catalog is a different one: pi 0.99.1
 * bundles models 0.87.1 never listed. This drops an engine's model, catalog,
 * capability and negative caches the moment the binary ClaudeUI runs for it
 * changes, before anyone asks again.
 *
 * The resolver rings `onHarnessChanged` on every invalidation — a detection
 * run rings it for every harness whether or not anything changed — so this
 * compares the harness's revision now (`harnessRevision`, the token
 * `harness:state` also carries, so the renderer reloads on the same changes)
 * with the last one, and invalidates only on a real change: a warm catalog
 * survives the detection that runs a few seconds after every boot. Resolving here is safe:
 * `arrivals.ts` does the same, and the scheduler drops a `stale` request a
 * resolution makes while its own run is still in flight.
 *
 * Codex is not here: its discovery memo is keyed by the resolved binary's
 * identity on every call (`codex/model-discovery.ts`), so a new binary is
 * already a cache miss. Claude Code's models do not come from a harness probe.
 *
 * The invalidators are injected (boot passes the two discovery modules'), so
 * the harness layer never imports an engine module.
 */
import type { HarnessId } from '../../shared/harness-types'
import { logger } from '../services/logger'
import { harnessRevision, onHarnessChanged } from './resolve'

/** The harnesses whose model catalogs come from probing their binary. */
export type CatalogHarnessId = 'pi' | 'opencode'

export interface CatalogInvalidationDeps {
  /** What `id` resolves to now; two equal values mean the same binary. */
  identity?: (id: CatalogHarnessId) => string
  /** Subscribe to resolver changes; returns the unsubscribe function. */
  subscribe?: (listener: (id: HarnessId) => void) => () => void
}

let stopCurrent: (() => void) | null = null

/**
 * Invalidate each engine's discovery caches when the binary its harness
 * resolves to changes. The revisions are read now, so the binary that
 * already runs is not a change.
 *
 * App-lifetime, like `startHarnessEvents` and `watchHarnessArrivals` beside it
 * in boot: neither host tears core down before exit, so boot keeps no stop
 * function. A second start replaces the first (a test that boots core twice),
 * and the returned stop is for tests.
 */
export function startCatalogInvalidation(
  invalidate: Record<CatalogHarnessId, () => void>,
  deps: CatalogInvalidationDeps = {}
): () => void {
  stopCurrent?.()
  const identity = deps.identity ?? harnessRevision
  const subscribe = deps.subscribe ?? onHarnessChanged
  const watched = (id: HarnessId): id is CatalogHarnessId => Object.hasOwn(invalidate, id)
  const last = new Map<CatalogHarnessId, string>()
  for (const id of Object.keys(invalidate) as CatalogHarnessId[]) last.set(id, identity(id))

  const off = subscribe((id) => {
    if (!watched(id)) return
    const now = identity(id)
    if (now === last.get(id)) return
    last.set(id, now)
    logger.info('harness', `${id} changed — dropping its model catalog`)
    try {
      invalidate[id]()
    } catch (err) {
      logger.warn('harness', `invalidating ${id}'s model catalog failed`, err)
    }
  })
  const stop = (): void => {
    off()
    if (stopCurrent === stop) stopCurrent = null
  }
  stopCurrent = stop
  return stop
}
