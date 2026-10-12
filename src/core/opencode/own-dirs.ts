/**
 * opencode's OWN directories as `external_directory` allows (ADR-097 §3,
 * 2026-10-10 amendment).
 *
 * opencode 2.0.24 gave every agent `{external_directory,*,ask}` plus allows for
 * the directories it writes to itself; 2.0.25 (#53585, `36a38058fb`) removed
 * both — an agent now allows everything outside the workspace. ClaudeUI states
 * the ask itself (`permission-v2.ts` `externalDirectoryGates`) and so has to
 * state the allows too, or every read of a shell/tool-output file, the
 * model-facing tmp dir or the config dir would ask. This module derives them
 * for the SAME environment the server was spawned with:
 *
 * - data   `(XDG_DATA_HOME || ~/.local/share)/opencode`        (`util/src/global-roots.ts`)
 *          → `shell/<projectID>/<file>` (`core/src/shell.ts`), `tool-output/<file>` (`core/src/tool-output.ts`)
 * - config `OPENCODE_CONFIG_DIR ?? (XDG_CONFIG_HOME || ~/.config)/opencode`   (`util/src/global.ts`)
 * - tmp    `os.tmpdir()/opencode`, CANONICALISED by the server (`realpath`)
 *          for the path it tells the model (`instructions/builtins.ts`), while
 *          `GET /api/info` `paths.tmp` is the raw one. Both are allowed.
 * - plan   `<home>/.opencode/plan` (`core/src/plugin/plan.ts`; home is
 *          `OPENCODE_TEST_HOME ?? os.homedir()`, `util/src/global.ts`) — the plan
 *          agent's own directory, which 2.0.24 allowed for it (owner, 2026-10-12:
 *          keep allowing it).
 *
 * The resources are forward-slashed: 2.x asks with slashed absolute resources
 * and its matcher folds `\` and (on Windows) case on both sides.
 */
import { realpathSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { V2Rule } from './permission-v2'

const APP = 'opencode'

/** opencode's global directories, as the server derives them (an unresolvable one is absent). */
export interface OpencodeGlobalDirs {
  readonly data?: string
  readonly config?: string
  /** `os.tmpdir()/opencode` — the raw (not canonicalised) one. */
  readonly tmp?: string
  /** `<home>/.opencode/plan`, the plan agent's directory. */
  readonly plan?: string
}

export interface OpencodeDirInputs {
  /** The env the server was spawned with. */
  readonly env: NodeJS.ProcessEnv
  /** `os.homedir()` of the server's process. */
  readonly home: string
  /** `os.tmpdir()` of the server's process. */
  readonly tmpdir: string
  readonly platform?: NodeJS.Platform
}

const slash = (value: string): string => value.replaceAll('\\', '/')

/** Mirrors `util/src/global-roots.ts` + `global.ts` (config's `OPENCODE_CONFIG_DIR` override). */
export function opencodeGlobalDirs(input: OpencodeDirInputs): OpencodeGlobalDirs {
  const p = (input.platform ?? process.platform) === 'win32' ? path.win32 : path.posix
  const xdg = (name: string, ...fallback: string[]): string | undefined =>
    input.env[name] || (input.home ? p.join(input.home, ...fallback) : undefined)
  const data = xdg('XDG_DATA_HOME', '.local', 'share')
  const xdgConfig = xdg('XDG_CONFIG_HOME', '.config')
  const config = input.env.OPENCODE_CONFIG_DIR ?? (xdgConfig ? p.join(xdgConfig, APP) : undefined)
  const home = input.env.OPENCODE_TEST_HOME ?? input.home
  return {
    ...(data ? { data: p.join(data, APP) } : {}),
    ...(config ? { config } : {}),
    ...(input.tmpdir ? { tmp: p.join(input.tmpdir, APP) } : {}),
    ...(home ? { plan: p.join(home, '.opencode', 'plan') } : {})
  }
}

/**
 * The allows for opencode's own directories: data `shell/<project>/<file>` and
 * `tool-output/<file>`, tmp, config and the plan directory (`<dir>/*`). `tmp`
 * takes every spelling of the tmp dir (raw and canonical). Pure and deterministic.
 */
export function opencodeOwnDirAllows(
  dirs: {
    readonly data?: string
    readonly config?: string
    readonly tmp?: readonly string[]
    readonly plan?: string
  },
  platform: NodeJS.Platform = process.platform
): V2Rule[] {
  const fold = (value: string) => (platform === 'win32' ? value.toLowerCase() : value)
  const seen = new Set<string>()
  const out: V2Rule[] = []
  const allow = (dir: string, ...tail: string[]) => {
    const resource = [slash(dir).replace(/\/+$/, ''), ...tail].join('/')
    if (seen.has(fold(resource))) return
    seen.add(fold(resource))
    out.push({ action: 'external_directory', resource, effect: 'allow' })
  }
  if (dirs.data) {
    allow(dirs.data, 'shell', '*', '*')
    allow(dirs.data, 'tool-output', '*')
  }
  for (const tmp of dirs.tmp ?? []) if (tmp) allow(tmp, '*')
  if (dirs.config) allow(dirs.config, '*')
  if (dirs.plan) allow(dirs.plan, '*')
  return out
}

/** What {@link resolveOpencodeOwnDirAllows} needs — injectable for tests. */
export interface OwnDirDeps {
  readonly env?: NodeJS.ProcessEnv
  readonly homedir?: string
  readonly tmpdir?: string
  readonly platform?: NodeJS.Platform
  /** Canonicalises the tmp dir (default `fs.realpathSync`); a throw = keep the raw spelling only. */
  readonly realpath?: (dir: string) => string
  readonly onError?: (message: string) => void
}

/** The slice of the client this needs (`OpencodeClient.call`). */
export interface OwnDirClient {
  call(operation: 'server.info', init: Record<string, never>): Promise<unknown>
}

/**
 * The own-dir allows for a running server: tmp from `GET /api/info`
 * (`paths.tmp`, what the server itself uses) when it answers, else derived;
 * data and config derived from the spawn env (ClaudeUI sets neither XDG nor
 * the config dir for the server, so its own env IS the server's). A failure
 * only leaves fewer allows — more asks, never a silent read.
 */
export async function resolveOpencodeOwnDirAllows(
  client: OwnDirClient | undefined,
  deps: OwnDirDeps = {}
): Promise<V2Rule[]> {
  const platform = deps.platform ?? process.platform
  const dirs = opencodeGlobalDirs({
    env: deps.env ?? process.env,
    home: deps.homedir ?? os.homedir(),
    tmpdir: deps.tmpdir ?? os.tmpdir(),
    platform
  })
  let serverTmp: string | undefined
  try {
    const info = (await client?.call('server.info', {})) as
      { paths?: { tmp?: unknown } } | undefined
    const tmp = info?.paths?.tmp
    if (typeof tmp === 'string' && tmp !== '') serverTmp = tmp
  } catch (err) {
    deps.onError?.(
      `GET /api/info failed — deriving the tmp dir: ${err instanceof Error ? err.message : String(err)}`
    )
  }
  const raw = serverTmp ?? dirs.tmp
  const tmp: string[] = raw ? [raw] : []
  if (raw) {
    try {
      tmp.push((deps.realpath ?? realpathSync)(raw))
    } catch {
      // not created (yet) or unreadable: the raw spelling stands alone
    }
  }
  return opencodeOwnDirAllows({ ...dirs, tmp }, platform)
}
