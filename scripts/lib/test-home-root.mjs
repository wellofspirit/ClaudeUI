// The throwaway-home root of the vitest run (vitest.config.ts): `<tmpdir>/claudeui-test-home`. It
// lives here, not in the config, so a unit test can drive the prune against a temp directory.
//
// Why the root is checked before anything is deleted below it: on a machine whose temp directory is
// shared (Linux /tmp), another local user can pre-create the root as a link to a directory of the
// victim's. The prune would then follow it and remove every old directory it holds.

import { lstatSync, mkdirSync, readdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'

/**
 * True when `root` is a real directory (not a symlink or a Windows junction) and, on POSIX, owned
 * by `uid`. `lstat` does not follow the final component, which is the whole point.
 * @param {string} root
 * @param {number | undefined} [uid] the expected owner; defaults to this process's (POSIX only)
 */
export function isOwnRealDirectory(root, uid = process.getuid?.()) {
  try {
    const info = lstatSync(root)
    if (info.isSymbolicLink() || !info.isDirectory()) return false
    return uid === undefined || info.uid === uid
  } catch {
    return false
  }
}

/** Create the root, readable by this user only. */
export function createTestHomeRoot(/** @type {string} */ root) {
  mkdirSync(root, { recursive: true, mode: 0o700 })
}

/**
 * Remove the run directories directly under `root` whose mtime is older than `cutoffMs`. Never
 * touches anything when the root itself is a link or someone else's; a link inside it is never
 * followed. Best effort: a directory another process holds open, or any other error, is left for
 * next time.
 * @param {string} root
 * @param {number} cutoffMs
 * @param {number | undefined} [uid] see isOwnRealDirectory
 */
export function pruneTestHomes(root, cutoffMs, uid = process.getuid?.()) {
  if (!isOwnRealDirectory(root, uid)) return
  try {
    for (const name of readdirSync(root)) {
      try {
        const dir = join(root, name)
        const info = lstatSync(dir)
        if (info.isDirectory() && info.mtimeMs < cutoffMs) {
          rmSync(dir, { recursive: true, force: true })
        }
      } catch {
        /* best effort */
      }
    }
  } catch {
    /* best effort */
  }
}
