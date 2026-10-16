/**
 * Replace files under `vendor/claude-cli` without ever failing on a binary
 * that a running process holds open.
 *
 * Windows locks the image of a running executable: overwriting it fails with
 * EBUSY and removing its directory with EPERM, but RENAMING it (within the
 * volume) works and the process keeps running. A `bun-claude.exe` is held for
 * as long as any ClaudeUI session or dev build uses it, which used to break
 * `ensure-cli` halfway (extract-cli wiped cli.js/version.json first, then
 * died on the exe, leaving a half-wiped vendor dir). So a locked entry is
 * renamed into a trash dir next to the vendor dir instead, and swept by a
 * later run once the process has exited.
 *
 * POSIX unlinks a running binary happily; the same helpers then behave like
 * plain rm / write+rename.
 */
import {
  existsSync,
  mkdirSync,
  readdirSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeFileSync
} from 'node:fs'
import { basename, dirname, extname, join, resolve } from 'node:path'

// The trash dir is the caller's: `cliTrashDir()` in ./cli-paths.mjs for the
// Claude Code vendor dir. It must be on the same volume as what it receives
// (rename needs that).

/** Errors that mean "a running process holds this" rather than "this is broken". */
const LOCKED = new Set(['EPERM', 'EBUSY', 'EACCES'])

function lockedError(path, cause) {
  return new Error(
    `cannot replace ${path} (${cause.code ?? cause.message}): close the app / sessions using it and retry`,
    { cause }
  )
}

/**
 * Delete `path` (file or directory); if it is locked, rename it into
 * `trashDir/<basename>-<ms>-<pid>` instead. Anything else, or a rename that
 * fails too, throws naming the path.
 */
export function removeOrMoveAside(path, trashDir) {
  try {
    rmSync(path, { recursive: true, force: true })
    return
  } catch (err) {
    if (!LOCKED.has(err.code)) throw lockedError(path, err)
  }
  try {
    mkdirSync(trashDir, { recursive: true })
    renameSync(path, join(trashDir, `${basename(path)}-${Date.now()}-${process.pid}`))
  } catch (err) {
    throw lockedError(path, err)
  }
}

/**
 * Empty `dir` (not remove it), moving locked entries aside. `rmSync` of a
 * directory stops at its first locked child, so each top-level entry is
 * handled on its own — one held exe does not strand the others.
 */
export function clearDir(dir, trashDir) {
  if (existsSync(dir)) {
    for (const entry of readdirSync(dir)) {
      // A trash dir inside `dir` (an overridden vendor dir) is not content.
      if (resolve(dir, entry) === resolve(trashDir)) continue
      removeOrMoveAside(join(dir, entry), trashDir)
    }
  }
  mkdirSync(dir, { recursive: true })
}

/**
 * Write `bytes` to `target` so that `target` is never half-written and an
 * existing (possibly running) `target` is moved aside, not overwritten.
 *
 * Writes `.<name>.tmp-<pid>` next to the target (leading dot: never matches
 * electron-builder's `bun-claude*` filter, so a crash leaves nothing shippable),
 * moves the old target away, then renames the temp into place. The rename gives
 * the target a NEW inode on POSIX, which also avoids macOS's code-signature
 * cache killing a binary that was rewritten in place.
 */
export function replaceFile(target, bytes, trashDir) {
  const tmp = join(dirname(target), `.${basename(target, extname(target))}.tmp-${process.pid}`)
  try {
    writeFileSync(tmp, bytes)
    if (existsSync(target)) removeOrMoveAside(target, trashDir)
    renameSync(tmp, target)
  } catch (err) {
    try {
      unlinkSync(tmp)
    } catch {
      /* never written, or already renamed */
    }
    throw err
  }
}

/** Best-effort delete of every trash entry; returns how many are still held. */
export function sweepTrash(trashDir) {
  if (!existsSync(trashDir)) return 0
  let held = 0
  for (const entry of readdirSync(trashDir)) {
    try {
      rmSync(join(trashDir, entry), { recursive: true, force: true })
    } catch {
      held++
    }
  }
  return held
}
