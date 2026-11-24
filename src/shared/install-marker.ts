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

/**
 * Where the marker sits: a macOS bundle, a Windows desktop folder, or the root of
 * a headless `claudeui-server` folder (whose layout is the same on every OS).
 */
export type InstallMarkerPlatform = 'mac' | 'win' | 'server'

/** What the marked directory is: the desktop app or the headless server. */
export type InstallMarkerKind = 'desktop' | 'server'

export interface InstallMarker {
  schema: 1
  product: typeof INSTALL_MARKER_PRODUCT
  kind: InstallMarkerKind
  /**
   * Windows and server: the sorted top-level names of the packaged directory.
   * macOS: empty (a bundle is self-contained, its parent is the user's folder).
   */
  entries: string[]
  /** The build's version (`out/build-info.json`), so a staged build can be checked without unpacking it. */
  version?: string
  /** The build's id (`buildId` in `src/shared/build-info.ts`). */
  buildId?: string
}

/**
 * Where the marker sits inside an install, as path segments relative to the
 * install root (the `.app` bundle on macOS, the folder holding the exe on Windows).
 */
export const INSTALL_MARKER_SEGMENTS: Readonly<Record<InstallMarkerPlatform, readonly string[]>> = {
  server: [INSTALL_MARKER_FILE],
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

const isLabel = (v: unknown): v is string =>
  typeof v === 'string' && v !== '' && v.length <= 200 && !/[\0\r\n]/.test(v)

/**
 * The marker, or null for anything that is not exactly a ClaudeUI marker of
 * `kind` (a desktop check never accepts a server marker, nor the reverse).
 */
export function parseInstallMarker(
  raw: unknown,
  kind: InstallMarkerKind = 'desktop'
): InstallMarker | null {
  if (!isRecord(raw)) return null
  if (raw.schema !== 1 || raw.product !== INSTALL_MARKER_PRODUCT || raw.kind !== kind) return null
  if (!Array.isArray(raw.entries) || !raw.entries.every(isEntryName)) return null
  if (raw.version !== undefined && !isLabel(raw.version)) return null
  if (raw.buildId !== undefined && !isLabel(raw.buildId)) return null
  return {
    schema: 1,
    product: INSTALL_MARKER_PRODUCT,
    kind,
    entries: [...raw.entries],
    ...(raw.version !== undefined ? { version: raw.version } : {}),
    ...(raw.buildId !== undefined ? { buildId: raw.buildId } : {})
  }
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
