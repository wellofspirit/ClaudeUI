/**
 * pi path containment (H1): where a pi file tool call will really land, and whether that is
 * inside the session's workspace.
 *
 * pi has no sandbox and, before this module, no notion of "outside the project": `read`, `edit`,
 * `write`, `grep`, `find` and `ls` reached the mode base with the path unlooked-at. This is the
 * Claude Code model (cwd + `permissions.additionalDirectories`, every resolved spelling must be
 * inside, an unresolvable path is never auto-allowed) applied to pi's own tools:
 *
 *  1. {@link piResolvePath} ports pi's path normalisation exactly, so the path we gate is the path
 *     pi opens (`@x`, `~/x`, `file:///x`, `/c/x` on Windows, unicode spaces);
 *  2. {@link readCandidate} ports pi's `read` fallbacks (AM/PM, NFD, curly quote);
 *  3. {@link pathFacts} adds the filesystem: the real landing (symlinks, junctions), whether the
 *     leaf is a link, containment in the roots, agent-control sensitivity, Windows path tricks;
 *  4. {@link withPathGuard} pins an allowed call to the path that was gated (pi's hook may mutate
 *     the tool input in place, and does not re-validate: `vendor/pi-src/packages/coding-agent/src/
 *     core/extensions/types.ts` ToolCallEvent, `agent-loop.ts` `prepareToolCall` passes the same
 *     validated args object to `beforeToolCall` and then to `execute`), and re-checks the path
 *     after a delayed (human) approval.
 *
 * Not a filesystem sandbox: the gate runs before the tool, so a link swapped in between the
 * check and pi's `open` is outside what a permission gate can see (the re-check after approval
 * narrows that window for the slow case, nothing more), and a hard link to a file outside the
 * workspace looks like an ordinary file inside it.
 *
 * The functions are pure but for the injectable {@link PathScopeFs} seam (`hostPathFs` by
 * default) and the home directory. Windows and POSIX semantics are selected by the `platform`
 * argument, never by the host, so both are testable anywhere.
 */
import { accessSync, constants, lstatSync, realpathSync } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import type { ClaudePermissions } from '../../shared/types'
import { isAgentControlPath } from '../automode/agent-control-paths'
import { resolveAdditionalDirectories, uniqueDirs } from '../services/additional-directories'

// ---------------------------------------------------------------------------
// pi's path normalisation (port)
// ---------------------------------------------------------------------------

type Flavor = typeof path.posix

function flavorOf(platform: NodeJS.Platform): Flavor {
  return platform === 'win32' ? path.win32 : path.posix
}

/** vendor/pi-src/packages/coding-agent/src/utils/paths.ts `UNICODE_SPACES`. */
const UNICODE_SPACES = /[\u00A0\u2000-\u200A\u202F\u205F\u3000]/g

/**
 * Port of `normalizeWindowsShellPath` (utils/paths.ts, pi v1.4.0): Git Bash / MSYS / Cygwin / WSL
 * drive paths (`/c/x`, `/mnt/c/x`, `/cygdrive/c/x`) become `C:\x`. Skipped, exactly as pi skips,
 * for a non-rooted path, a `//` path and any path with a backslash.
 */
export function normalizeWindowsShellPath(filePath: string): string {
  if (!filePath.startsWith('/') || filePath.startsWith('//') || filePath.includes('\\')) {
    return filePath
  }
  const match = filePath.match(/^\/(?:mnt\/|cygdrive\/)?([a-z])(?:\/(.*))?$/i)
  if (!match) return filePath
  const suffix = match[2]?.replaceAll('/', '\\')
  return `${match[1].toUpperCase()}:\\${suffix ?? ''}`
}

interface NormalizeOptions {
  unicodeSpaces?: boolean
  stripAt?: boolean
}

/** Port of `normalizePath` (trim off; `~` expansion on; `homeDir` explicit). May throw (`file://`). */
function piNormalizePath(
  input: string,
  platform: NodeJS.Platform,
  home: string,
  options: NormalizeOptions
): string {
  const win = platform === 'win32'
  let normalized = input
  if (options.unicodeSpaces) normalized = normalized.replace(UNICODE_SPACES, ' ')
  if (options.stripAt && normalized.startsWith('@')) normalized = normalized.slice(1)
  if (win) normalized = normalizeWindowsShellPath(normalized)
  if (normalized === '~') return home
  if (normalized.startsWith('~/') || (win && normalized.startsWith('~\\'))) {
    return flavorOf(platform).join(home, normalized.slice(2))
  }
  if (/^file:\/\//.test(normalized)) return fileURLToPath(normalized, { windows: win })
  return normalized
}

/**
 * The absolute path pi's `resolveToCwd` gives `raw` for a session in `cwd`
 * (`utils/paths.ts` `resolvePath` with `normalizeUnicodeSpaces` + `stripAtPrefix`, as
 * `core/tools/path-utils.ts` calls it, pi v1.4.0): unicode spaces folded, one leading `@`
 * stripped, Windows shell drive paths converted, `~` / `~/` (and `~\` on win32) expanded,
 * `file://` decoded, then resolved against the cwd.
 *
 * Always `resolve(cwd, p)`, never "absolute ? normalize : resolve": pi's own `resolve` of an
 * absolute path uses ITS process cwd, which is the session cwd, so a rooted-driveless `/etc/x`
 * on Windows is `<cwd's drive>:\etc\x`, not the drive ClaudeUI itself runs on. `~user/x` is
 * relative (pi does not expand it).
 *
 * Throws what pi's would (`file://` with a host or an invalid escape): the caller treats that as
 * "cannot place this path".
 */
export function piResolvePath(
  raw: string,
  cwd: string,
  platform: NodeJS.Platform = process.platform,
  home: string = homedir()
): string {
  const normalized = piNormalizePath(raw, platform, home, { unicodeSpaces: true, stripAt: true })
  const base = piNormalizePath(cwd, platform, home, {})
  return flavorOf(platform).resolve(base, normalized)
}

const NARROW_NO_BREAK_SPACE = '\u202F'

/**
 * Port of `resolveReadPathAsync`'s candidate choice (`core/tools/path-utils.ts`, pi v1.4.0):
 * `resolved` itself when it exists, else the first existing of the macOS variants in pi's order
 * (AM/PM narrow space, NFD, curly quote, NFD + curly quote), else `resolved`. Not platform-gated
 * in pi, so not here. `exists` follows links (`access(F_OK)`), as pi's does.
 */
export function readCandidate(resolved: string, exists: (p: string) => boolean): string {
  if (exists(resolved)) return resolved
  const amPm = resolved.replace(/ (AM|PM)\./gi, `${NARROW_NO_BREAK_SPACE}$1.`)
  if (amPm !== resolved && exists(amPm)) return amPm
  const nfd = resolved.normalize('NFD')
  if (nfd !== resolved && exists(nfd)) return nfd
  const curly = resolved.replace(/'/g, '\u2019')
  if (curly !== resolved && exists(curly)) return curly
  const nfdCurly = nfd.replace(/'/g, '\u2019')
  if (nfdCurly !== resolved && exists(nfdCurly)) return nfdCurly
  return resolved
}

// ---------------------------------------------------------------------------
// Filesystem seam
// ---------------------------------------------------------------------------

/** The three filesystem questions the facts need. Throwing members throw Node's errno errors (`.code`). */
export interface PathScopeFs {
  realpath(p: string): string
  lstat(p: string): { isSymbolicLink(): boolean }
  /** Does the path exist, following links (`access(F_OK)`)? */
  exists(p: string): boolean
}

export const hostPathFs: PathScopeFs = {
  realpath: (p) => realpathSync.native(p),
  lstat: (p) => lstatSync(p),
  exists: (p) => {
    try {
      accessSync(p, constants.F_OK)
      return true
    } catch {
      return false
    }
  }
}

function isMissing(err: unknown): boolean {
  const code = (err as NodeJS.ErrnoException | undefined)?.code
  return code === 'ENOENT' || code === 'ENOTDIR'
}

// ---------------------------------------------------------------------------
// The scope
// ---------------------------------------------------------------------------

/**
 * A session's workspace, as the ladder's containment rung reads it. Built by
 * {@link buildPiPathScope}; every path is absolute.
 */
export interface PiPathScope {
  /** The session's working directory: relative paths resolve against it. */
  cwd: string
  /** cwd + the resolved `permissions.additionalDirectories`. Read and write roots, compared by lexical AND realpath spelling. */
  roots: readonly string[]
  /**
   * Read-only roots (the project temp dir `<tmp>/claudeui/<project-key>/`). Compared AS SPELLED,
   * never realpath-expanded: the creator passes the canonical spelling, and a root swapped for a
   * link later then simply stops matching instead of widening.
   */
  readRoots?: readonly string[]
  /** This session's scratchpad: read AND write in scope in every mode. Compared AS SPELLED (as `readRoots`). */
  scratchpad?: string
  /** `permissions.blockReadsOutsideWorkingDirectories`: an out-of-scope read/search is a deny. */
  blockOutsideReads?: boolean
  /** The roots a read may use while `blockOutsideReads` is set: `roots` less the ones only PROJECT settings listed. */
  fenceRoots?: readonly string[]
  /** Path semantics; default the host's. Tests inject. */
  platform?: NodeJS.Platform
  /** Default {@link hostPathFs}. */
  fs?: PathScopeFs
  /** Home directory for `~`; default `os.homedir()`. */
  homeDir?: string
}

/** The permission-rule fields {@link buildPiPathScope} reads (a `MergedClaudeRules` fits). */
export type PathScopeRules = Pick<ClaudePermissions, 'additionalDirectories'> & {
  /** The entries of `additionalDirectories` NOT sourced from project settings (provenance for the read block). */
  nonProjectAdditionalDirectories?: readonly string[]
  blockReadsOutsideWorkingDirectories?: boolean
}

export interface PiPathScopeInput {
  cwd: string
  rules: PathScopeRules
  scratchpad?: string
  projectTemp?: string
  platform?: NodeJS.Platform
  fs?: PathScopeFs
  homeDir?: string
}

/**
 * Path semantics for a session in `cwd`, by the cwd's own syntax (as the rule matcher and
 * `isAgentControlTarget` read it): a drive-letter or UNC cwd is win32, anything else POSIX — on a
 * Windows host too, where a POSIX-looking cwd is a fixture or a remote one, and mixing the host's
 * flavor into it would resolve `/repo/x` to `D:\repo\x` beside rules that read it as POSIX.
 */
export function platformForCwd(cwd: string): NodeJS.Platform {
  if (/^[a-zA-Z]:[\\/]/.test(cwd) || cwd.startsWith('\\\\')) return 'win32'
  return process.platform === 'win32' ? 'linux' : process.platform
}

/**
 * The scope for a session or target in `cwd` under `rules`. Additional directories are resolved
 * against `cwd` (`~` expanded; a relative entry is relative to the cwd), blanks dropped, repeats
 * folded. While the read block is set, the entries only PROJECT settings listed do not count for
 * reads (a checked-in `.claude/settings.json` must not widen the fence the user set): Claude Code
 * does the same (`d5n`). Without provenance (`nonProjectAdditionalDirectories` absent) every entry counts.
 */
export function buildPiPathScope(input: PiPathScopeInput): PiPathScope {
  const platform = input.platform ?? platformForCwd(input.cwd)
  const additional = resolveAdditionalDirectories(input.rules.additionalDirectories, input.cwd)
  const roots = uniqueDirs([input.cwd, ...additional], undefined, platform)
  const block = input.rules.blockReadsOutsideWorkingDirectories === true
  const trusted = input.rules.nonProjectAdditionalDirectories
  const fenceRoots =
    block && trusted !== undefined
      ? uniqueDirs(
          [input.cwd, ...resolveAdditionalDirectories(trusted, input.cwd)],
          undefined,
          platform
        )
      : roots
  return {
    cwd: input.cwd,
    roots,
    ...(input.projectTemp ? { readRoots: [input.projectTemp] } : {}),
    ...(input.scratchpad ? { scratchpad: input.scratchpad } : {}),
    ...(block ? { blockOutsideReads: true, fenceRoots } : {}),
    platform,
    ...(input.fs ? { fs: input.fs } : {}),
    ...(input.homeDir ? { homeDir: input.homeDir } : {})
  }
}

// ---------------------------------------------------------------------------
// Landing (realpath with a missing leaf)
// ---------------------------------------------------------------------------

/** `resolved`: the path exists. `missing-leaf`: it does not, but every ancestor resolves. `unresolved`: it cannot be told. */
export type PathState = 'resolved' | 'missing-leaf' | 'unresolved'

interface Landing {
  state: PathState
  landing?: string
}

/**
 * Where `abs` really is. The deepest existing ancestor is `realpath`ed and the missing tail
 * appended. Anything that is not a plain "no such entry" — permission denied, a link loop, an
 * entry that exists but will not resolve (a dangling link, at the leaf or anywhere in the
 * chain) — is `unresolved`: the caller never auto-allows what it cannot place.
 */
function landingOf(abs: string, fs: PathScopeFs, flavor: Flavor): Landing {
  let current = abs
  const tail: string[] = []
  for (;;) {
    try {
      const real = fs.realpath(current)
      return tail.length === 0
        ? { state: 'resolved', landing: real }
        : { state: 'missing-leaf', landing: flavor.join(real, ...tail.reverse()) }
    } catch (err) {
      if (!isMissing(err)) return { state: 'unresolved' }
    }
    // realpath said "no such entry": a truly missing component, or a link whose target is
    // missing. lstat tells them apart — a link entry exists.
    try {
      fs.lstat(current)
      return { state: 'unresolved' }
    } catch (err) {
      if (!isMissing(err)) return { state: 'unresolved' }
    }
    const parent = flavor.dirname(current)
    if (parent === current) return { state: 'unresolved' }
    tail.push(flavor.basename(current))
    current = parent
  }
}

// ---------------------------------------------------------------------------
// Windows path forms
// ---------------------------------------------------------------------------

const DOS_DEVICE = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9]|conin\$|conout\$)(?:\..*)?$/i

/**
 * Win32 spellings that name a different object than they look like (R8): a component with a
 * trailing dot or space (the Win32 layer strips it: `.. ` is `..`), an alternate data stream
 * (`:`), a DOS device name with or without an extension, a `...` run, the `\\?\` and `\\.\`
 * namespaces, and UNC / WebDAV (`\\server`, `//server`). `abs` is an already-resolved win32 path.
 */
export function suspiciousWindowsPath(abs: string): boolean {
  if (abs.startsWith('\\\\') || abs.startsWith('//')) return true
  const { root } = path.win32.parse(abs)
  return abs
    .slice(root.length)
    .split(/[\\/]+/)
    .filter((c) => c.length > 0)
    .some((c) => /[. ]$/.test(c) || c.includes(':') || DOS_DEVICE.test(c) || /^\.{3,}$/.test(c))
}

// ---------------------------------------------------------------------------
// Facts
// ---------------------------------------------------------------------------

/** pi's six path tools. Everything else (bash, mcp, hosted tools, …) is outside this module. */
const PATH_TOOLS: ReadonlySet<string> = new Set(['read', 'edit', 'write', 'grep', 'find', 'ls'])
const SEARCH_TOOLS: ReadonlySet<string> = new Set(['grep', 'find', 'ls'])

export function isPiPathTool(toolName: string): boolean {
  return PATH_TOOLS.has(toolName)
}

export interface PiPathFacts {
  tool: string
  /** `edit` / `write`: the call changes the file. */
  write: boolean
  /** The `path` argument as the model wrote it (empty when absent). */
  raw: string
  /** The canonical absolute path pi opens (for `read`, the variant pi's fallback picks). The pin. */
  execPath: string
  /** Does the call carry a `path` string (or is it a search tool, whose default is the cwd)? Only then is it pinned. */
  pinnable: boolean
  state: PathState
  /** The real location (symlinks and junctions followed; a missing tail appended). Undefined when `unresolved`. */
  landing?: string
  /** The leaf is itself a symbolic link / junction (edit/write only). */
  leafIsSymlink: boolean
  /** Every spelling (lexical, landing) is inside a root this tool may use. */
  inScope: boolean
  /** Every spelling is inside the scratchpad (as spelled). */
  inScratchpad: boolean
  /** Every spelling is inside what the read block allows (cwd + non-project additional dirs, scratchpad, project temp). */
  inFence: boolean
  /** Lexically inside the workspace, but the real landing is not: a link carried it out. */
  carriedOut: boolean
  /** (edit/write) some spelling is an agent-control path. */
  sensitive: boolean
  /** (win32) a path form that may name another object than it shows — see {@link suspiciousWindowsPath}. */
  suspiciousWindows: boolean
}

/** Is `target` equal to, or under, `root`? Platform-flavored (win32: case-insensitive, drive/UNC aware). */
function insideRoot(target: string, root: string, flavor: Flavor): boolean {
  const rel = flavor.relative(root, target)
  if (rel === '') return true
  if (rel === '..' || rel.startsWith(`..${flavor.sep}`)) return false
  return !flavor.isAbsolute(rel)
}

function samePath(a: string, b: string, platform: NodeJS.Platform): boolean {
  return platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b
}

function unique(values: readonly string[], platform: NodeJS.Platform): string[] {
  const out: string[] = []
  for (const v of values) if (!out.some((o) => samePath(o, v, platform))) out.push(v)
  return out
}

/**
 * The facts for one pi path-tool call, or undefined for any other tool. `scope.fs` is touched
 * synchronously (a handful of `realpath` / `lstat` calls); nothing is cached, so two calls see two
 * moments of the filesystem — {@link withPathGuard} relies on that.
 */
export function pathFacts(
  toolName: string,
  input: Record<string, unknown>,
  scope: PiPathScope
): PiPathFacts | undefined {
  if (!PATH_TOOLS.has(toolName)) return undefined
  const platform = scope.platform ?? process.platform
  const flavor = flavorOf(platform)
  const fs = scope.fs ?? hostPathFs
  const home = scope.homeDir ?? homedir()
  const write = toolName === 'edit' || toolName === 'write'
  const search = SEARCH_TOOLS.has(toolName)
  const arg = input.path
  const pinnable = typeof arg === 'string' || (search && arg === undefined)
  // pi's search tools default a missing or empty `path` to the cwd (`searchDir || "."`).
  const raw = typeof arg === 'string' ? (search && arg === '' ? '.' : arg) : search ? '.' : ''

  const blank: PiPathFacts = {
    tool: toolName,
    write,
    raw: typeof arg === 'string' ? arg : '',
    execPath: scope.cwd,
    pinnable: false,
    state: 'unresolved',
    leafIsSymlink: false,
    inScope: false,
    inScratchpad: false,
    inFence: false,
    carriedOut: false,
    sensitive: false,
    suspiciousWindows: false
  }
  if (typeof arg !== 'string' && !(search && arg === undefined)) return blank

  let execPath: string
  try {
    const resolved = piResolvePath(raw, scope.cwd, platform, home)
    execPath = toolName === 'read' ? readCandidate(resolved, (p) => fs.exists(p)) : resolved
  } catch {
    // pi would throw on this input too (an unusable `file://`): it never reaches a file.
    return { ...blank, raw: typeof arg === 'string' ? arg : '' }
  }

  const { state, landing } = landingOf(execPath, fs, flavor)
  let leafIsSymlink = false
  if (write) {
    try {
      leafIsSymlink = fs.lstat(execPath).isSymbolicLink()
    } catch {
      /* absent or unreadable: not a link we can see */
    }
  }
  const suspiciousWindows = platform === 'win32' && suspiciousWindowsPath(execPath)
  const spellings = unique(landing === undefined ? [execPath] : [execPath, landing], platform)

  const variantsOf = (root: string): string[] => {
    const abs = flavor.resolve(root)
    const real = landingOf(abs, fs, flavor).landing
    return unique(real === undefined ? [abs] : [abs, real], platform)
  }
  const everyInside = (targets: readonly string[], roots: readonly string[]): boolean =>
    targets.every((t) => roots.some((r) => insideRoot(t, r, flavor)))

  const rootVariants = scope.roots.flatMap(variantsOf)
  const scratch = scope.scratchpad ? [flavor.resolve(scope.scratchpad)] : []
  const readOnly = (scope.readRoots ?? []).map((r) => flavor.resolve(r))
  const reach = [...rootVariants, ...scratch, ...(write ? [] : readOnly)]
  const fenceVariants = (scope.fenceRoots ?? scope.roots).flatMap(variantsOf)

  // A Windows path form that can name another object is never "inside" for a read: it is the
  // plain outside-read row (the write side is human-only, see the ladder).
  const trusted = !suspiciousWindows || write
  const inScope = trusted && state !== 'unresolved' && everyInside(spellings, reach)
  const inScratchpad = trusted && state !== 'unresolved' && everyInside(spellings, scratch)
  const inFence =
    trusted &&
    state !== 'unresolved' &&
    everyInside(spellings, [...fenceVariants, ...scratch, ...readOnly])
  const carriedOut =
    trusted &&
    state !== 'unresolved' &&
    !inScope &&
    landing !== undefined &&
    everyInside([execPath], reach)

  let sensitive = false
  if (write) {
    const cwdVariants = variantsOf(scope.cwd)
    const spellingSensitive = (sp: string): boolean => {
      const under = cwdVariants.find((cv) => insideRoot(sp, cv, flavor))
      return isAgentControlPath(under === undefined ? sp : flavor.relative(under, sp))
    }
    // The written spelling too when it is relative: `a/../.git/config` folds to a name the
    // component scan sees only on the unfolded form.
    const unfolded =
      !flavor.isAbsolute(raw) && !raw.startsWith('~') && !raw.includes('://')
        ? isAgentControlPath(raw.replace(UNICODE_SPACES, ' ').replace(/^@/, ''))
        : false
    sensitive = unfolded || spellings.some(spellingSensitive)
  }

  return {
    tool: toolName,
    write,
    raw: typeof arg === 'string' ? arg : '',
    execPath,
    pinnable,
    state,
    ...(landing === undefined ? {} : { landing }),
    leafIsSymlink,
    inScope,
    inScratchpad,
    inFence,
    carriedOut,
    sensitive,
    suspiciousWindows
  }
}

/** The facts that decide a verdict, compared across a delayed approval (R15). */
export function sameFacts(a: PiPathFacts, b: PiPathFacts, platform: NodeJS.Platform): boolean {
  const same = (x: string | undefined, y: string | undefined): boolean =>
    x === undefined || y === undefined ? x === y : samePath(x, y, platform)
  return (
    same(a.execPath, b.execPath) &&
    same(a.landing, b.landing) &&
    a.state === b.state &&
    a.leafIsSymlink === b.leafIsSymlink &&
    a.inScope === b.inScope &&
    a.inScratchpad === b.inScratchpad &&
    a.inFence === b.inFence &&
    a.carriedOut === b.carriedOut &&
    a.sensitive === b.sensitive &&
    a.suspiciousWindows === b.suspiciousWindows
  )
}

// ---------------------------------------------------------------------------
// Messages
// ---------------------------------------------------------------------------

/** Claude's wording for a leaf symlink write (cli.js `Refusing to write … symbolic link`). */
export function symlinkWriteMessage(p: string): string {
  return `Refusing to write ${p}: it is a symbolic link. Write to the link's target path instead`
}

/** The read-block deny (Claude's `Jl`), pointed at ClaudeUI's setting for adding a directory. */
export function readBlockMessage(facts: PiPathFacts, scope: PiPathScope): string {
  if (facts.state === 'unresolved') {
    return `The location of ${facts.raw || facts.execPath} could not be determined; the permissions.blockReadsOutsideWorkingDirectories setting blocks reads that cannot be placed inside the working directories.`
  }
  const roots = (scope.fenceRoots ?? scope.roots).join(', ')
  const where =
    facts.carriedOut && facts.landing
      ? `${facts.execPath} resolves to ${facts.landing}, which is outside ${roots}`
      : `${facts.execPath} is outside ${roots}`
  return `${where}; the permissions.blockReadsOutsideWorkingDirectories setting blocks reads outside the working directories. Ask the user to add the directory to permissions.additionalDirectories, or to remove that setting.`
}

/** The card line for a human-only ask. */
export function humanOnlyMessage(facts: PiPathFacts): string {
  if (facts.state === 'unresolved') {
    return `The location of ${facts.raw || facts.execPath} could not be determined (permission denied, a symbolic-link loop, or a dangling link), so it needs your approval.`
  }
  if (facts.suspiciousWindows) {
    return `${facts.execPath} uses a Windows path form that can name a different file than it shows, so it needs your approval.`
  }
  return `${facts.execPath} reaches ${facts.landing ?? 'a location'} through a symbolic link, outside the working directories, so it needs your approval.`
}

// ---------------------------------------------------------------------------
// Pin + revalidation
// ---------------------------------------------------------------------------

export const PATH_CHANGED_REASON = 'Denied: the path changed while awaiting approval'

/** The decision shape pi's bridge takes (`PiBridgeHost.GateDecision`, structurally). */
type GuardDecision =
  | { behavior: 'allow'; updatedInput?: Record<string, unknown> }
  | { behavior: 'deny'; reason?: string }

/**
 * Wrap one gate run for a path-tool call:
 *
 *  - an ALLOW (whoever gave it: the ladder, a rule, the judge, a human) carries `updatedInput`
 *    with `path` replaced by the canonical absolute path that was gated (R2). pi opens exactly
 *    that, so a normaliser that drifts from pi's can only cost an ask, never open another file.
 *    pi shows the model's original arguments in its transcript (the hook mutates a clone: the
 *    `tool_call` extension event and the tool itself see the rewritten path).
 *  - the facts are taken again once the decision has settled; if anything that decides a verdict
 *    changed — the landing, a link appearing or going, the scope class — while a human sat on the
 *    card, the call is denied (R15) instead of running against a path nobody approved.
 *
 * Passes every other call through untouched. No scope = no guard (Codex, other engines).
 */
export async function withPathGuard<D extends GuardDecision>(
  toolName: string,
  input: Record<string, unknown>,
  scope: PiPathScope | undefined,
  run: () => Promise<D>
): Promise<D | { behavior: 'deny'; reason: string }> {
  const before = scope ? pathFacts(toolName, input, scope) : undefined
  const decision = await run()
  if (!scope || !before || decision.behavior !== 'allow') return decision
  const after = pathFacts(toolName, input, scope)
  if (!after || !sameFacts(before, after, scope.platform ?? process.platform)) {
    return { behavior: 'deny', reason: PATH_CHANGED_REASON }
  }
  if (!after.pinnable) return decision
  return {
    ...decision,
    updatedInput: { ...(decision.updatedInput ?? input), path: after.execPath }
  } as D
}
