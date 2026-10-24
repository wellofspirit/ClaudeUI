/**
 * The user's `permissions.additionalDirectories` as a list of directories a session may treat as
 * its workspace: how an entry is spelled, resolved, de-duplicated and, for the ones an ENGINE is
 * told about, checked on disk. A LEAF module (node built-ins and the logger only) so CodexSession,
 * the dispatcher and the dispatch-workdir check can all use it without an import cycle.
 */
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { logger } from './logger'

/** `~` and `~/x` are the user's home; `~name` is not expanded (it is a relative name). */
export function expandHome(p: string): string {
  if (p === '~') return os.homedir()
  return p.startsWith('~/') || p.startsWith('~\\') ? path.join(os.homedir(), p.slice(2)) : p
}

/**
 * `entries` (as written in ONE settings merge) as absolute paths: `~` expanded, a relative entry
 * resolved against `baseCwd`, the directory whose settings carried it. Resolve per source cwd
 * BEFORE any union: an entry in the target's project settings is relative to the target, one in
 * the parent's settings to the parent. Blanks and non-strings are dropped; nothing is touched on
 * disk.
 */
export function resolveAdditionalDirectories(
  entries: readonly (string | null | undefined)[] | undefined,
  baseCwd: string
): string[] {
  const out: string[] = []
  for (const entry of entries ?? []) {
    if (typeof entry !== 'string' || entry.trim() === '') continue
    out.push(path.resolve(baseCwd, expandHome(entry.trim())))
  }
  return out
}

/**
 * `dirs` narrowed to the ones that are an absolute path and an existing directory right now
 * (`statSync`, no realpath). For the directories an ENGINE is sent (Codex `writableRoots`, Claude
 * `--add-dir`): a relative path fails Codex's whole `turn/start` (`AbsolutePathBuf`), and a
 * missing one is dropped by the engine at best. ClaudeUI's own scope checks keep the unfiltered
 * list. A dropped entry is logged at debug. Symlinks are NOT filtered (a symlinked root is a hard
 * error under macOS seatbelt: noted, not handled).
 */
export function existingDirectories(dirs: readonly string[], source: string): string[] {
  return dirs.filter((dir) => {
    let ok = false
    try {
      ok = path.isAbsolute(dir) && fs.statSync(dir).isDirectory()
    } catch {
      /* missing or unreadable: dropped below */
    }
    if (!ok) logger.debug(source, `additional directory not sent to the engine: ${dir}`)
    return ok
  })
}

/** A directory's comparison key: separators and trailing slash folded, case folded on win32. */
function dirKey(dir: string, platform: NodeJS.Platform): string {
  let key = dir.trim()
  if (platform === 'win32') key = key.replaceAll('\\', '/').toLowerCase()
  while (key.length > 1 && key.endsWith('/') && !key.endsWith(':/')) key = key.slice(0, -1)
  return key
}

/**
 * `dirs` without blanks, non-strings, repeats and `except`, in order, first spelling kept. Two
 * spellings of one directory are one on win32 (case, `\` against `/`, a trailing slash); elsewhere
 * only the trailing slash is folded. A path is never resolved or touched on disk.
 */
export function uniqueDirs(
  dirs: readonly (string | null | undefined)[],
  except?: string,
  platform: NodeJS.Platform = process.platform
): string[] {
  const seen = new Set<string>(except ? [dirKey(except, platform)] : [])
  const out: string[] = []
  for (const dir of dirs) {
    if (typeof dir !== 'string' || dir.trim() === '') continue
    const key = dirKey(dir, platform)
    if (seen.has(key)) continue
    seen.add(key)
    out.push(dir)
  }
  return out
}
