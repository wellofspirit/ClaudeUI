/**
 * Where each harness may be installed on this machine (ADR-082 §3; the layouts
 * are catalogued in the ADR-082 research, §1-2 and §5): the files and package
 * directories system detection inspects. Nothing here resolves or runs them;
 * `resolve-install.ts` does the former, `probe.ts` the latter.
 *
 * Three sources, in this order (the first place an install is seen supplies
 * its display path, so a PATH hit wins over the package directory behind it):
 *
 *   1. PATH hits for the harness's command (and its aliases), in PATH order.
 *   2. The harness's own install locations: native installers, Homebrew,
 *      WinGet, scoop, pi.dev's managed install, Codex's standalone installer.
 *   3. The harness's npm package in every npm-family global root (npm, nvm,
 *      nvm-windows, pnpm, bun, Homebrew's node).
 *
 * The VS Code extension's and Claude Desktop's private copies are deliberately
 * not scanned: they churn with the host app, which can delete them under a
 * running session.
 *
 * Bounded work: fixed paths plus single-level listings of a few directories,
 * each capped; no recursive walks.
 */
import * as path from 'node:path'
import type { HarnessId } from '../../../shared/harness-types'
import { compareVersions } from '../store'
import { HARNESS_VERSION_RE } from '../selection-store'
import { isDir, isFile, listDir, readSmallText, realpathOrNull } from './fs-util'
import { envGet } from './path-entries'

export type CandidateKind =
  /** A file: a PATH hit, a shim, a launcher or an executable. */
  | 'file'
  /** An npm package directory (`<global node_modules>/<package>`). */
  | 'package'
  /** pi.dev's managed install root (`~/.pi/agent/install`). */
  | 'pi-managed'

export interface Candidate {
  id: HarnessId
  kind: CandidateKind
  path: string
}

export interface CandidateDeps {
  env: NodeJS.ProcessEnv
  platform: NodeJS.Platform
  arch: string
  homedir: string
  /** The directories to search for commands (`path-entries.ts`). */
  pathEntries: readonly string[]
}

export const HARNESS_COMMANDS: Record<HarnessId, string> = {
  claude: 'claude',
  opencode: 'opencode',
  pi: 'pi',
  codex: 'codex'
}

/**
 * Other command names a harness installs (ADR-093 §1): opencode 2.x also
 * ships `opencode2` (npm's second bin, the install script's legacy shim), so a
 * 2.x install is found even where a 1.x `opencode` shadows it on PATH.
 */
export const HARNESS_COMMAND_ALIASES: Record<HarnessId, readonly string[]> = {
  claude: [],
  opencode: ['opencode2'],
  pi: [],
  codex: []
}

/**
 * The npm packages that install each harness. `@opencode/cli` is opencode 2.x;
 * 1.x's `opencode-ai` is found so it can be labelled too old rather than go
 * unmentioned.
 */
export const HARNESS_PACKAGES: Record<HarnessId, readonly string[]> = {
  claude: ['@anthropic-ai/claude-code'],
  opencode: ['opencode-ai', '@opencode/cli'],
  pi: ['@earendil-works/pi-coding-agent'],
  codex: ['@openai/codex']
}

const LIST_CAP = 200

/** Codex's Rust target triple for a host (`codex-cli/bin/codex.js`), or null. */
export function codexTriple(platform: string, arch: string): string | null {
  const triples: Record<string, string> = {
    'linux-x64': 'x86_64-unknown-linux-musl',
    'linux-arm64': 'aarch64-unknown-linux-musl',
    'android-x64': 'x86_64-unknown-linux-musl',
    'android-arm64': 'aarch64-unknown-linux-musl',
    'darwin-x64': 'x86_64-apple-darwin',
    'darwin-arm64': 'aarch64-apple-darwin',
    'win32-x64': 'x86_64-pc-windows-msvc',
    'win32-arm64': 'aarch64-pc-windows-msvc'
  }
  return triples[`${platform}-${arch}`] ?? null
}

function exe(name: string, platform: NodeJS.Platform): string {
  return platform === 'win32' ? `${name}.exe` : name
}

/** A path-list key: case-insensitive on Windows. */
function key(p: string, platform: NodeJS.Platform): string {
  return platform === 'win32' ? p.toLowerCase() : p
}

/**
 * The first file in `dir` that `name` would run as. Windows tries `.exe`,
 * `.cmd`, `.ps1`, then the bare name (npm writes an `sh` shim beside its
 * `.cmd`); elsewhere only the bare name.
 */
export function commandIn(dir: string, name: string, platform: NodeJS.Platform): string | null {
  const variants = platform === 'win32' ? ['.exe', '.cmd', '.ps1', ''] : ['']
  for (const ext of variants) {
    const candidate = path.join(dir, name + ext)
    if (isFile(candidate)) return candidate
  }
  return null
}

function localAppData(deps: CandidateDeps): string {
  return (
    envGet(deps.env, 'LOCALAPPDATA', deps.platform) ?? path.join(deps.homedir, 'AppData', 'Local')
  )
}

/** Homebrew prefixes to look in (macOS/Linux). */
export function homebrewPrefixes(deps: CandidateDeps): string[] {
  if (deps.platform === 'win32') return []
  const fromEnv = envGet(deps.env, 'HOMEBREW_PREFIX', deps.platform)
  const all = [fromEnv, '/opt/homebrew', '/usr/local', '/home/linuxbrew/.linuxbrew']
  return [...new Set(all.filter((p): p is string => !!p))]
}

function scoopRoots(deps: CandidateDeps): string[] {
  if (deps.platform !== 'win32') return []
  const user = envGet(deps.env, 'SCOOP', deps.platform) ?? path.join(deps.homedir, 'scoop')
  const programData = envGet(deps.env, 'ProgramData', deps.platform) ?? 'C:\\ProgramData'
  const global = envGet(deps.env, 'SCOOP_GLOBAL', deps.platform) ?? path.join(programData, 'scoop')
  return [user, global]
}

/** `prefix=` from `~/.npmrc`, or null. */
function npmrcPrefix(deps: CandidateDeps): string | null {
  const text = readSmallText(path.join(deps.homedir, '.npmrc'), 16 * 1024)
  const match = text && /^\s*prefix\s*=\s*(.+?)\s*$/m.exec(text)
  if (!match) return null
  let value = match[1].replace(/^["']|["']$/g, '')
  if (value === '~' || value.startsWith('~/') || value.startsWith('~\\')) {
    value = deps.homedir + value.slice(1)
  }
  return path.isAbsolute(value) ? value : null
}

/** npm's global `node_modules` for a prefix. */
function prefixRoot(prefix: string, platform: NodeJS.Platform): string {
  return platform === 'win32'
    ? path.join(prefix, 'node_modules')
    : path.join(prefix, 'lib', 'node_modules')
}

/**
 * Every npm-family global `node_modules` that exists, de-duplicated by
 * realpath: npm's default (Windows `%APPDATA%\npm`), `NPM_CONFIG_PREFIX`,
 * `~/.npmrc`'s `prefix=`, the prefix of each `node` on the search path, every
 * nvm / nvm-windows version, pnpm's and bun's global stores, and Homebrew's.
 */
export function npmGlobalRoots(deps: CandidateDeps): string[] {
  const { env, platform, homedir } = deps
  const roots: string[] = []

  if (platform === 'win32') {
    const appData = envGet(env, 'APPDATA', platform) ?? path.join(homedir, 'AppData', 'Roaming')
    roots.push(path.join(appData, 'npm', 'node_modules'))
  }
  const envPrefix = envGet(env, 'NPM_CONFIG_PREFIX', platform) ?? env.npm_config_prefix
  if (envPrefix && path.isAbsolute(envPrefix)) roots.push(prefixRoot(envPrefix, platform))
  const rcPrefix = npmrcPrefix(deps)
  if (rcPrefix) roots.push(prefixRoot(rcPrefix, platform))

  for (const dir of deps.pathEntries) {
    if (!isFile(path.join(dir, exe('node', platform)))) continue
    // Windows installs keep globals beside node.exe (nvm-windows sets the
    // prefix to its symlink directory); elsewhere node sits in <prefix>/bin.
    roots.push(
      platform === 'win32'
        ? path.join(dir, 'node_modules')
        : prefixRoot(path.dirname(dir), platform)
    )
  }

  if (platform === 'win32') {
    const nvmHome = envGet(env, 'NVM_HOME', platform)
    if (nvmHome) {
      for (const name of listDir(nvmHome, LIST_CAP)) {
        if (/^v\d/.test(name)) roots.push(path.join(nvmHome, name, 'node_modules'))
      }
    }
  } else {
    const nvmDir = envGet(env, 'NVM_DIR', platform) ?? path.join(homedir, '.nvm')
    const versions = path.join(nvmDir, 'versions', 'node')
    for (const name of listDir(versions, LIST_CAP)) {
      roots.push(path.join(versions, name, 'lib', 'node_modules'))
    }
  }

  const pnpmHome =
    envGet(env, 'PNPM_HOME', platform) ??
    (platform === 'win32'
      ? path.join(localAppData(deps), 'pnpm')
      : platform === 'darwin'
        ? path.join(homedir, 'Library', 'pnpm')
        : path.join(homedir, '.local', 'share', 'pnpm'))
  const pnpmGlobal = path.join(pnpmHome, 'global')
  for (const name of listDir(pnpmGlobal, 20)) {
    roots.push(path.join(pnpmGlobal, name, 'node_modules'))
  }

  const bunHome = envGet(env, 'BUN_INSTALL', platform) ?? path.join(homedir, '.bun')
  roots.push(path.join(bunHome, 'install', 'global', 'node_modules'))

  for (const prefix of homebrewPrefixes(deps)) roots.push(path.join(prefix, 'lib', 'node_modules'))

  const seen = new Set<string>()
  const out: string[] = []
  for (const root of roots) {
    if (!isDir(root)) continue
    const k = key(realpathOrNull(root) ?? root, platform)
    if (seen.has(k)) continue
    seen.add(k)
    out.push(root)
  }
  return out
}

/** The newest file named like a version in Claude's native-installer `versions/` directory. */
function newestClaudeVersion(dir: string): string | null {
  const versions = listDir(dir, LIST_CAP)
    .filter((name) => HARNESS_VERSION_RE.test(name))
    .sort((a, b) => compareVersions(b, a))
  for (const name of versions) {
    const file = path.join(dir, name)
    if (isFile(file)) return file
  }
  return null
}

function wingetPackageFiles(deps: CandidateDeps, prefix: string, names: string[]): string[] {
  const packages = path.join(localAppData(deps), 'Microsoft', 'WinGet', 'Packages')
  const out: string[] = []
  for (const dir of listDir(packages, 1000)) {
    if (!dir.startsWith(prefix)) continue
    for (const name of names) out.push(path.join(packages, dir, name))
  }
  return out
}

/** The harness's own install locations (files, plus pi's managed root). */
export function harnessDirCandidates(id: HarnessId, deps: CandidateDeps): Candidate[] {
  const { env, platform, homedir } = deps
  const win = platform === 'win32'
  const cmd = HARNESS_COMMANDS[id]
  const files: string[] = []
  const out: Candidate[] = []

  const brewBins = homebrewPrefixes(deps).map((prefix) => path.join(prefix, 'bin', cmd))
  const wingetLink = win
    ? [path.join(localAppData(deps), 'Microsoft', 'WinGet', 'Links', `${cmd}.exe`)]
    : []
  const scoop = (app: string, ...rel: string[]): string[] =>
    scoopRoots(deps).map((root) => path.join(root, 'apps', app, 'current', ...rel))

  switch (id) {
    case 'claude': {
      const launcher = path.join(homedir, '.local', 'bin', exe('claude', platform))
      if (isFile(launcher)) files.push(launcher)
      else {
        // Only without the launcher: it is what the user runs, and the
        // versions it leaves behind are not installs of their own.
        const newest = newestClaudeVersion(
          path.join(homedir, '.local', 'share', 'claude', 'versions')
        )
        if (newest) files.push(newest)
      }
      files.push(...brewBins, ...wingetLink)
      if (win) files.push(...wingetPackageFiles(deps, 'Anthropic.ClaudeCode_', ['claude.exe']))
      files.push(...scoop('claude-code', 'claude.exe'))
      const legacy = path.join(
        homedir,
        '.claude',
        'local',
        'node_modules',
        '@anthropic-ai',
        'claude-code'
      )
      if (isDir(legacy)) out.push({ id, kind: 'package', path: legacy })
      break
    }
    case 'opencode': {
      files.push(path.join(homedir, '.opencode', 'bin', exe('opencode', platform)))
      for (const name of ['OPENCODE_INSTALL_DIR', 'XDG_BIN_DIR']) {
        const dir = envGet(env, name, platform)
        if (dir && path.isAbsolute(dir)) files.push(path.join(dir, exe('opencode', platform)))
      }
      if (!win) files.push(path.join(homedir, 'bin', 'opencode'))
      files.push(...brewBins, ...wingetLink, ...scoop('opencode', 'opencode.exe'))
      break
    }
    case 'pi': {
      const agentDir =
        envGet(env, 'PI_CODING_AGENT_DIR', platform) ?? path.join(homedir, '.pi', 'agent')
      const roots = [
        envGet(env, 'PI_MANAGED_INSTALL_ROOT', platform),
        path.join(agentDir, 'install')
      ]
      for (const root of roots) {
        if (root && path.isAbsolute(root) && isFile(path.join(root, 'managed-install.json'))) {
          out.push({ id, kind: 'pi-managed', path: root })
        }
      }
      if (!win) {
        files.push(
          path.join(agentDir, 'bin', 'pi'),
          path.join(homedir, '.local', 'bin', 'pi'),
          path.join(homedir, 'bin', 'pi')
        )
      }
      files.push(...brewBins)
      break
    }
    case 'codex': {
      const codexHome = envGet(env, 'CODEX_HOME', platform)
      for (const home of [codexHome, path.join(homedir, '.codex')]) {
        if (home && path.isAbsolute(home)) {
          files.push(
            path.join(home, 'packages', 'standalone', 'current', 'bin', exe('codex', platform))
          )
        }
      }
      const installDir = envGet(env, 'CODEX_INSTALL_DIR', platform)
      if (installDir && path.isAbsolute(installDir))
        files.push(path.join(installDir, exe('codex', platform)))
      if (win) {
        files.push(path.join(localAppData(deps), 'Programs', 'OpenAI', 'Codex', 'bin', 'codex.exe'))
        const triple = codexTriple(platform, deps.arch)
        files.push(
          ...wingetLink,
          ...wingetPackageFiles(deps, 'OpenAI.Codex_', [
            ...(triple ? [`codex-${triple}.exe`] : []),
            'codex.exe'
          ])
        )
      } else {
        files.push(path.join(homedir, '.local', 'bin', 'codex'))
      }
      files.push(...brewBins, ...scoop('codex', 'bin', 'codex.exe'))
      break
    }
  }

  for (const file of files) {
    if (isFile(file)) out.push({ id, kind: 'file', path: file })
  }
  return out
}

/** Every candidate for `id`, in precedence order, de-duplicated by path. */
export function harnessCandidates(id: HarnessId, deps: CandidateDeps): Candidate[] {
  const all: Candidate[] = []
  for (const dir of deps.pathEntries) {
    for (const name of [HARNESS_COMMANDS[id], ...HARNESS_COMMAND_ALIASES[id]]) {
      const hit = commandIn(dir, name, deps.platform)
      if (hit) all.push({ id, kind: 'file', path: hit })
    }
  }
  all.push(...harnessDirCandidates(id, deps))
  for (const root of npmGlobalRoots(deps)) {
    for (const pkg of HARNESS_PACKAGES[id]) {
      const dir = path.join(root, ...pkg.split('/'))
      if (isDir(dir)) all.push({ id, kind: 'package', path: dir })
    }
  }
  const seen = new Set<string>()
  return all.filter((c) => {
    const k = `${c.kind}:${key(c.path, deps.platform)}`
    if (seen.has(k)) return false
    seen.add(k)
    return true
  })
}
