import type { MediaCatalog } from '../../../shared/media-generation'
import { buildMediaProtocolUrl } from '../../../shared/media-protocol-url'
import { buildMediaFileUrl, MEDIA_JOB_ID_RE } from '../../../shared/sent-file-url'

/**
 * Where a client loads a saved media file (a video's `<video src>`) from, by the job's `fileId`
 * (never a path). The web client uses the remote server's `/media-file` route with its file
 * token (as `/sent-file` previews do); the desktop has no server, so it uses the
 * `claudeui-media://` protocol. Both are ledger-checked on the host and support Range. `null`
 * means no URL yet (web before the file token arrives, or a malformed id): the card shows the
 * saved path with Open / Reveal instead.
 */
export function mediaFileUrl(fileId: string): string | null {
  if (!MEDIA_JOB_ID_RE.test(fileId)) return null
  if (window.api?.platform === 'web') {
    const token = window.__FILE_TOKEN__
    return token ? buildMediaFileUrl(window.location.origin, fileId, { token }) : null
  }
  return buildMediaProtocolUrl(fileId)
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
