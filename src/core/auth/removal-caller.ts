/**
 * The call site that asked to remove an engine credential, for the log line
 * `removeVendorAuth` writes (ADR-074 slice 1 follow-up: an OpenRouter key
 * vanished from pi's auth.json with no trace of who removed it).
 *
 * Three frames above the caller, joined, so the log names the path rather
 * than just the adapter method. Never includes arguments, so no key material.
 */
export function removalCaller(): string {
  const frames = (new Error().stack ?? '').split('\n').slice(3, 6)
  return frames.map((frame) => frame.trim().replace(/^at /, '')).join(' <- ') || 'unknown caller'
}
