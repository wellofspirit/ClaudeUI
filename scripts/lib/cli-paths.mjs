/**
 * Where the patched Claude Code build lives, in one place.
 *
 * The extractor, every patch, the structure check, the rebundler and the boot
 * probe all work on `vendor/claude-cli`. `CLAUDEUI_CLI_VENDOR_DIR` (an
 * ABSOLUTE path) points them at another directory instead, so a build can be
 * done somewhere disposable without touching the real vendor dir — that is how
 * `scripts/check-patches-cross-platform.mjs` patches the win32, darwin and
 * linux bundles side by side. Without the variable nothing changes.
 *
 * Read at call time, not import time, so a test (or a parent script) can set
 * it per child process.
 */
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
const DEFAULT_VENDOR_DIR = join(ROOT, 'vendor', 'claude-cli')

/** Platform keys of the official release manifest, as `extract-cli --platform` takes them. */
export const CLI_PLATFORM_KEYS = Object.freeze([
  'win32-x64',
  'win32-arm64',
  'darwin-arm64',
  'darwin-x64',
  'linux-x64',
  'linux-arm64'
])

/** The upstream binary's file name for a platform key. */
export const cliSourceBinName = (key) => (key.startsWith('win32-') ? 'claude.exe' : 'claude')

/** The directory holding cli.js, version.json and the rebundled binary. */
export function cliVendorDir() {
  const override = process.env.CLAUDEUI_CLI_VENDOR_DIR
  if (!override) return DEFAULT_VENDOR_DIR
  if (!isAbsolute(override)) {
    throw new Error('CLAUDEUI_CLI_VENDOR_DIR must be an absolute path')
  }
  return resolve(override)
}

export const cliJsPath = () => join(cliVendorDir(), 'cli.js')
export const versionJsonPath = () => join(cliVendorDir(), 'version.json')

/**
 * Where a locked binary is moved aside. The default is a SIBLING of the vendor
 * dir (same volume, and outside electron-builder's `from: vendor/claude-cli`
 * copy). An overridden dir is disposable and has no sibling to spare, so its
 * trash is inside it.
 */
export function cliTrashDir() {
  return process.env.CLAUDEUI_CLI_VENDOR_DIR
    ? join(cliVendorDir(), '.trash')
    : join(ROOT, 'vendor', '.claude-cli-trash')
}
