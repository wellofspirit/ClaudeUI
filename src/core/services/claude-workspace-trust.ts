/**
 * Workspace trust: `<globalConfig>#projects[K].hasTrustDialogAccepted`.
 *
 * Untrusted, cli.js drops every `allow` rule and `additionalDirectories` entry
 * from the project scope (and from the local scope when `settings.local.json`
 * is tracked by git); deny/ask and user-scope allows still apply. The warning
 * it would print is suppressed in headless mode, so ClaudeUI reads the flag to
 * show it and writes it the way cli.js's own trust dialog does.
 *
 * K is `claudeProjectKey(cwd)` (the canonical git root, else the cwd) — the
 * only key the allow-rule gate reads. cli.js never records trust for the home
 * directory (a saved `projects[<home>]` would make terminal `claude` skip its
 * trust dialog in every non-git folder under home) nor for a filesystem root.
 *
 * Writes go under cli.js's own lock protocol (proper-lockfile: a `mkdir` of
 * `<config>.lock`, stale after 10 s) so a concurrently running cli.js cannot
 * lose the update, nor we its.
 */

import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import type { WorkspaceTrust } from '../../shared/types'
import {
  claudeGlobalConfigPath,
  claudeProjectKey,
  claudeProjectLocation,
  realCwd,
  readClaudeGlobalConfig,
  readClaudeProjectEntry,
  type Env,
  type JsonObject
} from './claude-config-paths'
import { logger } from './logger'
import { readJsonFileForWrite, writeJsonAtomic } from './write-json-atomic'

function realOrSelf(p: string): string {
  try {
    return fs.realpathSync.native(p)
  } catch {
    return path.resolve(p)
  }
}

/** The location trust applies to, or null where it must never be recorded (no cwd, home, a filesystem root). */
function trustLocation(cwd: string): { root: string; worktree: boolean } | null {
  if (!cwd) return null
  const loc = claudeProjectLocation(cwd)
  if (path.dirname(loc.root) === loc.root) return null
  // cli.js compares the CWD with home (not the root): a repo at ~ still gets projects[<home>]
  // for a folder under it, while ~ itself only ever gets session trust.
  if (realCwd(cwd) === realOrSelf(os.homedir()).normalize('NFC')) return null
  return loc
}

/** Never throws; `null` when trust cannot be recorded for this cwd. */
export function getWorkspaceTrust(cwd: string, env: Env = process.env): WorkspaceTrust | null {
  try {
    const loc = trustLocation(cwd)
    if (!loc) return null
    const entry = readClaudeProjectEntry(readClaudeGlobalConfig(env), cwd)
    return {
      root: loc.root,
      worktree: loc.worktree,
      trusted: entry.hasTrustDialogAccepted === true
    }
  } catch {
    return null
  }
}

export interface ConfigLockOptions {
  env?: Env
  /** A lock directory older than this is taken over (once per acquisition). */
  staleMs?: number
  /** Give up after this long. */
  timeoutMs?: number
  /** Jittered wait between attempts. */
  pollMinMs?: number
  pollMaxMs?: number
}

const LOCKED_ERROR = 'the file stayed locked by another Claude Code process'

/**
 * Run `fn` holding the global-config lock, compatible with cli.js's
 * proper-lockfile (`mkdir <config>.lock`; stale after 10 s). Released in
 * `finally`.
 */
export async function withClaudeConfigLock<T>(
  fn: () => T,
  opts: ConfigLockOptions = {}
): Promise<T> {
  const staleMs = opts.staleMs ?? 10_000
  const timeoutMs = opts.timeoutMs ?? 5_000
  const pollMin = opts.pollMinMs ?? 50
  const pollMax = opts.pollMaxMs ?? 150
  const lockDir = `${claudeGlobalConfigPath(opts.env)}.lock`
  fs.mkdirSync(path.dirname(lockDir), { recursive: true })
  const deadline = Date.now() + timeoutMs
  let tookOver = false
  for (;;) {
    try {
      fs.mkdirSync(lockDir)
      break
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err
    }
    let retryNow = false
    try {
      if (Date.now() - fs.statSync(lockDir).mtimeMs > staleMs && !tookOver) {
        tookOver = true
        fs.rmdirSync(lockDir)
        retryNow = true
      }
    } catch (err) {
      // the holder released between our mkdir and stat: retry at once
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') retryNow = true
      else throw err
    }
    if (Date.now() >= deadline) throw new Error(LOCKED_ERROR)
    if (retryNow) continue
    await new Promise((r) => setTimeout(r, pollMin + Math.random() * (pollMax - pollMin)))
  }
  try {
    return fn()
  } finally {
    try {
      fs.rmdirSync(lockDir)
    } catch (err) {
      // best effort: a release failure must not mask fn's result or error
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
        logger.warn('ClaudeTrust', `Failed to release ${lockDir}`, err)
      }
    }
  }
}

/**
 * Trust or untrust the workspace. Touches only `projects[K].hasTrustDialogAccepted`
 * (untrust writes `false` and keeps the entry). Throws where
 * {@link getWorkspaceTrust} returns null, on a corrupt config (left unchanged)
 * and when the lock cannot be taken.
 */
export async function setWorkspaceTrust(
  cwd: string,
  trusted: boolean,
  opts: ConfigLockOptions = {}
): Promise<WorkspaceTrust> {
  // Remote clients reach this unvalidated; never write a non-boolean into cli.js's config.
  if (typeof cwd !== 'string' || typeof trusted !== 'boolean') {
    throw new Error('setWorkspaceTrust needs a cwd string and a boolean')
  }
  const env = opts.env ?? process.env
  if (!trustLocation(cwd)) throw new Error('Trust cannot be recorded for this directory')
  const key = claudeProjectKey(cwd)
  const configPath = claudeGlobalConfigPath(env)
  await withClaudeConfigLock(() => {
    const data = readJsonFileForWrite(configPath)
    const projects: JsonObject =
      data.projects && typeof data.projects === 'object' && !Array.isArray(data.projects)
        ? (data.projects as JsonObject)
        : {}
    const prev = projects[key]
    const entry: JsonObject = prev && typeof prev === 'object' ? (prev as JsonObject) : {}
    if (entry.hasTrustDialogAccepted === trusted) return
    data.projects = { ...projects, [key]: { ...entry, hasTrustDialogAccepted: trusted } }
    writeJsonAtomic(realOrSelf(configPath), data, { indent: 2, trailingNewline: true })
  }, opts)
  const state = getWorkspaceTrust(cwd, env)
  if (!state) throw new Error('Trust cannot be recorded for this directory')
  return state
}
