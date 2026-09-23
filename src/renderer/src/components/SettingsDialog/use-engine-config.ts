/**
 * use-engine-config.ts
 *
 * The ONE shared `EngineConfig` object per engine — the module-level store every
 * settings pane that writes an `engines/<engine>.json` file reads and edits
 * through, instead of holding its own copy.
 *
 * Consumers (four, over two files):
 *
 *  · Codex › Models & providers › Default models — `CodexDefaultsSection`
 *    (settings-sections.tsx), which writes `codexConfig`;
 *  · Dispatch › "Dispatch into" and "Limits" for claude / opencode / pi / codex
 *    — `DispatchIntoSection` / `DispatchLimitsSection` (settings-sections.tsx),
 *    which write `dispatch`;
 *  · pi › Models & thinking › the ClaudeUI half — `PiSessionDefaultModel`
 *    (PiConfigPanes.tsx), which writes `piConfig`.
 *
 * It lives in its own module rather than in settings-sections.tsx for the same
 * reason `use-engine-installed.ts` does: settings-sections.tsx IMPORTS
 * PiConfigPanes.tsx, so a pi pane reaching back into it would close an import
 * cycle.
 *
 * ## Why a shared external store and not a hook-local `useState`
 *
 * `saveEngineConfig` takes the WHOLE `EngineConfig` and replaces the file with
 * it — unlike `setRemoteConfig`, which takes a partial that main merges, and
 * which is the only reason the four Remote sections can each hold their own
 * copy. Two panes each holding their own copy of an engine's config would lose
 * data the moment both are on screen, which on the dispatch page is always:
 * pick a default model in "Dispatch into" (it saves A′), then commit a max cost
 * in "Limits" (which still holds the pre-edit A, and saves A + maxCost) — and
 * the model choice is silently reverted on disk. Panes from DIFFERENT pages get
 * there too: a settings SEARCH mounts live buckets from several pages at once,
 * which is how pi's default-model pane and pi's dispatch pane meet.
 *
 * So there is exactly ONE config object per engine, in a module-level store the
 * consumers subscribe to through `useSyncExternalStore`:
 *
 *  - the entry is created by the FIRST subscriber, which starts the single
 *    `loadEngineConfig` read; later subscribers join the entry and the in-flight
 *    read, so mounting two panes over one engine is one IPC round trip, not two;
 *  - every `update` writes the entry and notifies every subscriber before
 *    persisting, so the second edit is always computed against the first;
 *  - the entry is DROPPED when the last subscriber unsubscribes, so a fresh
 *    mount re-reads the file (the behaviour every other settings pane has) and
 *    one test cannot leak an engine's config into the next.
 *
 * The MODEL probe stays per-component (`useDispatchModels`) and runs only in the
 * panes with a picker to fill: it is the expensive half of the load.
 */

import { useCallback, useEffect, useState, useSyncExternalStore } from 'react'
import type { DispatchConfig, EngineConfig, EngineId, ModelInfo } from '../../../../shared/types'

interface DispatchStoreEntry {
  /** null until the first read resolves — the panes render a Loading row. */
  config: EngineConfig | null
  listeners: Set<() => void>
}

const DISPATCH_STORES = new Map<EngineId, DispatchStoreEntry>()

function emitDispatchConfig(entry: DispatchStoreEntry): void {
  for (const listener of entry.listeners) listener()
}

/**
 * The entry for one engine, creating it — and starting its single read — on
 * first use. A late-resolving read is dropped if the entry it belongs to has
 * since been discarded, so an unmounted pane cannot resurrect stale config.
 */
function dispatchEntry(engineId: EngineId): DispatchStoreEntry {
  const existing = DISPATCH_STORES.get(engineId)
  if (existing) return existing

  const entry: DispatchStoreEntry = { config: null, listeners: new Set() }
  DISPATCH_STORES.set(engineId, entry)

  const adopt = (config: EngineConfig): void => {
    if (DISPATCH_STORES.get(engineId) !== entry) return
    entry.config = config
    emitDispatchConfig(entry)
  }
  window.api
    .loadEngineConfig(engineId)
    .then(adopt)
    .catch(() => adopt({}))

  return entry
}

function subscribeDispatchConfig(engineId: EngineId, listener: () => void): () => void {
  const entry = dispatchEntry(engineId)
  entry.listeners.add(listener)
  return () => {
    entry.listeners.delete(listener)
    // Last one out drops the entry, so the next mount re-reads the file.
    if (entry.listeners.size === 0 && DISPATCH_STORES.get(engineId) === entry) {
      DISPATCH_STORES.delete(engineId)
    }
  }
}

/**
 * Read during render, so it must NOT create the entry (React calls this before
 * it calls `subscribe`) and must return a stable reference between updates.
 */
function dispatchSnapshot(engineId: EngineId): EngineConfig | null {
  return DISPATCH_STORES.get(engineId)?.config ?? null
}

/**
 * Merge a patch into the engine's config and persist the WHOLE file.
 *
 * The top-level entry point, because `dispatch` is not the only block edited
 * through this store any more: Codex's Default-models segment writes
 * `codexConfig` into the same `engines/codex.json`, pi's writes `piConfig` into
 * `engines/pi.json`, and `saveEngineConfig` replaces the file with whatever it
 * is handed. Two panes holding two copies is exactly the data loss the module
 * comment above describes.
 *
 * The store is written and broadcast BEFORE the save is awaited, so a second
 * edit is computed against the first even while the first is still in flight.
 * The returned promise is the save's — `useEngineConfigObject` wraps it as the
 * fire-and-forget `update`.
 */
function updateEngineConfigObject(engineId: EngineId, patch: Partial<EngineConfig>): Promise<void> {
  const entry = DISPATCH_STORES.get(engineId)
  if (!entry || entry.config === null) return Promise.resolve()
  const next: EngineConfig = { ...entry.config, ...patch }
  entry.config = next
  emitDispatchConfig(entry)
  return window.api.saveEngineConfig(engineId, next)
}

/**
 * Re-read one engine's file into its LIVE entry, if any pane holds one — for a
 * write made outside this store. The Manage sheet's model curation writes
 * `engines/<id>.json` through its own leaf writer (`models:set-provider-allowlist`)
 * while, on the same page, a pane over the same file may be mounted; left
 * holding the pre-curation object, that pane's next whole-file save would put
 * the old allowlist back.
 */
export function reloadEngineConfigObject(engineId: EngineId): Promise<void> {
  const entry = DISPATCH_STORES.get(engineId)
  if (!entry) return Promise.resolve()
  return window.api
    .loadEngineConfig(engineId)
    .then((config) => {
      if (DISPATCH_STORES.get(engineId) !== entry) return
      entry.config = config
      emitDispatchConfig(entry)
    })
    .catch(() => {})
}

/** Merge a patch into the engine's `dispatch` block and persist the whole file. */
function updateDispatchConfig(engineId: EngineId, patch: Partial<DispatchConfig>): void {
  const current = DISPATCH_STORES.get(engineId)?.config
  if (!current) return
  updateEngineConfigObject(engineId, {
    dispatch: { ...(current.dispatch ?? {}), ...patch }
  }).catch(() => {})
}

export interface DispatchConfigApi {
  /** null until the first read resolves — the panes render a Loading row. */
  engineCfg: EngineConfig | null
  dispatch: DispatchConfig
  /** Merge a patch into the `dispatch` block and persist the WHOLE config. */
  update: (patch: Partial<DispatchConfig>) => void
}

export interface EngineConfigApi {
  /** null until the first read resolves — the panes render a Loading row. */
  engineCfg: EngineConfig | null
  /** Merge and persist, swallowing a failed write — the row-click path. */
  update: (patch: Partial<EngineConfig>) => void
}

/** The shared `EngineConfig` object for one engine — the store, unwrapped. */
export function useEngineConfigObject(engineId: EngineId): EngineConfigApi {
  const subscribe = useCallback(
    (listener: () => void) => subscribeDispatchConfig(engineId, listener),
    [engineId]
  )
  const getSnapshot = useCallback(() => dispatchSnapshot(engineId), [engineId])
  const engineCfg = useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
  return {
    engineCfg,
    update: useCallback(
      (patch) => {
        updateEngineConfigObject(engineId, patch).catch(() => {})
      },
      [engineId]
    )
  }
}

export function useDispatchConfig(engineId: EngineId): DispatchConfigApi {
  const { engineCfg } = useEngineConfigObject(engineId)
  return {
    engineCfg,
    dispatch: engineCfg?.dispatch ?? {},
    update: (patch) => updateDispatchConfig(engineId, patch)
  }
}

/** The engine's own models, for a pane's picker and chip set. */
export function useDispatchModels(engineId: EngineId): ModelInfo[] {
  const [models, setModels] = useState<ModelInfo[]>([])
  useEffect(() => {
    let cancelled = false
    window.api
      .getEngineModels()
      .then((groups) => {
        if (cancelled) return
        setModels(groups.filter((g) => g.engineId === engineId).flatMap((g) => g.models))
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [engineId])
  return models
}
