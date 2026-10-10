/**
 * The directories system detection searches for harness commands (ADR-082 §3):
 * this process's PATH, plus the PATH a freshly started shell would get.
 *
 * - The process PATH is split on the platform delimiter, quotes are stripped,
 *   and variables the OS left unexpanded (`%NVM_HOME%` on Windows, where a
 *   `REG_EXPAND_SZ` Path referencing other expandable values is not expanded;
 *   `$VAR` / `${VAR}` elsewhere) are expanded from the environment, at most
 *   twice (one level of nesting). An entry still holding a variable, empty, or
 *   not absolute is skipped. Windows de-duplicates case-insensitively.
 * - The fresh PATH: an app started from Explorer keeps its logon-time PATH, so
 *   on Windows the user and machine `Path` values are re-read from the registry
 *   (`reg.exe query`); an app started from the Finder never read the login
 *   shell's profile, so on macOS/Linux `$SHELL -ilc` prints it once.
 *
 * Everything is injectable (`env`, `platform`, `run`) and nothing throws: a
 * failed probe contributes no entries.
 */
import * as path from 'node:path'
import { runCapture, type RunFn } from './run'

export interface PathDeps {
  env?: NodeJS.ProcessEnv
  platform?: NodeJS.Platform
  run?: RunFn
}

const FRESH_TIMEOUT_MS = 5000

/** `env[name]`, case-insensitively on Windows (an injected env is a plain object). */
export function envGet(
  env: NodeJS.ProcessEnv,
  name: string,
  platform: NodeJS.Platform = process.platform
): string | undefined {
  if (platform !== 'win32') return env[name]
  if (env[name] !== undefined) return env[name]
  const upper = name.toUpperCase()
  for (const [key, value] of Object.entries(env)) {
    if (key.toUpperCase() === upper) return value
  }
  return undefined
}

function pathApi(platform: NodeJS.Platform): path.PlatformPath {
  return platform === 'win32' ? path.win32 : path.posix
}

const WIN_VAR = /%([^%;]+)%/g
const POSIX_VAR = /\$(?:\{([A-Za-z_][A-Za-z0-9_]*)\}|([A-Za-z_][A-Za-z0-9_]*))/g

function hasVar(value: string, platform: NodeJS.Platform): boolean {
  return platform === 'win32' ? /%[^%;]+%/.test(value) : value.includes('$')
}

function expandOnce(value: string, env: NodeJS.ProcessEnv, platform: NodeJS.Platform): string {
  if (platform === 'win32') {
    return value.replace(WIN_VAR, (whole, name: string) => envGet(env, name, platform) ?? whole)
  }
  return value.replace(
    POSIX_VAR,
    (whole, braced: string | undefined, bare: string | undefined) =>
      envGet(env, braced ?? bare ?? '', platform) ?? whole
  )
}

/**
 * One PATH entry, expanded and normalised; null when it must be skipped
 * (empty, still holding a variable after two expansions, or relative: a
 * relative entry would resolve against whatever the cwd happens to be).
 */
export function expandPathEntry(
  raw: string,
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform = process.platform
): string | null {
  let value = raw.replace(/"/g, '').trim()
  for (let pass = 0; pass < 2 && hasVar(value, platform); pass++) {
    value = expandOnce(value, env, platform).replace(/"/g, '').trim()
  }
  if (!value || hasVar(value, platform)) return null
  if (platform !== 'win32' && (value === '~' || value.startsWith('~/'))) {
    const home = envGet(env, 'HOME', platform)
    if (!home) return null
    value = home + value.slice(1)
  }
  const api = pathApi(platform)
  if (!api.isAbsolute(value)) return null
  const normalized = api.normalize(value)
  const root = api.parse(normalized).root
  return normalized.length > root.length ? normalized.replace(/[\\/]+$/, '') : normalized
}

function dedupeKey(entry: string, platform: NodeJS.Platform): string {
  return platform === 'win32' ? entry.toLowerCase() : entry
}

/** Merge entry lists in order, keeping the first of each directory. */
export function mergeEntries(lists: readonly string[][], platform: NodeJS.Platform): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const list of lists) {
    for (const entry of list) {
      const key = dedupeKey(entry, platform)
      if (seen.has(key)) continue
      seen.add(key)
      out.push(entry)
    }
  }
  return out
}

/** A PATH-style list split, expanded and de-duplicated. */
export function splitPathList(
  value: string | undefined,
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform = process.platform
): string[] {
  if (!value) return []
  const delimiter = platform === 'win32' ? ';' : ':'
  const entries: string[] = []
  for (const raw of value.split(delimiter)) {
    const entry = expandPathEntry(raw, env, platform)
    if (entry) entries.push(entry)
  }
  return mergeEntries([entries], platform)
}

/** This process's PATH, split and expanded. */
export function currentPathEntries(deps: PathDeps = {}): string[] {
  const env = deps.env ?? process.env
  const platform = deps.platform ?? process.platform
  return splitPathList(envGet(env, 'PATH', platform), env, platform)
}

const REG_PATH_KEYS = [
  'HKLM\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment',
  'HKCU\\Environment'
]

/** The `Path` value in `reg.exe query <key> /v Path` output, or null. */
export function parseRegQueryPath(stdout: string): string | null {
  const match = /^\s*Path\s+REG_(?:EXPAND_)?SZ\s+(.*?)\s*$/im.exec(stdout)
  return match ? match[1] : null
}

const SHELL_MARK = '__CLAUDEUI_PATH__'

/** The PATH between the two markers (rc files may print banners around it), or null. */
export function parseShellPath(stdout: string): string | null {
  const end = stdout.lastIndexOf(SHELL_MARK)
  if (end < SHELL_MARK.length) return null
  const start = stdout.lastIndexOf(SHELL_MARK, end - SHELL_MARK.length)
  if (start < 0) return null
  return stdout.slice(start + SHELL_MARK.length, end)
}

/** The login shell's argv that prints its PATH between markers. */
export function loginShellArgs(shell: string): string[] {
  const name = path.posix.basename(shell.replace(/\\/g, '/'))
  const print =
    name === 'fish'
      ? `printf '${SHELL_MARK}%s${SHELL_MARK}' (string join : $PATH)`
      : `printf '${SHELL_MARK}%s${SHELL_MARK}' "$PATH"`
  return ['-ilc', print]
}

/**
 * The PATH a newly started program would get: the registry's machine + user
 * `Path` on Windows, the login shell's elsewhere. Never rejects.
 */
export async function freshPathEntries(deps: PathDeps = {}): Promise<string[]> {
  const env = deps.env ?? process.env
  const platform = deps.platform ?? process.platform
  const run = deps.run ?? runCapture
  try {
    if (platform === 'win32') {
      const root = envGet(env, 'SystemRoot', platform)
      const reg = root ? path.win32.join(root, 'System32', 'reg.exe') : 'reg.exe'
      const results = await Promise.all(
        REG_PATH_KEYS.map((key) =>
          run(reg, ['query', key, '/v', 'Path'], { timeoutMs: FRESH_TIMEOUT_MS })
        )
      )
      const lists = results.map((result) =>
        result.code === 0
          ? splitPathList(parseRegQueryPath(result.stdout) ?? '', env, platform)
          : []
      )
      return mergeEntries(lists, platform)
    }
    const shell = envGet(env, 'SHELL', platform)
    if (!shell || !path.posix.isAbsolute(shell)) return []
    const result = await run(shell, loginShellArgs(shell), { timeoutMs: FRESH_TIMEOUT_MS, env })
    if (result.code !== 0) return []
    return splitPathList(parseShellPath(result.stdout) ?? '', env, platform)
  } catch {
    return []
  }
}

/** The process PATH, then fresh-PATH directories it lacks. Never rejects. */
export async function searchPathEntries(deps: PathDeps = {}): Promise<string[]> {
  const platform = deps.platform ?? process.platform
  const fresh = await freshPathEntries(deps)
  return mergeEntries([currentPathEntries(deps), fresh], platform)
}
