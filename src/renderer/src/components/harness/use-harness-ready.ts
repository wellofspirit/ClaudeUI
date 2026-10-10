/**
 * The composer's side of a harness becoming installed while the app runs
 * (ADR-082 §8, S7b).
 *
 * Model discovery (`session:get-engine-models`) answers nothing for a harness
 * that does not run, so the composer has to ask again once it runs — and again
 * whenever a harness runs as a different binary. That reload is the harness
 * store's, not the composer's (`harnessStore.followRunChanges`, followed in
 * `stores/session-store.ts`), so it holds with no composer mounted.
 *
 * `useSeedModelWhenHarnessReady` gives the active session the model a new
 * session would have got: `createNewSession` seeded none while its harness was
 * missing. It fires once per session it saw blocked, when that session's
 * harness runs and its catalog has arrived, so a configured default that is
 * gone is reported once, not on every render.
 */
import { useEffect, useRef, useSyncExternalStore } from 'react'
import type { EngineId } from '../../../../shared/types'
import { useSessionStore } from '../../stores/session-store'
import { harnessStore } from '../SettingsDialog/harness-store'
import { harnessReadiness } from '../SettingsDialog/harness-view'

function useHarnessSnapshot(): ReturnType<typeof harnessStore.getState>['snapshot'] {
  return useSyncExternalStore(harnessStore.subscribe, () => harnessStore.getState().snapshot)
}

export function useSeedModelWhenHarnessReady(
  routingId: string | null,
  engineId: EngineId,
  selectedModel: string,
  catalogSize: number
): void {
  const snapshot = useHarnessSnapshot()
  /** Sessions seen with no model while their harness could not run. */
  const waiting = useRef(new Set<string>())
  const readiness = harnessReadiness(snapshot, engineId)
  useEffect(() => {
    if (!routingId) return
    if (readiness !== 'ready' && readiness !== 'unknown') {
      if (!selectedModel) waiting.current.add(routingId)
      return
    }
    if (readiness !== 'ready' || !waiting.current.has(routingId)) return
    if (selectedModel) {
      waiting.current.delete(routingId)
      return
    }
    // Wait for this engine's catalog: seeding against an empty one would
    // report a configured default as gone when it simply has not loaded.
    if (catalogSize === 0) return
    waiting.current.delete(routingId)
    useSessionStore.getState().seedUnsetModel(routingId)
  }, [routingId, readiness, selectedModel, catalogSize])
}
