import type { MediaCatalog } from '../../../shared/media-generation'

/**
 * Where a client loads a saved media file (a video's `<video src>`) from: the authenticated
 * media file route, by the job's `fileId` (never a path). One function so the desktop and the
 * web client resolve it in one place; `null` means this client has no URL for it yet, and the
 * card shows the saved path with Open / Reveal instead.
 *
 * TODO(orchestrator): wire to implementer B's media file route. The web shape below is a
 * placeholder (`/media/<file token>/<fileId>`, the sent-files token); the desktop answer
 * (a custom protocol or the same route over loopback) is not decided.
 */
export function mediaFileUrl(fileId: string): string | null {
  if (window.api?.platform === 'web' && window.__FILE_TOKEN__) {
    const token = encodeURIComponent(window.__FILE_TOKEN__)
    return `${window.location.origin}/media/${token}/${encodeURIComponent(fileId)}`
  }
  return null
}

/** `$0.03` / `$0.0042`: cents up to two places, sub-cent amounts keep their significant digits. */
export function formatCostUsd(usd: number): string {
  if (usd >= 0.01) return `$${usd.toFixed(2)}`
  return `$${Number(usd.toPrecision(2))}`
}

/** `412 KB`, `1.4 MB`. */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

/** Plan usage line of the approval footer, when a snapshot exists. */
export function planUsageLine(planUsage: MediaCatalog['planUsage']): string | null {
  if (!planUsage || planUsage.usedPercent == null) return null
  const reset =
    planUsage.resetsInSeconds == null
      ? ''
      : planUsage.resetsInSeconds >= 3600
        ? ` · resets in ${Math.round(planUsage.resetsInSeconds / 3600)} h`
        : ` · resets in ${Math.max(1, Math.round(planUsage.resetsInSeconds / 60))} min`
  return `Plan image limit: ${Math.round(planUsage.usedPercent)}% used${reset}`
}
