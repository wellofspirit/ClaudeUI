/**
 * Atomic JSON/file writers (P1 fix — WS7).
 *
 * Several shared, externally-mutated JSON files (engine auth stores,
 * ~/.claude.json, sessions.json, .credentials.json, daily-usage snapshots) were
 * rewritten with a plain `writeFileSync`/`writeFile`. A crash or a concurrent
 * writer mid-write can leave a TRUNCATED / half-written file; the next
 * read-modify-write then parses garbage and (worst case) rewrites a file that
 * DROPS every entry it could not read — permanently losing other vendors'
 * credentials (H18).
 *
 * This module provides the single atomic writer the whole codebase routes
 * through: write to a temp file in the SAME directory (rename is only atomic
 * within one filesystem), then `rename` over the target — the reader either
 * sees the old complete file or the new complete file, never a torn one. It
 * mirrors the temp-file + rename + 0600/0700 posture already proven in
 * `auth/vault/AuthVault.ts` and `shared-providers/SharedProviderRepository.ts`
 * (those keep their own inlined copies to avoid churn on the live vault path).
 *
 * `readJsonFileForWrite` is R2's belt: the read half of a read-modify-write
 * must NOT silently degrade a corrupt-but-present file to `{}` (which the
 * following write would then persist, deleting everything). It distinguishes a
 * MISSING file (→ `{}`, a legitimate fresh start) from a PRESENT-but-unreadable
 * one (→ back up once, then THROW so the caller refuses to write and retries
 * later, leaving the on-disk data intact for the engine/user to repair).
 */
import * as fs from 'node:fs'
import * as fsp from 'node:fs/promises'
import * as path from 'node:path'
import { logger } from './logger'

/** Default file mode for the JSON files this module writes — all hold secrets or user config. */
const DEFAULT_MODE = 0o600

export interface WriteFileAtomicOptions {
  /** File mode for the written file (default 0600). chmod is applied on non-win32. */
  mode?: number
  /**
   * If set, the parent directory is created with this mode. Omit to create it
   * with the process default (recursive mkdir is idempotent — an existing
   * directory's mode is never changed). We deliberately never chmod an
   * existing parent directory: parents here include the user's home directory
   * and the engines' own config dirs, which must not be re-permissioned.
   */
  dirMode?: number
  /** fsync the temp file before rename for extra durability (default false — none of the current callers need it). */
  fsync?: boolean
}

export interface WriteJsonAtomicOptions extends WriteFileAtomicOptions {
  /** `JSON.stringify` indent (spaces). Omit for compact output. */
  indent?: number
  /** Append a trailing newline (some callers wrote `JSON.stringify(...) + '\n'`). */
  trailingNewline?: boolean
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

function tempPathFor(filePath: string): string {
  const rand = Math.random().toString(16).slice(2, 10)
  return `${filePath}.${process.pid}.${Date.now()}.${rand}.tmp`
}

function chmodBestEffort(filePath: string, mode: number): void {
  // A successfully-written file must never be failed over a permission tweak.
  // The temp file is already created with `mode` (writeFileSync's create mode),
  // so this chmod is a belt that widens/narrows nothing on the happy path.
  if (process.platform === 'win32') return
  try {
    fs.chmodSync(filePath, mode)
  } catch (err) {
    logger.warn(
      'writeFileAtomic',
      `chmod ${mode.toString(8)} failed for ${filePath}: ${errMsg(err)}`
    )
  }
}

async function chmodBestEffortAsync(filePath: string, mode: number): Promise<void> {
  if (process.platform === 'win32') return
  try {
    await fsp.chmod(filePath, mode)
  } catch (err) {
    logger.warn(
      'writeFileAtomic',
      `chmod ${mode.toString(8)} failed for ${filePath}: ${errMsg(err)}`
    )
  }
}

/**
 * Atomically write `data` to `filePath` (temp-file + rename). Creates the
 * parent directory if needed and applies the file mode (0600 by default) via
 * chmod on non-win32. Throws (after cleaning up the temp file) if the temp
 * write or the rename fails — the original target is left untouched.
 */
export function writeFileAtomicSync(
  filePath: string,
  data: string | Buffer,
  opts: WriteFileAtomicOptions = {}
): void {
  const mode = opts.mode ?? DEFAULT_MODE
  const dir = path.dirname(filePath)
  fs.mkdirSync(dir, {
    recursive: true,
    ...(opts.dirMode !== undefined ? { mode: opts.dirMode } : {})
  })
  const temp = tempPathFor(filePath)
  try {
    fs.writeFileSync(temp, data, { mode })
    chmodBestEffort(temp, mode)
    if (opts.fsync) {
      const fd = fs.openSync(temp, 'r+')
      try {
        fs.fsyncSync(fd)
      } finally {
        fs.closeSync(fd)
      }
    }
    fs.renameSync(temp, filePath)
  } catch (err) {
    try {
      fs.unlinkSync(temp)
    } catch {
      /* best-effort cleanup of the abandoned temp file */
    }
    throw err
  }
  // Post-rename chmod (belt): an existing target that pre-dated us keeps 0600.
  chmodBestEffort(filePath, mode)
}

/** Async counterpart of {@link writeFileAtomicSync} (uses `node:fs/promises`). */
export async function writeFileAtomicAsync(
  filePath: string,
  data: string | Buffer,
  opts: WriteFileAtomicOptions = {}
): Promise<void> {
  const mode = opts.mode ?? DEFAULT_MODE
  const dir = path.dirname(filePath)
  await fsp.mkdir(dir, {
    recursive: true,
    ...(opts.dirMode !== undefined ? { mode: opts.dirMode } : {})
  })
  const temp = tempPathFor(filePath)
  try {
    await fsp.writeFile(temp, data, { mode })
    await chmodBestEffortAsync(temp, mode)
    if (opts.fsync) {
      const handle = await fsp.open(temp, 'r+')
      try {
        await handle.sync()
      } finally {
        await handle.close()
      }
    }
    await fsp.rename(temp, filePath)
  } catch (err) {
    try {
      await fsp.unlink(temp)
    } catch {
      /* best-effort cleanup */
    }
    throw err
  }
  await chmodBestEffortAsync(filePath, mode)
}

function serializeJson(data: unknown, opts: WriteJsonAtomicOptions): string {
  return JSON.stringify(data, null, opts.indent) + (opts.trailingNewline ? '\n' : '')
}

/**
 * Atomically write `data` as JSON. Serialization is caller-controlled
 * (`indent` / `trailingNewline`) so this is a byte-for-byte drop-in for the
 * existing `writeFileSync(path, JSON.stringify(...), ...)` call sites.
 */
export function writeJsonAtomic(
  filePath: string,
  data: unknown,
  opts: WriteJsonAtomicOptions = {}
): void {
  writeFileAtomicSync(filePath, serializeJson(data, opts), opts)
}

/** Async counterpart of {@link writeJsonAtomic}. */
export async function writeJsonAtomicAsync(
  filePath: string,
  data: unknown,
  opts: WriteJsonAtomicOptions = {}
): Promise<void> {
  await writeFileAtomicAsync(filePath, serializeJson(data, opts), opts)
}

/**
 * Preserve the first unreadable snapshot of `filePath` at `<filePath>.corrupt`
 * (never overwriting an existing backup, so the earliest — closest to the last
 * good state — copy survives). Best-effort: never throws.
 */
function backupCorruptFile(filePath: string): void {
  const backup = `${filePath}.corrupt`
  try {
    // COPYFILE_EXCL fails with EEXIST if a backup already exists — keep the first.
    fs.copyFileSync(filePath, backup, fs.constants.COPYFILE_EXCL)
    logger.warn('writeJsonAtomic', `Backed up unreadable ${filePath} → ${backup}`)
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EEXIST') {
      logger.warn('writeJsonAtomic', `Failed to back up unreadable ${filePath}: ${errMsg(err)}`)
    }
  }
}

/**
 * The read half of a read-modify-write that MUST NOT clobber a corrupt file
 * (H18, R2). Returns:
 *   - `{}` when the file is MISSING (ENOENT) — a legitimate fresh start.
 *   - the parsed object when the file is present and a valid JSON object.
 * Throws (after backing the file up once) when the file is present but
 * UNREADABLE (parse error, or a non-object/array top level) — the caller must
 * then refuse to write, so the on-disk data survives for recovery. A non-ENOENT
 * IO error (e.g. EACCES) is rethrown as-is, never degraded to `{}`.
 */
export function readJsonFileForWrite(filePath: string): Record<string, unknown> {
  let raw: string
  try {
    raw = fs.readFileSync(filePath, 'utf-8')
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return {}
    throw err
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (err) {
    backupCorruptFile(filePath)
    throw new Error(
      `Refusing to overwrite unreadable JSON at ${filePath} (backed up to ${filePath}.corrupt): ${errMsg(err)}`
    )
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    backupCorruptFile(filePath)
    throw new Error(
      `Refusing to overwrite non-object JSON at ${filePath} (backed up to ${filePath}.corrupt)`
    )
  }
  return parsed as Record<string, unknown>
}
