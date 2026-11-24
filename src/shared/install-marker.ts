/**
 * The install marker: `claudeui-install.json`, written into a packaged build
 * after electron-builder (and, on macOS, before codesign) by
 * `scripts/stamp-install-marker.mjs`.
 *
 * It is what proves a directory is a ClaudeUI install the relaunch helper may
 * rename and the deletion gate may remove (design review ruling 1). A Windows
 * zip has no root folder, so "Extract here" into Downloads would otherwise make
 * Downloads look like the install: the marker lists the packaged directory's
 * top-level entries, and a directory holding anything else is not eligible.
 *
 * Pure (no Node imports): every layer imports `src/shared`. The file is
 * untrusted input, so {@link parseInstallMarker} validates it strictly.
 */

export const INSTALL_MARKER_FILE = 'claudeui-install.json'
/** The product id the marker names (electron-builder.yml `appId`). */
export const INSTALL_MARKER_PRODUCT = 'com.claudeui.app'

export type InstallMarkerPlatform = 'mac' | 'win'

export interface InstallMarker {
  schema: 1
  product: typeof INSTALL_MARKER_PRODUCT
  kind: 'desktop'
  /**
   * Windows: the sorted top-level names of the packaged directory. macOS: empty
   * (a bundle is self-contained, its parent is the user's folder).
   */
  entries: string[]
}

/**
 * Where the marker sits inside an install, as path segments relative to the
 * install root (the `.app` bundle on macOS, the folder holding the exe on Windows).
 */
export const INSTALL_MARKER_SEGMENTS: Readonly<Record<InstallMarkerPlatform, readonly string[]>> = {
  mac: ['Contents', 'Resources', INSTALL_MARKER_FILE],
  win: ['resources', INSTALL_MARKER_FILE]
}

/** `process.platform` → the marker layout, or null where there is none (Linux). */
export function markerPlatformOf(platform: string): InstallMarkerPlatform | null {
  if (platform === 'darwin') return 'mac'
  if (platform === 'win32') return 'win'
  return null
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)

/** A top-level entry name: non-empty, no separators, not `.` / `..`. */
function isEntryName(v: unknown): v is string {
  return typeof v === 'string' && v !== '' && v !== '.' && v !== '..' && !/[\\/\0]/.test(v)
}

/** The marker, or null for anything that is not exactly a ClaudeUI desktop marker. */
export function parseInstallMarker(raw: unknown): InstallMarker | null {
  if (!isRecord(raw)) return null
  if (raw.schema !== 1 || raw.product !== INSTALL_MARKER_PRODUCT || raw.kind !== 'desktop')
    return null
  if (!Array.isArray(raw.entries) || !raw.entries.every(isEntryName)) return null
  return { schema: 1, product: INSTALL_MARKER_PRODUCT, kind: 'desktop', entries: [...raw.entries] }
}

/**
 * The names in `actual` the marker does not list, sorted. Windows compares
 * case-insensitively (NTFS is case-preserving, not case-sensitive).
 */
export function unexpectedEntries(
  actual: readonly string[],
  marker: InstallMarker,
  caseInsensitive: boolean
): string[] {
  const norm = (s: string): string => (caseInsensitive ? s.toLowerCase() : s)
  const known = new Set(marker.entries.map(norm))
  return actual.filter((name) => !known.has(norm(name))).sort()
}
