/**
 * Turn one detection candidate into what ClaudeUI would spawn (ADR-082 §2-3),
 * without executing anything. The layouts are catalogued in the ADR-082
 * research (§1-2).
 *
 * - Symlinks and junctions are resolved (`realpath`).
 * - Version-manager multiplexers (`mise`, `volta-shim`, `asdf`) and
 *   Chocolatey's shim executables are never the harness: `unsupported`.
 * - scoop's and bun's shim executables are read through their text sidecar
 *   (`<name>.shim`'s `path = "..."`, `<name>.bunx`'s UTF-16 relative path).
 * - A native file (PE, ELF, Mach-O) is taken as-is.
 * - A text file inside a harness's npm package (a placeholder `bin/*.exe`
 *   stub, pi's `cli.js`, Codex's `codex.js`) resolves through the package:
 *     Claude Code, opencode  `<pkg>/bin/<name>.exe` when native, else the
 *                            platform package's binary (`createRequire` from
 *                            the realpath'd package, as their postinstall does)
 *     Codex                  `@openai/codex-<os>-<arch>` → `vendor/<triple>/bin/codex`,
 *                            falling back to `<pkg>/vendor/…` (`codex.js`'s
 *                            `findCodexExecutable`)
 *     pi                     `<pkg>/dist/bundle/cli.js`, run by a node that
 *                            `node-choice.ts` picks (`nodeFor`)
 * - pi.dev's managed install (`managed-install.json` + `current-version`)
 *   resolves to that release's `cli.js`, with the launcher's environment.
 * - Any other text file (npm `.cmd`/`.ps1`/`sh` shims, Homebrew env scripts)
 *   is followed to the path it runs; one that leads nowhere is `unsupported`:
 *   a script launcher ClaudeUI cannot run directly.
 */
import * as fs from 'node:fs'
import { createRequire } from 'node:module'
import * as path from 'node:path'
import type { HarnessId, HarnessInstallKind, HarnessLaunch } from '../../../shared/harness-types'
import { nativeLaunch } from '../launch'
import { codexTriple, HARNESS_PACKAGES, type Candidate } from './candidates'
import {
  isDir,
  isFile,
  isNativeExecutable,
  readHead,
  readSmallText,
  realpathOrNull
} from './fs-util'
import { envGet } from './path-entries'

export interface ResolveDeps {
  env: NodeJS.ProcessEnv
  /** Names only (platform packages, `.exe`); paths use the host's `path`. */
  platform: NodeJS.Platform
  arch: string
  homedir: string
}

/** A Node script and the nodes its install would run it with (pi). */
export interface NodeScriptTarget {
  /** The script, realpath'd. */
  script: string
  /** The install's own nodes, in preference order; each exists. */
  preferredNodes: string[]
  /** Environment entries the install's launcher sets. */
  env?: Record<string, string>
}

interface ResolutionBase {
  id: HarnessId
  displayPath: string
  /** The file that runs: the native executable, or pi's `cli.js`. */
  realPath: string
  installKind: HarnessInstallKind
}

export interface ResolvedInstall extends ResolutionBase {
  status: 'resolved'
  /** A native launch; null exactly when `nodeFor` is set (a node is still to be chosen). */
  launch: HarnessLaunch | null
  nodeFor?: NodeScriptTarget
}

export interface UnsupportedInstall extends ResolutionBase {
  status: 'unsupported'
  reason: string
}

export type InstallResolution = ResolvedInstall | UnsupportedInstall

const MAX_DEPTH = 4
const MULTIPLEXERS: ReadonlySet<string> = new Set(['mise', 'rtx', 'volta-shim', 'asdf'])
const NODE_NAMES: ReadonlySet<string> = new Set(['node', 'node.exe'])

const LABELS: Record<HarnessId, string> = {
  claude: 'Claude Code',
  opencode: 'opencode',
  pi: 'pi',
  codex: 'Codex'
}

function exe(name: string, platform: NodeJS.Platform): string {
  return platform === 'win32' ? `${name}.exe` : name
}

// ── Install kind ──────────────────────────────────────────────────────────────

const KIND_PATTERNS: [HarnessInstallKind, string[]][] = [
  ['homebrew', ['/cellar/', '/caskroom/', '/homebrew/', '/linuxbrew/']],
  ['pi-managed', ['/.pi/agent/install/']],
  ['bun', ['/.bun/install/global/', '/.bun/bin/']],
  ['pnpm', ['/.pnpm/', '/pnpm/']],
  ['npm', ['/node_modules/']],
  ['scoop', ['/scoop/']],
  ['winget', ['/microsoft/winget/']],
  ['standalone', ['/.codex/packages/standalone/', '/programs/openai/codex/']],
  ['native-installer', ['/.local/share/claude/', '/.local/bin/claude', '/.opencode/bin/']]
]

function kindOf(p: string): HarnessInstallKind | null {
  const s = p.replace(/\\/g, '/').toLowerCase()
  for (const [kind, needles] of KIND_PATTERNS) {
    if (needles.some((needle) => s.includes(needle))) return kind
  }
  return null
}

/** How an install got there, read from where it lives (the file that runs first). */
export function installKindFor(realPath: string, displayPath: string): HarnessInstallKind {
  return kindOf(realPath) ?? kindOf(displayPath) ?? 'path'
}

// ── Shim parsing ──────────────────────────────────────────────────────────────

/** scoop's `<name>.shim`: `path = "C:\...\app.exe"`. */
export function parseScoopShim(text: string): string | null {
  const match = /^\s*path\s*=\s*"?([^"\r\n]+?)"?\s*$/m.exec(text)
  return match ? match[1] : null
}

/**
 * bun's `<name>.bunx` (Windows): UTF-16LE, a path relative to bun's home
 * (`~/.bun`, the bin directory's parent) ending in `"`, then NUL and the
 * interpreter.
 */
export function parseBunxShim(buf: Buffer): string | null {
  const text = buf.toString('utf16le')
  const end = text.search(/["\0]/)
  const rel = (end < 0 ? text : text.slice(0, end)).trim()
  return rel ? rel : null
}

/**
 * The paths an npm-family shim (cmd-shim's `.cmd`, `.ps1`, `sh`) or a wrapper
 * script runs, in order of appearance: `%dp0%\…` / `%~dp0\…` and
 * `$basedir/…` relative to the shim, plus quoted absolute paths. The shim's
 * own `node` preference is left out.
 */
export function shimTargets(text: string, shimDir: string): string[] {
  const found: { at: number; target: string }[] = []
  const rel = (value: string): string => path.resolve(shimDir, value.replace(/[\\/]+/g, path.sep))
  for (const m of text.matchAll(/%~?dp0%?[\\/]+([^"%\r\n]+)/g)) {
    found.push({ at: m.index ?? 0, target: rel(m[1].trim()) })
  }
  for (const m of text.matchAll(/\$basedir[\\/]+([^"\r\n]+)/g)) {
    found.push({ at: m.index ?? 0, target: rel(m[1].trim()) })
  }
  for (const m of text.matchAll(/"((?:[A-Za-z]:[\\/]|\/)[^"\r\n]+)"/g)) {
    found.push({ at: m.index ?? 0, target: m[1] })
  }
  return found
    .sort((a, b) => a.at - b.at)
    .map((f) => f.target)
    .filter((t) => !NODE_NAMES.has(path.basename(t).toLowerCase()))
}

/** The last existing file a text launcher runs, or null. */
function followShim(file: string): string | null {
  const text = readSmallText(file)
  if (text === null) return null
  const targets = shimTargets(text.replace(/^\uFEFF/, ''), path.dirname(file)).filter(
    (t) => isFile(t) && path.resolve(t) !== path.resolve(file)
  )
  return targets.length > 0 ? targets[targets.length - 1] : null
}

// ── npm packages ──────────────────────────────────────────────────────────────

function readPackageField(dir: string, field: 'name' | 'version'): string | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf-8')) as Record<
      string,
      unknown
    > | null
    const value = parsed?.[field]
    return typeof value === 'string' ? value : null
  } catch {
    return null
  }
}

function readPackageName(dir: string): string | null {
  return readPackageField(dir, 'name')
}

/** The harness npm package `file` lives in (walking up at most a few levels), or null. */
function packageContaining(id: HarnessId, file: string): string | null {
  let dir = path.dirname(file)
  for (let level = 0; level < 5; level++) {
    const name = readPackageName(dir)
    if (name !== null && HARNESS_PACKAGES[id].includes(name)) return dir
    const parent = path.dirname(dir)
    if (path.basename(dir) === 'node_modules' || parent === dir) break
    dir = parent
  }
  return null
}

/** `<pkgName>`'s directory as `pkgDir`'s own `require` would find it, or null. */
function requirePackageDir(pkgDir: string, pkgName: string): string | null {
  try {
    const require = createRequire(path.join(pkgDir, 'package.json'))
    return path.dirname(require.resolve(`${pkgName}/package.json`))
  } catch {
    return null
  }
}

/** Claude Code's platform packages for a host, in lookup order (`install.cjs`). */
export function claudePlatformPackages(platform: string, arch: string): string[] {
  const base = `@anthropic-ai/claude-code-${platform}-${arch}`
  return platform === 'linux' ? [base, `${base}-musl`] : [base]
}

/**
 * opencode's platform packages for a host (`script/postinstall.mjs`). Without
 * the postinstall's AVX2 probe, the regular build is tried before `-baseline`.
 */
export function opencodePlatformPackages(platform: string, arch: string): string[] {
  const os = platform === 'win32' ? 'windows' : platform
  const base = `opencode-${os}-${arch}`
  const names = [base]
  if (arch === 'x64') names.push(`${base}-baseline`)
  if (platform === 'linux') {
    names.push(`${base}-musl`)
    if (arch === 'x64') names.push(`${base}-baseline-musl`)
  }
  return names
}

/** `@openai/codex`'s platform package for a triple (`codex.js`). */
export function codexPlatformPackage(triple: string): string | null {
  const byTriple: Record<string, string> = {
    'x86_64-unknown-linux-musl': '@openai/codex-linux-x64',
    'aarch64-unknown-linux-musl': '@openai/codex-linux-arm64',
    'x86_64-apple-darwin': '@openai/codex-darwin-x64',
    'aarch64-apple-darwin': '@openai/codex-darwin-arm64',
    'x86_64-pc-windows-msvc': '@openai/codex-win32-x64',
    'aarch64-pc-windows-msvc': '@openai/codex-win32-arm64'
  }
  return byTriple[triple] ?? null
}

// ── Results ───────────────────────────────────────────────────────────────────

function nativeResolved(
  id: HarnessId,
  displayPath: string,
  file: string,
  kind?: HarnessInstallKind
): ResolvedInstall {
  const realPath = realpathOrNull(file) ?? file
  return {
    status: 'resolved',
    id,
    displayPath,
    realPath,
    installKind: kind ?? installKindFor(realPath, displayPath),
    launch: nativeLaunch(realPath)
  }
}

function unsupported(
  id: HarnessId,
  displayPath: string,
  realPath: string,
  reason: string,
  kind?: HarnessInstallKind
): UnsupportedInstall {
  return {
    status: 'unsupported',
    id,
    displayPath,
    realPath,
    installKind: kind ?? installKindFor(realPath, displayPath),
    reason
  }
}

function scriptLauncher(id: HarnessId, displayPath: string, realPath: string): UnsupportedInstall {
  return unsupported(
    id,
    displayPath,
    realPath,
    `${displayPath} is a script launcher ClaudeUI cannot run directly`
  )
}

// ── pi ────────────────────────────────────────────────────────────────────────

/** A node beside the npm shim / in the prefix that installed `pkgDir`, then Homebrew's node. */
function piOwnNodes(
  displayPath: string,
  pkgDir: string,
  realPkg: string,
  deps: ResolveDeps
): string[] {
  const nodeName = exe('node', deps.platform)
  const nodes: string[] = []
  if (isFile(displayPath)) nodes.push(path.join(path.dirname(displayPath), nodeName))
  // `<prefix>/node_modules/<pkg>` (Windows) or `<prefix>/lib/node_modules/<pkg>`.
  let dir = pkgDir
  for (let level = 0; level < 3 && path.basename(dir) !== 'node_modules'; level++) {
    dir = path.dirname(dir)
  }
  if (path.basename(dir) === 'node_modules') {
    const prefix = path.dirname(dir)
    nodes.push(
      path.basename(prefix) === 'lib'
        ? path.join(path.dirname(prefix), 'bin', nodeName)
        : path.join(prefix, nodeName)
    )
  }
  for (const p of [realPkg, displayPath]) {
    const cellar = p.replace(/\\/g, '/').search(/\/Cellar\//)
    if (cellar > 0) nodes.push(path.join(p.slice(0, cellar), 'opt', 'node', 'bin', nodeName))
  }
  return [...new Set(nodes)].filter(isFile)
}

function piFromPackage(
  displayPath: string,
  pkgDir: string,
  realPkg: string,
  deps: ResolveDeps
): InstallResolution {
  const cli = path.join(realPkg, 'dist', 'bundle', 'cli.js')
  if (!isFile(cli)) {
    return unsupported(
      'pi',
      displayPath,
      realPkg,
      `${displayPath}: pi's package has no dist/bundle/cli.js`
    )
  }
  const script = realpathOrNull(cli) ?? cli
  return {
    status: 'resolved',
    id: 'pi',
    displayPath,
    realPath: script,
    installKind: installKindFor(script, displayPath),
    launch: null,
    nodeFor: { script, preferredNodes: piOwnNodes(displayPath, pkgDir, realPkg, deps) }
  }
}

const PI_VERSION_DIR = /^[0-9A-Za-z._+-]+$/

/**
 * pi.dev's managed install at `root` (`<agent dir>/install`), as its launcher
 * runs it: `releases/<current-version>/…/cli.js` with `PI_MANAGED_INSTALL_ROOT`
 * set and the installer's `pi-node` first on PATH when it exists.
 */
export function resolvePiManaged(
  root: string,
  displayPath: string | null,
  deps: ResolveDeps
): InstallResolution | null {
  let marker: Record<string, unknown> | null = null
  try {
    marker = JSON.parse(
      fs.readFileSync(path.join(root, 'managed-install.json'), 'utf-8')
    ) as Record<string, unknown> | null
  } catch {
    return null
  }
  const launcher = path.join(path.dirname(root), 'bin', 'pi')
  const display = displayPath ?? (isFile(launcher) ? launcher : root)
  if (marker?.kind !== 'pi-managed-install' || marker.layout !== 'releases-v1') {
    return unsupported(
      'pi',
      display,
      root,
      `${root}: unrecognised pi managed-install layout`,
      'pi-managed'
    )
  }
  const version = (readSmallText(path.join(root, 'current-version'), 256) ?? '')
    .split(/\r?\n/)[0]
    .trim()
  if (!PI_VERSION_DIR.test(version) || version === '.' || version === '..') {
    return unsupported(
      'pi',
      display,
      root,
      `${root}: current-version is missing or invalid`,
      'pi-managed'
    )
  }
  const cli = path.join(
    root,
    'releases',
    version,
    'node_modules',
    '@earendil-works',
    'pi-coding-agent',
    'dist',
    'bundle',
    'cli.js'
  )
  if (!isFile(cli)) {
    return unsupported('pi', display, cli, `${cli} is missing`, 'pi-managed')
  }
  const dataHome =
    envGet(deps.env, 'XDG_DATA_HOME', deps.platform) ?? path.join(deps.homedir, '.local', 'share')
  const nodeBin = path.join(dataHome, 'pi-node', 'current', 'bin')
  const managedNode = path.join(nodeBin, exe('node', deps.platform))
  const env: Record<string, string> = { PI_MANAGED_INSTALL_ROOT: root }
  const preferredNodes: string[] = []
  if (isFile(managedNode)) {
    preferredNodes.push(managedNode)
    const current = envGet(deps.env, 'PATH', deps.platform)
    env.PATH = current ? `${nodeBin}${path.delimiter}${current}` : nodeBin
  }
  const script = realpathOrNull(cli) ?? cli
  return {
    status: 'resolved',
    id: 'pi',
    displayPath: display,
    realPath: script,
    installKind: 'pi-managed',
    launch: null,
    nodeFor: { script, preferredNodes, env }
  }
}

/** pi.dev's launcher `<agent dir>/bin/pi` → its managed root, when the marker is there. */
function piManagedRootForLauncher(real: string): string | null {
  if (path.basename(real) !== 'pi' || path.basename(path.dirname(real)) !== 'bin') return null
  const root = path.join(path.dirname(path.dirname(real)), 'install')
  return isFile(path.join(root, 'managed-install.json')) ? root : null
}

// ── Packages ──────────────────────────────────────────────────────────────────

/** A harness's npm package directory → what it runs. Null when it is not that harness's package. */
export function resolvePackage(
  id: HarnessId,
  pkgDir: string,
  displayPath: string,
  deps: ResolveDeps
): InstallResolution | null {
  const realPkg = realpathOrNull(pkgDir)
  if (!realPkg || !isDir(realPkg)) return null
  const name = readPackageName(realPkg)
  if (name === null || !HARNESS_PACKAGES[id].includes(name)) return null
  const { platform, arch } = deps

  const firstNative = (files: string[]): string | null => files.find(isNativeExecutable) ?? null
  const pkgVersion = readPackageField(realPkg, 'version')
  const missing = (what: string): UnsupportedInstall =>
    unsupported(
      id,
      displayPath,
      realPkg,
      `${displayPath}${pkgVersion ? ` (${name} ${pkgVersion})` : ''}: ${what} (was it installed with --ignore-scripts or --omit=optional?)`
    )

  switch (id) {
    case 'claude':
    case 'opencode': {
      const binName = id === 'claude' ? 'claude' : 'opencode'
      const own = path.join(realPkg, 'bin', `${binName}.exe`)
      if (isNativeExecutable(own)) return nativeResolved(id, displayPath, own)
      // opencode 2.x (`@opencode/cli`) has no platform-package lookup of ours.
      const platformPkgs =
        id === 'claude'
          ? claudePlatformPackages(platform, arch)
          : name === 'opencode-ai'
            ? opencodePlatformPackages(platform, arch)
            : []
      const files: string[] = []
      for (const pkg of platformPkgs) {
        const dir = requirePackageDir(realPkg, pkg)
        if (!dir) continue
        files.push(
          id === 'claude'
            ? path.join(dir, exe('claude', platform))
            : path.join(dir, 'bin', exe('opencode', platform))
        )
      }
      const found = firstNative(files)
      if (found) return nativeResolved(id, displayPath, found)
      return missing(`${LABELS[id]}'s native executable is not in its npm package`)
    }
    case 'codex': {
      const triple = codexTriple(platform, arch)
      const platformPkg = triple ? codexPlatformPackage(triple) : null
      if (!triple || !platformPkg) {
        return unsupported(id, displayPath, realPkg, `Codex has no build for ${platform}-${arch}`)
      }
      const vendorRoots: string[] = []
      const dir = requirePackageDir(realPkg, platformPkg)
      if (dir) vendorRoots.push(path.join(dir, 'vendor'))
      vendorRoots.push(path.join(realPkg, 'vendor'))
      const found = firstNative(
        vendorRoots.map((root) => path.join(root, triple, 'bin', exe('codex', platform)))
      )
      if (found) return nativeResolved(id, displayPath, found)
      return missing(`Codex's platform package ${platformPkg} is not installed`)
    }
    case 'pi':
      return piFromPackage(displayPath, pkgDir, realPkg, deps)
  }
}

// ── Files ─────────────────────────────────────────────────────────────────────

function isChocolateyShim(real: string): boolean {
  return /[\\/]chocolatey[\\/]bin[\\/][^\\/]+$/i.test(real)
}

function sidecar(real: string, ext: string): string {
  const parsed = path.parse(real)
  return path.join(parsed.dir, parsed.name + ext)
}

function resolveFile(
  id: HarnessId,
  file: string,
  displayPath: string,
  deps: ResolveDeps,
  depth: number,
  kind?: HarnessInstallKind
): InstallResolution | null {
  const real = realpathOrNull(file)
  if (!real || !isFile(real)) return null
  if (depth > MAX_DEPTH) return scriptLauncher(id, displayPath, real)

  const base = path
    .basename(real)
    .toLowerCase()
    .replace(/\.exe$/, '')
  if (MULTIPLEXERS.has(base)) {
    return unsupported(
      id,
      displayPath,
      real,
      `${displayPath} is a ${base} shim; ClaudeUI cannot tell which install it runs`,
      kind
    )
  }
  if (isChocolateyShim(real)) {
    return unsupported(
      id,
      displayPath,
      real,
      `${displayPath} is a Chocolatey shim; ClaudeUI cannot tell which install it runs`,
      kind
    )
  }

  const scoop = sidecar(real, '.shim')
  if (scoop !== real && isFile(scoop)) {
    const target = parseScoopShim(readSmallText(scoop) ?? '')
    return target
      ? resolveFile(id, target, displayPath, deps, depth + 1, 'scoop')
      : unsupported(id, displayPath, real, `${scoop} names no target`, 'scoop')
  }
  const bunx = sidecar(real, '.bunx')
  if (bunx !== real && isFile(bunx)) {
    const rel = parseBunxShim(readHead(bunx, 4096) ?? Buffer.alloc(0))
    const target =
      rel && path.resolve(path.dirname(path.dirname(real)), rel.replace(/[\\/]+/g, path.sep))
    return target
      ? resolveFile(id, target, displayPath, deps, depth + 1, 'bun')
      : unsupported(id, displayPath, real, `${bunx} names no target`, 'bun')
  }

  if (isNativeExecutable(real)) return nativeResolved(id, displayPath, real, kind)

  const pkg = packageContaining(id, real)
  if (pkg) return resolvePackage(id, pkg, displayPath, deps)

  if (id === 'pi') {
    const root = piManagedRootForLauncher(real)
    if (root) return resolvePiManaged(root, displayPath, deps)
  }

  const target = followShim(real)
  if (target) return resolveFile(id, target, displayPath, deps, depth + 1, kind)

  return scriptLauncher(id, displayPath, real)
}

/**
 * What `candidate` would run, or null when nothing is there (a dangling link,
 * or a package that is not this harness's). Never throws; executes nothing.
 */
export function resolveCandidate(
  candidate: Candidate,
  deps: ResolveDeps
): InstallResolution | null {
  try {
    switch (candidate.kind) {
      case 'file':
        return resolveFile(candidate.id, candidate.path, candidate.path, deps, 0)
      case 'package':
        return resolvePackage(candidate.id, candidate.path, candidate.path, deps)
      case 'pi-managed':
        return candidate.id === 'pi' ? resolvePiManaged(candidate.path, null, deps) : null
    }
  } catch {
    return null
  }
}
