/**
 * ensureOpencodePlugin — install the ClaudeUI hosted-tools plugin into opencode's
 * global auto-load dir (~/.config/opencode/plugin/) so opencode loads our
 * render_mermaid / create_mockup / show_mockup tools (Phase 5c — Part B).
 *
 * Design:
 *   - Namespaced filename (claudeui.plugin.js) — never touches the user's own plugins.
 *   - Version-stamped + idempotent — only overwrites when the bundled version differs
 *     (compared against a sidecar .claudeui.plugin.version file).
 *   - Lazy + memoized — called once at the start of OpencodeServerManager.acquire(),
 *     so we only touch ~/.config/opencode when opencode is actually used.
 *   - Source located via app.getAppPath() (dev) / process.resourcesPath (packaged),
 *     mirroring OpencodeServerManager.locateBinary().
 *
 * The plugin file itself runs in opencode's Bun process; see plugin/claudeui.plugin.js.
 */

import { existsSync, readFileSync } from 'node:fs'
import { mkdir, copyFile, writeFile, readFile } from 'node:fs/promises'
import { join, dirname } from 'node:path'
import { homedir } from 'node:os'
import { app } from 'electron'
import { logger } from '../services/logger'

const PLUGIN_FILENAME = 'claudeui.plugin.js'
/** Sidecar that records the installed plugin version for idempotent re-stamping. */
const VERSION_FILENAME = '.claudeui.plugin.version'

/** Memoization: resolve once per process (after a successful install). */
let installPromise: Promise<void> | null = null

/**
 * Locate the bundled plugin source. Mirrors OpencodeServerManager.locateBinary():
 * resolve via app.getAppPath() (project root in dev/built Electron; app.asar in
 * packaged), with a process.cwd() fallback outside Electron (tests/scripts).
 */
export function locatePluginSource(): string {
  const appPath = app?.getAppPath ? app.getAppPath() : process.cwd()

  if (!appPath.includes('app.asar')) {
    // Dev/built — appPath is the project root; the source lives under src/.
    return join(appPath, 'src', 'main', 'opencode', 'plugin', PLUGIN_FILENAME)
  }

  // Production — extraResources copies the plugin dir → <Resources>/opencode-plugin.
  // dirname(appPath) is the Resources directory (where app.asar lives).
  const candidates = [
    join(dirname(appPath), 'opencode-plugin', PLUGIN_FILENAME),
    join(appPath.replace('app.asar', 'app.asar.unpacked'), 'src', 'main', 'opencode', 'plugin', PLUGIN_FILENAME)
  ]
  for (const c of candidates) {
    if (existsSync(c)) return c
  }
  return candidates[0]
}

/** The opencode global plugin auto-load dir (~/.config/opencode/plugin/). */
export function opencodePluginDir(): string {
  return join(homedir(), '.config', 'opencode', 'plugin')
}

/**
 * Read CLAUDEUI_PLUGIN_VERSION from the bundled plugin source without importing
 * it (the source imports @opencode-ai/plugin, which isn't resolvable here). A
 * tiny regex over the file text suffices and avoids loading the module.
 */
function readBundledVersion(sourcePath: string): string | null {
  try {
    const text = readFileSync(sourcePath, 'utf-8')
    const m = /CLAUDEUI_PLUGIN_VERSION\s*=\s*['"]([^'"]+)['"]/.exec(text)
    return m ? m[1] : null
  } catch {
    return null
  }
}

/**
 * Install (or re-stamp) the plugin. Idempotent: only copies when the installed
 * version sidecar differs from the bundled version (or the plugin is missing).
 * Memoized per process — concurrent acquire() calls await a single install.
 *
 * Never throws — opencode is optional; a failed install just means our tools
 * won't be available (logged at warn).
 */
export function ensureOpencodePlugin(): Promise<void> {
  if (installPromise) return installPromise
  installPromise = doInstall().catch((err) => {
    logger.warn(
      'opencode',
      `Plugin install failed (hosted tools unavailable): ${err instanceof Error ? err.message : String(err)}`
    )
    // Reset so a later acquire can retry (e.g. transient FS error).
    installPromise = null
  })
  return installPromise
}

async function doInstall(): Promise<void> {
  const sourcePath = locatePluginSource()
  if (!existsSync(sourcePath)) {
    logger.warn('opencode', `Plugin source not found at ${sourcePath}; skipping install`)
    return
  }

  const bundledVersion = readBundledVersion(sourcePath)
  const destDir = opencodePluginDir()
  const destPath = join(destDir, PLUGIN_FILENAME)
  const versionPath = join(destDir, VERSION_FILENAME)

  // Idempotency: skip if the installed plugin exists and the version matches.
  if (bundledVersion && existsSync(destPath) && existsSync(versionPath)) {
    try {
      const installed = (await readFile(versionPath, 'utf-8')).trim()
      if (installed === bundledVersion) {
        logger.debug('opencode', `Plugin up to date (v${bundledVersion})`)
        return
      }
    } catch {
      // fall through to re-install
    }
  }

  await mkdir(destDir, { recursive: true })
  await copyFile(sourcePath, destPath)
  if (bundledVersion) {
    await writeFile(versionPath, bundledVersion + '\n', 'utf-8')
  }
  logger.info(
    'opencode',
    `Installed hosted-tools plugin → ${destPath}${bundledVersion ? ` (v${bundledVersion})` : ''}`
  )
}

/** For tests: reset the memoized install promise. */
export function _resetEnsureOpencodePluginForTests(): void {
  installPromise = null
}
