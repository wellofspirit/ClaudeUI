import { useCallback, useEffect, useState } from 'react'
import type { MediaCatalog } from '../../../shared/media-generation'

/**
 * The media model catalog (`window.api.listMediaModels`), fetched when a component mounts and
 * again on `refresh`. `catalog` is null until the first answer; a failed query leaves it null
 * (the pickers then say nothing about staleness rather than guess).
 */
export function useMediaCatalog(): { catalog: MediaCatalog | null; refresh: () => void } {
  const [catalog, setCatalog] = useState<MediaCatalog | null>(null)
  const [tick, setTick] = useState(0)
  useEffect(() => {
    let live = true
    window.api
      .listMediaModels()
      .then((c) => {
        if (live) setCatalog(c)
      })
      .catch((err: unknown) => {
        window.api.logError('useMediaCatalog', `Failed to list media models: ${String(err)}`)
      })
    return () => {
      live = false
    }
  }, [tick])
  const refresh = useCallback(() => setTick((t) => t + 1), [])
  return { catalog, refresh }
}
