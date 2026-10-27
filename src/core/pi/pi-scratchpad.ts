/**
 * pi's per-session scratchpad (the temp-dir half of path containment, ADR-110).
 *
 * Claude Code has no whole-OS-temp root. It gives each session ONE directory under the OS temp
 * dir, readable and writable in every mode, and reads the project's temp dir
 * (`<tmp>/claude/<project-key>/`). pi gets the same under `<tmp>/claudeui`, suffixed with the
 * uid on POSIX (`claudeui-<uid>`, see {@link scratchBaseName}):
 *
 *   <realpath(os.tmpdir()/claudeui-<uid>)>/<project-key>/<session-key>/scratchpad
 *
 * The OS temp dir is shared and world-writable, so another local user could pre-plant a link
 * there to make a session write elsewhere, or read its files. Claude Code defends by creating the
 * root 0700, checking ownership and refusing anything that is not a real directory; this does the
 * same. Every level is `lstat`ed: it must be a directory, not a symlink/junction, and on POSIX
 * owned by the current uid with no group/other access. Any failure means the session has NO
 * scratchpad (a warning, never a throw): containment still works without one.
 *
 * The path is built on the REALPATH of the base, because the containment rung compares the
 * scratchpad AS SPELLED (never realpath-expanded) against the targets' own real paths.
 */
import { createHash } from 'node:crypto'
import {
  lstatSync,
  mkdirSync,
  readdirSync,
  realpathSync,
  rmdirSync,
  unlinkSync,
  type Stats
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { logger } from '../services/logger'

const LOG = 'PiScratchpad'

/** Name of the directory under the OS temp dir that holds every project's scratch space (Windows: the whole name). */
const BASE_NAME = 'claudeui'
/** The directory a session's scratch files live in, under its session dir. */
const SCRATCH_NAME = 'scratchpad'
/** Claude Code's cap on a project key (`q0`): longer keys get a short stable hash instead. */
const PROJECT_KEY_MAX = 200

/** The part of `Stats` the checks read. */
export type ScratchStat = Pick<Stats, 'isDirectory' | 'isSymbolicLink' | 'uid' | 'mode'>

/** The filesystem questions and writes the scratchpad needs; tests inject a faulty one. */
export interface ScratchpadFs {
  mkdir(p: string, mode: number): void
  lstat(p: string): ScratchStat
  /** The OS's canonical spelling (`realpath.native`: it also expands Windows 8.3 names). */
  realpath(p: string): string
  readdir(p: string): string[]
  unlink(p: string): void
  rmdir(p: string): void
}

/** The default is a thunk per call: a test that mocks `node:fs` only fails the call, never the import. */
export const hostScratchpadFs: ScratchpadFs = {
  mkdir: (p, mode) => {
    mkdirSync(p, { mode })
  },
  lstat: (p) => lstatSync(p),
  realpath: (p) => realpathSync.native(p),
  readdir: (p) => readdirSync(p),
  unlink: (p) => unlinkSync(p),
  rmdir: (p) => rmdirSync(p)
}

export interface ScratchpadEnv {
  tmpdir: () => string
  fs: ScratchpadFs
  /** `process.getuid()`; undefined on Windows (no owner check there). */
  uid: number | undefined
  warn: (message: string) => void
}

function hostEnv(): ScratchpadEnv {
  return {
    tmpdir: () => tmpdir(),
    fs: hostScratchpadFs,
    uid: typeof process.getuid === 'function' ? process.getuid() : undefined,
    warn: (message) => logger.warn(LOG, message)
  }
}

function resolveEnv(env: Partial<ScratchpadEnv> | undefined): ScratchpadEnv {
  return { ...hostEnv(), ...env }
}

/**
 * The base directory's name. On POSIX the shared temp dir is world-writable and one user's
 * `claudeui` would lock every other local user out (their ownership check refuses it): the name
 * carries the uid, as Claude Code's does (`claude-<uid>`). Windows temp dirs are per user already.
 */
export function scratchBaseName(uid: number | undefined): string {
  return uid === undefined ? BASE_NAME : `${BASE_NAME}-${uid}`
}

/** A session in the scratchpad's eyes: the directory pair its prompt and path scope are built from. */
export interface PiScratchpad {
  /** `<base>/<project-key>/<session-key>/scratchpad`, on the realpath of the base. */
  dir: string
  /** `<base>/<project-key>`: the project's temp dir, a read root. */
  projectTemp: string
}

/** Claude Code's project key (`q0`): non-alphanumerics become `-`; past 200 chars, cut and add a stable hash. */
export function scratchpadProjectKey(cwd: string): string {
  const key = cwd.replace(/[^a-zA-Z0-9]/g, '-')
  if (key.length <= PROJECT_KEY_MAX) return key
  const hash = createHash('sha256').update(cwd).digest('hex').slice(0, 10)
  return `${key.slice(0, PROJECT_KEY_MAX)}-${hash}`
}

/**
 * A session key is one path segment under the project dir: pi's own session-id shape (letters,
 * digits, `.` `_` `-`, alphanumeric at both ends), so it can never be `..` or hold a separator.
 */
const SESSION_KEY = /^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,126}[A-Za-z0-9])?$/

export function isScratchpadSessionKey(key: string): boolean {
  return SESSION_KEY.test(key)
}

/** The key of a dispatch target's scratchpad: its ledger row id (stable across resume), kept apart from session ids. */
export function dispatchScratchpadKey(ledgerId: string): string {
  return `dispatch-${ledgerId}`
}

/** The paragraph the model is given (one `--append-system-prompt`, or a line of a child's prompt file). */
export function scratchpadPrompt(dir: string): string {
  return (
    `Scratchpad directory: ${dir}. Use it for temporary files (intermediate results, scripts, ` +
    `outputs that don't belong in the project) instead of /tmp or other system temp directories; ` +
    `it is session-specific and can be used without permission prompts. Always write its ` +
    `complete absolute path when you mention a file in it.`
  )
}

/** The flag pair a spawn adds for a scratchpad; empty when the session has none. */
export function scratchpadPromptArgs(dir: string | undefined): string[] {
  return dir ? ['--append-system-prompt', scratchpadPrompt(dir)] : []
}

function errnoCode(err: unknown): string | undefined {
  return (err as NodeJS.ErrnoException | undefined)?.code
}

/** Refuse anything but a real directory this user alone controls. Throws the reason. */
function assertOwnDirectory(env: ScratchpadEnv, p: string): void {
  const st = env.fs.lstat(p)
  if (st.isSymbolicLink()) throw new Error(`${p} is a link`)
  if (!st.isDirectory()) throw new Error(`${p} is not a directory`)
  if (env.uid !== undefined) {
    if (st.uid !== env.uid) throw new Error(`${p} is owned by uid ${st.uid}, expected ${env.uid}`)
    if ((st.mode & 0o077) !== 0)
      throw new Error(`${p} is accessible to others (mode ${(st.mode & 0o777).toString(8)})`)
  }
}

/** Create one level 0700 (an existing one is fine) and then check it is what we expect. */
function ensureLevel(env: ScratchpadEnv, p: string): void {
  try {
    env.fs.mkdir(p, 0o700)
  } catch (err) {
    // An existing entry is checked below, whatever it is (a planted file or link included).
    if (errnoCode(err) !== 'EEXIST') throw err
  }
  assertOwnDirectory(env, p)
}

/**
 * Create (or find again) the scratchpad of a session in `cwd`. `sessionKey` must be STABLE for the
 * session across resume and restart: the same key finds the same directory, and deleting the
 * session deletes it by that key. Returns `undefined`, with a warning, when anything on the way is
 * not what a scratchpad needs; never throws.
 */
export function ensurePiScratchpad(
  cwd: string,
  sessionKey: string,
  envOverride?: Partial<ScratchpadEnv>
): PiScratchpad | undefined {
  let env: ScratchpadEnv | undefined
  try {
    env = resolveEnv(envOverride)
    if (!isScratchpadSessionKey(sessionKey))
      throw new Error(`not a usable session key: ${sessionKey}`)
    const base = join(env.tmpdir(), scratchBaseName(env.uid))
    ensureLevel(env, base)
    // The base is a real directory now (not a link): its realpath only canonicalises the temp
    // dir's own spelling (symlinked /var on macOS, 8.3 names on Windows).
    const root = env.fs.realpath(base)
    const projectTemp = join(root, scratchpadProjectKey(cwd))
    ensureLevel(env, projectTemp)
    const sessionDir = join(projectTemp, sessionKey)
    ensureLevel(env, sessionDir)
    const dir = join(sessionDir, SCRATCH_NAME)
    ensureLevel(env, dir)
    return { dir, projectTemp }
  } catch (err) {
    const message = `no scratchpad for this session: ${err instanceof Error ? err.message : String(err)}`
    try {
      if (env) env.warn(message)
      else logger.warn(LOG, message)
    } catch {
      // A logger that fails must not fail the session.
    }
    return undefined
  }
}

/** Remove a tree without ever following a link: a link (or junction) is unlinked itself, never entered. */
function removeTree(fs: ScratchpadFs, p: string): void {
  const st = fs.lstat(p)
  if (st.isSymbolicLink() || !st.isDirectory()) {
    try {
      fs.unlink(p)
    } catch (err) {
      // Windows: a directory link/junction can answer to rmdir rather than unlink.
      if (!st.isSymbolicLink()) throw err
      fs.rmdir(p)
    }
    return
  }
  for (const name of fs.readdir(p)) removeTree(fs, join(p, name))
  fs.rmdir(p)
}

/**
 * Delete a session's scratchpad (and the session dir around it) wherever its project dir is: the
 * caller knows the session key, not the cwd, so every project dir is asked. Called when the
 * session itself is deleted, never on disconnect, stop or app quit. Best effort and link-safe: the
 * base and each project dir must be real directories before they are entered, and a session dir
 * that is anything but one is left alone with a warning (not ours). Never throws.
 */
export function removePiScratchpad(sessionKey: string, envOverride?: Partial<ScratchpadEnv>): void {
  try {
    const env = resolveEnv(envOverride)
    if (!isScratchpadSessionKey(sessionKey)) return
    const base = join(env.tmpdir(), scratchBaseName(env.uid))
    try {
      assertOwnDirectory(env, base)
    } catch (err) {
      // Nothing was ever created, or the base is not ours to walk.
      if (errnoCode(err) !== 'ENOENT') env.warn(`scratchpad not removed: ${String(err)}`)
      return
    }
    const root = env.fs.realpath(base)
    for (const project of env.fs.readdir(root)) {
      const projectDir = join(root, project)
      const sessionDir = join(projectDir, sessionKey)
      try {
        assertOwnDirectory(env, projectDir)
        try {
          env.fs.lstat(sessionDir)
        } catch (err) {
          if (errnoCode(err) === 'ENOENT') continue
          throw err
        }
        assertOwnDirectory(env, sessionDir)
        removeTree(env.fs, sessionDir)
        try {
          env.fs.rmdir(projectDir) // pruned when it was the last session (fails while others remain)
        } catch {
          // not empty: other sessions' scratch space
        }
      } catch (err) {
        env.warn(
          `scratchpad of ${sessionKey} not removed from ${projectDir}: ${err instanceof Error ? err.message : String(err)}`
        )
      }
    }
  } catch (err) {
    try {
      logger.warn(
        LOG,
        `removing the scratchpad of ${sessionKey} failed: ${err instanceof Error ? err.message : String(err)}`
      )
    } catch {
      // see ensurePiScratchpad
    }
  }
}
