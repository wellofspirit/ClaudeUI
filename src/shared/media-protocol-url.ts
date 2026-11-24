/** Desktop-only custom scheme that serves a saved media file by job id (`src/main/services/media-protocol.ts`). */
export const MEDIA_PROTOCOL_SCHEME = 'claudeui-media'

/** `claudeui-media://job/<jobId>`: what the desktop renderer gives `<video src>`. */
export function buildMediaProtocolUrl(jobId: string): string {
  return `${MEDIA_PROTOCOL_SCHEME}://job/${encodeURIComponent(jobId)}`
}
