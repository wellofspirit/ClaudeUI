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
 * Network paths are never touched. A Windows path that is UNC / WebDAV / an extended-namespace form
 * (`\\host\share\x`, `//host/share/x`, `file://host/share/x`, `\\host@SSL\DavWWWRoot\x`,
 * `\\?\UNC\…`, `\\?\C:\…`, `\\.\…`: every spelling that resolves to a `\\` prefix), and a path
 * that reaches one through a link, is placed with NO filesystem call at all: an `exists`,
 * `realpath` or `lstat` on it would make the gate itself speak SMB / WebDAV (an NTLM
 * authentication to a host the model named) before any decision. Such a path is `unresolved` and
 * `remote`, hence a human-only ask. `\\?\C:\…` is a local path in disguise, but the namespace
 * prefixes are refused wholesale: nothing legitimate needs them, and "no call" is the safe side.
 * The POSIX counterpart is the automount / kernel-redirect namespaces ({@link isPosixNamespacePath}):
 * `/net/<host>/…` (autofs `-hosts`: a DNS lookup and an NFS mount of a host the model named) on
 * every POSIX platform and, on darwin, `/Network/…`, `/.vol/…`, `/.file/…`, `/.nofollow/…`,
 * `/.resolve/…` — placed from the spelling alone, on every spelling (read variants, additional
 * directories) and through the link walk (`lstat` + `readlink` only, a link whose target text is
 * one of them is unplaceable before any `realpath`), like Claude Code's `vze` / `Iy`.
 * A win32 path with a DOS device component (`CON`, `NUL`, `COM1`, … with or without an extension)
 * is treated the same way (`device`): opening one touches hardware, so it is placed from its
 * spelling alone and is a human-only ask for a read as well as a write.
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
import { accessSync, constants, lstatSync, readlinkSync, realpathSync } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import type { ClaudePermissions } from '../../shared/types'
import { isAgentControlPath } from '../automode/agent-control-paths'
import { uniqueDirs } from '../services/additional-directories'

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
  /** A link's own target text, unresolved (`readlink`). Only called on an entry `lstat` said is a link. */
  readlink(p: string): string
  /** Does the path exist, following links (`access(F_OK)`)? */
  exists(p: string): boolean
}

export const hostPathFs: PathScopeFs = {
  realpath: (p) => realpathSync.native(p),
  lstat: (p) => lstatSync(p),
  readlink: (p) => readlinkSync(p),
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
   * Read-only roots (the project temp dir `<tmp>/claudeui[-<uid>]/<project-key>/`). Compared AS SPELLED,
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
  const flavor = flavorOf(platform)
  const home = input.homeDir ?? homedir()
  // Resolved with the SCOPE's path flavor and home (not the host's): a win32 scope's `\\host\share`
  // entry stays UNC — a remote root, never probed — whatever host builds the scope.
  const resolveEntries = (entries: readonly (string | null | undefined)[] | undefined): string[] =>
    (entries ?? [])
      .filter((e): e is string => typeof e === 'string' && e.trim() !== '')
      .map((e) => {
        const entry = e.trim()
        const expanded =
          entry === '~'
            ? home
            : entry.startsWith('~/') || entry.startsWith('~\\')
              ? flavor.join(home, entry.slice(2))
              : entry
        return flavor.resolve(input.cwd, expanded)
      })
  const additional = resolveEntries(input.rules.additionalDirectories)
  const roots = uniqueDirs([input.cwd, ...additional], undefined, platform)
  const block = input.rules.blockReadsOutsideWorkingDirectories === true
  const trusted = input.rules.nonProjectAdditionalDirectories
  const fenceRoots =
    block && trusted !== undefined
      ? uniqueDirs([input.cwd, ...resolveEntries(trusted)], undefined, platform)
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
 * A win32 path (already resolved: `//h/s` has become `\\h\s`) that names a network share or an
 * object namespace: anything that starts with two separators — UNC, WebDAV (`\\h@SSL\DavWWWRoot`),
 * `\\?\UNC\`, `\\?\C:\`, `\\.\`.
 */
export function isRemoteWindowsPath(p: string): boolean {
  return /^[\\/]{2}/.test(p)
}

/**
 * A local object-namespace spelling, `\\?\C:\x` (extended-length) or `\\.\PhysicalDrive0` (device
 * namespace): two leading separators but no host. `\\?\UNC\h\s` names a host and is not one.
 */
function isLocalNamespacePath(p: string): boolean {
  return /^[\\/]{2}[?.][\\/]/.test(p) && !/^[\\/]{2}[?.][\\/]UNC(?:[\\/]|$)/i.test(p)
}

/** A link target as `readlink` spells it that must not be opened: two leading separators, or the NT `\??\` prefix. */
const REMOTE_LINK_TARGET = /^(?:[\\/]{2}|\\\?\?\\)/

const MAX_LINK_HOPS = 40

/** Zero-width and bidi control characters Claude's `eO` strips before it compares a path component. */
const INVISIBLE_CHARS = /[\u200c-\u200f\u202a-\u202e\u206a-\u206f\ufeff]/g

/** Darwin's network / kernel-redirect first components (besides `net`, which is every POSIX): see {@link isPosixNamespacePath}. */
const DARWIN_NAMESPACE_ROOTS: ReadonlySet<string> = new Set([
  'network',
  '.vol',
  '.file',
  '.nofollow',
  '.resolve'
])

/**
 * A POSIX path (already resolved) under an automount map or a kernel-redirected namespace: merely
 * naming it can make the OS act. `/net/<host>` is the autofs `-hosts` map (a DNS lookup and an NFS
 * mount of whatever host the model named; Linux autofs as well as macOS), `/Network/Servers/…` is
 * macOS's directory-service browse surface, and `/.vol`, `/.file`, `/.nofollow`, `/.resolve` are
 * paths the macOS kernel redirects (by volume id / file id) and that can land on a network mount.
 * Judged from the SPELLING alone, so the gate never touches them. Mirrors Claude Code's checks
 * (cli.js 2.1.308): `vze`'s live ones are `Mw` (bare `/net`) and `Rb` (the `/.vol` family), and `Iy`
 * (called via `Xv` on each link target inside Claude's link walk) adds `Pqe` (`/net/<host>`,
 * `/Network/Servers/<host>`) and `iD` (`/Network`). Claude applies `/Network` and the `/.vol` family on
 * every platform; limiting them to darwin here is a deliberate narrowing (on Linux they are
 * ordinary names). The FIRST component decides, case-insensitively (macOS volumes are
 * case-insensitive by default; on Linux the extra case folding only over-asks, which is the safe
 * side), with `.` / `..` folded and zero-width characters ignored. `/net` is every POSIX platform;
 * the others are darwin only.
 * Always false on win32 (a `/net` there is a drive-relative path).
 */
export function isPosixNamespacePath(abs: string, platform: NodeJS.Platform): boolean {
  if (platform === 'win32' || !abs.startsWith('/')) return false
  const stack: string[] = []
  for (const part of abs.split('/')) {
    if (part === '' || part === '.') continue
    if (part === '..') {
      stack.pop()
      continue
    }
    stack.push(part)
    if (stack.length === 1) {
      const name = part.replace(INVISIBLE_CHARS, '').toLowerCase()
      if (name === 'net' || (platform === 'darwin' && DARWIN_NAMESPACE_ROOTS.has(name))) return true
    }
  }
  return false
}

/**
 * Why a path cannot be placed without risk: it reaches a network path or an automount /
 * kernel-redirect namespace (`remote`), or a DOS device (`device`), or the walk could not read
 * something on the way (`unreadable`: permission denied, a chain past {@link MAX_LINK_HOPS}, …).
 */
type PlacementTrap = 'remote' | 'device' | 'unreadable'

/**
 * Does `abs` (a resolved path that is not itself remote) reach a network path, an automount
 * namespace or a DOS device through a link — a link component, or a link component of a link's
 * target, whose target is remote / in a namespace, or (win32) has a DOS device name as one of its
 * components? The walk uses only `lstat` and `readlink`, each on a path that has just been shown to
 * be local and not a device, so it makes no network call and touches no device. A link it cannot
 * read, an entry whose `lstat` fails for any reason but "no such entry" (EACCES, EPERM, …), or a
 * chain past {@link MAX_LINK_HOPS}, answers 'unreadable': the caller treats the path as
 * unplaceable. Only a missing entry ends the walk with undefined: nothing past it exists to be a link.
 *
 * POSIX walks the way the kernel does, never folding a `..` by text: a link target is first
 * judged on its RAW text, then its components are spliced in front of the parts still to walk,
 * UNNORMALISED, and a `..` is `dirname(current)`. That is valid because every prefix in `current`
 * has already been shown not to be a link, so what `..` climbs to is the textual parent. Folding
 * the target up front (`path.resolve`) would call `/net/h/../../tmp` (`/tmp`) or `a/../b` with
 * `a -> /net/h/q` local, while the kernel follows the link and only then climbs. Every new prefix
 * gets the remote / namespace check. Claude Code's own walk follows-then-climbs on win32 too;
 * we deliberately do not mirror that there.
 *
 * win32 is different, and refuses what it cannot place. The raw target is judged first (UNC / `\??\`
 * -> remote, a DOS device part -> device), and a root that is neither empty nor `X:\` (an NT object
 * path such as `\Device\Mup\h\s`, or `D:foo`) is 'unreadable'. A RELATIVE target with a `..`
 * component is 'unreadable' too. Windows folds a `..` in a target as text against the link's
 * directory for a symlink, but a junction keeps its own spelling (mount-point semantics) and
 * `readlink` returns the same `X:\…` text for both, so what a `..` climbs to depends on a link kind
 * the walk cannot read: with `w\J` a junction to `real0` and `real0\s -> ..\b` the OS reads `w\b`,
 * with `J` a symlink it reads the folder above `real0`, and `realpath` could follow a link the walk
 * never read. A relative target WITHOUT a `..` only descends from the link's physical parent
 * directory, and that directory is the same under every junction or symlink reading, so it is
 * folded as text against the link's directory (`.` and empty parts dropped), checked for a UNC
 * result, and walked from the root of the result. An absolute `X:\…` target is folded the same way
 * (`D:\o\q\..\r` is `D:\o\r`): it names its target outright, so there is no link directory for the
 * two readings to disagree about. The cost is an over-ask for a relative `..` symlink on Windows,
 * which is rare (it needs the privilege, or git `core.symlinks`).
 */
function linkTrap(
  abs: string,
  fs: PathScopeFs,
  platform: NodeJS.Platform
): PlacementTrap | undefined {
  const flavor = flavorOf(platform)
  const win = platform === 'win32'
  // POSIX: a backslash is an ordinary file-name character, not a separator.
  const separators = win ? /[\\/]+/ : /\/+/
  const componentsOf = (text: string): string[] =>
    text.split(separators).filter((c) => c.length > 0)
  const isRemotePrefix = (p: string): boolean =>
    win ? isRemoteWindowsPath(p) : isPosixNamespacePath(p, platform)
  const { root } = flavor.parse(abs)
  let current = root
  // The components still to walk, next one LAST (a stack), so a link's target splices in cheaply.
  const todo = componentsOf(abs.slice(root.length)).reverse()
  let hops = 0
  for (;;) {
    const part = todo.pop()
    if (part === undefined) return undefined
    if (part === '.') continue
    if (part === '..') {
      current = flavor.dirname(current)
      if (isRemotePrefix(current)) return 'remote'
      continue
    }
    current = flavor.join(current, part)
    if (isRemotePrefix(current)) return 'remote'
    let isLink: boolean
    try {
      isLink = fs.lstat(current).isSymbolicLink()
    } catch (err) {
      return isMissing(err) ? undefined : 'unreadable'
    }
    if (!isLink) continue
    if (++hops > MAX_LINK_HOPS) return 'unreadable'
    let target: string
    try {
      target = fs.readlink(current)
    } catch {
      return 'unreadable'
    }
    const base = flavor.dirname(current)
    if (win) {
      // The target's own text, before any component of it is looked at.
      if (REMOTE_LINK_TARGET.test(target)) return 'remote'
      if (hasDosDevicePart(target)) return 'device'
      // A root that is neither empty (a relative target) nor `X:\` cannot be placed from here:
      // `\Device\…`, `\GLOBAL??\…`, `\DosDevices\…` are NT object paths the kernel follows (libuv
      // returns them unchanged), and `D:foo` is relative to the current directory of drive D.
      const { root: winRoot } = flavor.parse(target)
      if (winRoot !== '' && !/^[a-z]:[\\/]$/i.test(winRoot)) return 'unreadable'
      // A relative target that climbs cannot be placed: what its `..` folds against is the link's
      // own spelling for a junction and its target for a symlink, and `readlink` cannot tell them
      // apart. A relative target without one only descends from the link's physical parent.
      if (winRoot === '' && componentsOf(target).includes('..')) return 'unreadable'
      // Fold the rest as text against the link's directory (`D:\o\q\..\r` is `D:\o\r`), then walk
      // what is left from the root of the result.
      const dest = flavor.resolve(base, target)
      if (isRemoteWindowsPath(dest)) return 'remote'
      const { root: destRoot } = flavor.parse(dest)
      current = destRoot
      todo.push(...componentsOf(dest.slice(destRoot.length)).reverse())
      continue
    }
    if (isPosixNamespacePath(target.startsWith('/') ? target : `${base}/${target}`, platform)) {
      return 'remote'
    }
    const { root: targetRoot } = flavor.parse(target)
    current = targetRoot === '' ? base : flavor.resolve(base, targetRoot)
    if (isRemotePrefix(current)) return 'remote'
    todo.push(...componentsOf(target.slice(targetRoot.length)).reverse())
  }
}

/**
 * Would placing `abs` touch the network or a device? A remote spelling (UNC / WebDAV / a namespace
 * on win32; `/net`, and on darwin `/Network` and the `/.vol` family, on POSIX) is answered from the
 * spelling with no fs call; anything else gets the link walk, which looks for a link that leads to
 * one.
 */
function placementTrap(
  abs: string,
  fs: PathScopeFs,
  platform: NodeJS.Platform
): PlacementTrap | undefined {
  if (platform === 'win32' ? isRemoteWindowsPath(abs) : isPosixNamespacePath(abs, platform)) {
    return 'remote'
  }
  return linkTrap(abs, fs, platform)
}

/**
 * Where `abs` really is. The deepest existing ancestor is `realpath`ed and the missing tail
 * appended. Anything that is not a plain "no such entry" — permission denied, a link loop, an
 * entry that exists but will not resolve (a dangling link, at the leaf or anywhere in the
 * chain) — is `unresolved`: the caller never auto-allows what it cannot place.
 */
function landingOf(abs: string, fs: PathScopeFs, platform: NodeJS.Platform): Landing {
  if (placementTrap(abs, fs, platform) !== undefined) return { state: 'unresolved' }
  const flavor = flavorOf(platform)
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

// COM¹ COM² COM³ and LPT¹ LPT² LPT³ (U+00B9, U+00B2, U+00B3) are reserved device names too.
const DOS_DEVICE =
  /^(?:con|prn|aux|nul|com[1-9\u00B9\u00B2\u00B3]|lpt[1-9\u00B9\u00B2\u00B3]|conin\$|conout\$) *(?:[.:].*)?$/i

/** Does any component of the (resolved) win32 path `abs` name a DOS device, with or without an extension? */
function hasDosDevicePart(abs: string): boolean {
  const { root } = path.win32.parse(abs)
  return abs
    .slice(root.length)
    .split(/[\\/]+/)
    .some((c) => DOS_DEVICE.test(c))
}

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
  /** pi's `resolveToCwd` of the argument, before `read`'s variant fallbacks (= `execPath` for every other tool). */
  resolved: string
  /** Does the call carry a `path` string (or is it a search tool, whose default is the cwd)? Only then is it pinned. */
  pinnable: boolean
  state: PathState
  /** The real location (symlinks and junctions followed; a missing tail appended). Undefined when `unresolved`. */
  landing?: string
  /**
   * The landing re-expressed under the logical spelling of each scope root whose real path
   * contains it (cwd `/logical` -> `/physical`: landing `/physical/src/a.ts` -> `/logical/src/a.ts`).
   * The same physical file, spelled the way the user's own rules spell it. Absent / empty when
   * there is no landing or no root is reached through a link.
   */
  landingAliases?: string[]
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
  /**
   * A network / namespace path, or a link to one: placed with no filesystem call, always
   * `unresolved`. win32: UNC, WebDAV, the extended-length and device namespaces. POSIX: `/net/…`
   * (the autofs `-hosts` map) and, on darwin, `/Network/…` and `/.vol`, `/.file`, `/.nofollow`,
   * `/.resolve` ({@link isPosixNamespacePath}).
   */
  remote: boolean
  /** (win32) a component names a DOS device (`CON`, `NUL`, `COM1`, …): placed with no filesystem call, always `unresolved`. */
  device: boolean
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
    resolved: scope.cwd,
    pinnable: false,
    state: 'unresolved',
    leafIsSymlink: false,
    inScope: false,
    inScratchpad: false,
    inFence: false,
    carriedOut: false,
    sensitive: false,
    suspiciousWindows: false,
    remote: false,
    device: false
  }
  if (typeof arg !== 'string' && !(search && arg === undefined)) return blank

  let execPath: string
  let resolved: string
  let remote = false
  let device = false
  let unreadable = false
  // A network path (or one that goes through a link to one), an automount / kernel-redirect
  // namespace (`/net/…`; on darwin `/Network/…`, `/.vol/…`) and a DOS device name are never handed
  // to the filesystem, not even `exists`: opening `\\server\x` authenticates to a host, `/net/h/x`
  // makes autofs resolve and mount `h`, opening `COM1` / `CON` touches hardware. A path whose
  // link chain could not be read is not looked at any further either. The facts are the
  // human-only "unresolved" ones, from the spelling alone. The spellings are judged first: the
  // link walk behind `placementTrap` calls `lstat` on every component, which is a call on the device.
  const unplaceable = (p: string): boolean => {
    if (platform === 'win32' && !isRemoteWindowsPath(p) && hasDosDevicePart(p)) {
      device = true
      return true
    }
    const trap = placementTrap(p, fs, platform)
    if (trap === 'device') device = true
    else if (trap === 'remote') remote = true
    else if (trap === 'unreadable') unreadable = true
    return trap !== undefined
  }
  try {
    resolved = piResolvePath(raw, scope.cwd, platform, home)
    if (unplaceable(resolved)) {
      execPath = resolved
    } else if (toolName === 'read') {
      // Each candidate pi's fallbacks would try gets the same check before it is looked at.
      execPath = readCandidate(resolved, (p) => !unplaceable(p) && fs.exists(p))
    } else {
      execPath = resolved
    }
  } catch {
    // pi would throw on this input too (an unusable `file://`): it never reaches a file.
    return { ...blank, raw: typeof arg === 'string' ? arg : '' }
  }
  if (remote || device || unreadable) {
    return {
      ...blank,
      raw: typeof arg === 'string' ? arg : '',
      execPath,
      resolved,
      pinnable,
      suspiciousWindows: platform === 'win32' && suspiciousWindowsPath(execPath),
      remote,
      device
    }
  }

  const { state, landing } = landingOf(execPath, fs, platform)
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
    const real = landingOf(abs, fs, platform).landing
    return unique(real === undefined ? [abs] : [abs, real], platform)
  }
  const everyInside = (targets: readonly string[], roots: readonly string[]): boolean =>
    targets.every((t) => roots.some((r) => insideRoot(t, r, flavor)))

  // The landing under each root's lexical spelling, for a root that is itself reached through a
  // link (same physical place, so never another file).
  const landingAliases: string[] = []
  if (landing !== undefined) {
    for (const root of scope.roots) {
      const abs = flavor.resolve(root)
      const real = landingOf(abs, fs, platform).landing
      if (
        real === undefined ||
        samePath(abs, real, platform) ||
        !insideRoot(landing, real, flavor)
      ) {
        continue
      }
      landingAliases.push(flavor.join(abs, flavor.relative(real, landing)))
    }
  }

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
    resolved,
    pinnable,
    state,
    ...(landing === undefined ? {} : { landing }),
    ...(landingAliases.length === 0 ? {} : { landingAliases }),
    leafIsSymlink,
    inScope,
    inScratchpad,
    inFence,
    carriedOut,
    sensitive,
    suspiciousWindows,
    remote: false,
    device: false
  }
}

/** The facts that decide a verdict, compared across a delayed approval (R15). */
export function sameFacts(a: PiPathFacts, b: PiPathFacts, platform: NodeJS.Platform): boolean {
  const same = (x: string | undefined, y: string | undefined): boolean =>
    x === undefined || y === undefined ? x === y : samePath(x, y, platform)
  return (
    same(a.execPath, b.execPath) &&
    same(a.landing, b.landing) &&
    // A missing leaf that has appeared (or the reverse) at the same landing decides nothing new.
    (a.state === b.state ||
      (a.state !== 'unresolved' && b.state !== 'unresolved' && a.landing !== undefined)) &&
    a.leafIsSymlink === b.leafIsSymlink &&
    a.inScope === b.inScope &&
    a.inScratchpad === b.inScratchpad &&
    a.inFence === b.inFence &&
    a.carriedOut === b.carriedOut &&
    a.sensitive === b.sensitive &&
    a.suspiciousWindows === b.suspiciousWindows &&
    a.remote === b.remote &&
    a.device === b.device
  )
}

// ---------------------------------------------------------------------------
// Messages
// ---------------------------------------------------------------------------

/** Claude's wording for a leaf symlink write (cli.js `Refusing to write … symbolic link`). */
export function symlinkWriteMessage(p: string): string {
  return `Refusing to write ${p}: it is a symbolic link. Write to the link's target path instead`
}

/**
 * What a `remote` path is called: on POSIX (a resolved path starting with one slash; a Windows one
 * always starts with a drive or two separators) it is an automount / kernel-redirect namespace, not
 * a share, so "a network or automount path"; the Windows UNC wording is kept.
 */
function networkWording(facts: PiPathFacts): string {
  const posix = facts.execPath.startsWith('/') && !facts.execPath.startsWith('//')
  return posix ? 'a network or automount path' : 'a network path'
}

/** The read-block deny (Claude's `Jl`), pointed at ClaudeUI's setting for adding a directory. */
export function readBlockMessage(facts: PiPathFacts, scope: PiPathScope): string {
  if (facts.state === 'unresolved') {
    const fence =
      'the permissions.blockReadsOutsideWorkingDirectories setting blocks reads that cannot be placed inside the working directories.'
    // The same wording as the human-only card: a network / namespace path and a device are never
    // opened to be placed, which is not "could not be determined".
    if (facts.remote) {
      return `${facts.execPath} is ${networkWording(facts)} (or a link to one) and is never opened to check where it lands; ${fence}`
    }
    if (facts.device) {
      return `${facts.execPath} names a Windows device (CON, NUL, COMn, LPTn, …), or is a link to one, and is never opened to check where it lands; ${fence}`
    }
    return `The location of ${facts.raw || facts.execPath} could not be determined; ${fence}`
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
  if (facts.remote && isLocalNamespacePath(facts.execPath)) {
    return `${facts.execPath} is a device or extended-length path (the \\\\?\\ or \\\\.\\ namespace), not a network path. It is never opened to check where it lands, so it needs your approval.`
  }
  if (facts.remote) {
    return `${facts.execPath} is ${networkWording(facts)} (or a link to one). It is never opened to check where it lands, so it needs your approval.`
  }
  if (facts.device) {
    return `${facts.execPath} names a Windows device (CON, NUL, COMn, LPTn, …), or is a link to one. It is never opened to check where it lands, so it needs your approval.`
  }
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

/** Why a gated path could not be handed to pi in a form that is certain to open it (see {@link pinFor}). */
export function pinMismatchReason(execPath: string): string {
  return `Denied: pi would not certainly open ${execPath} as written (it rewrites unicode spaces in a path and resolves a relative path against its own working directory), and no spelling of it is safe to hand over, so it was not opened`
}

/** `rel` is `..` or climbs out of its base: a spelling pi would resolve against a base that may not be ours. */
function climbs(rel: string, flavor: Flavor): boolean {
  return rel === '..' || rel.startsWith(`..${flavor.sep}`)
}

/**
 * The `path` argument to hand pi so that its own `resolveToCwd` lands on exactly `execPath`, the
 * path that was gated; undefined when no spelling does. pi re-resolves whatever it is given, and
 * that folds unicode spaces across the WHOLE string — a cwd, home or temp directory with a U+3000
 * in it included — so the absolute path is only a safe pin when it is a fixed point of the
 * resolution. Otherwise the cwd-relative spelling is tried (the cwd part is then not part of the
 * string, and pi resolves it against its own, unfolded, base), and it too must round-trip AND stay
 * under the cwd: pi's base is `process.cwd()`, the PHYSICAL directory on POSIX, so a `..` that
 * climbs out of a cwd that is (or sits under) a link reaches a different parent than the logical
 * `scope.cwd` this module resolved against.
 */
export function pinFor(execPath: string, resolved: string, scope: PiPathScope): string | undefined {
  const platform = scope.platform ?? process.platform
  const home = scope.homeDir ?? homedir()
  const opens = (candidate: string): string | undefined => {
    try {
      return piResolvePath(candidate, scope.cwd, platform, home)
    } catch {
      return undefined
    }
  }
  const flavor = flavorOf(platform)
  let base: string
  try {
    base = piNormalizePath(scope.cwd, platform, home, {})
  } catch {
    return undefined
  }
  // Spellings that open `target` unchanged: the absolute path, then the cwd-relative one.
  const spelling = (target: string): string | undefined => {
    if (opens(target) === target) return target
    const relative = flavor.relative(base, target) || '.'
    return !climbs(relative, flavor) && opens(relative) === target ? relative : undefined
  }
  const direct = spelling(execPath)
  if (direct !== undefined || resolved === execPath) return direct
  // `read` picked a variant of the resolved path (macOS narrow space, NFD, curly quote) whose
  // spelling pi's folding would change; pi re-derives the same variant from the resolved path.
  return spelling(resolved)
}

/**
 * May the model's own `path` spelling be handed to pi unpinned, when no pin of {@link pinFor}
 * exists? Only a spelling whose meaning does not rest on a base we cannot see:
 *
 *  - it resolves (as pi resolves it) to the path that was gated;
 *  - it is not a RELATIVE spelling that climbs above the cwd after normalisation (`../x`,
 *    `a/../../x`): pi resolves relative paths against `process.cwd()` — the physical directory on
 *    POSIX — while this module used the logical `scope.cwd`, and the two parents differ when the
 *    cwd is, or sits under, a link;
 *  - on win32, it is not drive-relative (`C:x`: pi's per-drive current directory) and not
 *    rooted-driveless (`\x`, `/x`: the drive of pi's cwd, which a session may have changed).
 *
 * `~/x`, `file:///x`, `@/abs` and an absolute path are absolute after normalisation, so they pass.
 */
export function rawSpellingHolds(
  facts: Pick<PiPathFacts, 'raw' | 'execPath' | 'resolved'>,
  scope: PiPathScope
): boolean {
  const platform = scope.platform ?? process.platform
  const home = scope.homeDir ?? homedir()
  const flavor = flavorOf(platform)
  let opened: string
  let normalized: string
  try {
    opened = piResolvePath(facts.raw, scope.cwd, platform, home)
    normalized = piNormalizePath(facts.raw, platform, home, { unicodeSpaces: true, stripAt: true })
  } catch {
    return false
  }
  // Consistency assertion, not a filter: `facts` came from this same `raw`, so pi's resolution of
  // it is the facts' `resolved` (or the `read` variant `execPath`). It can only fail if a caller
  // hands in facts that were not taken from this spelling, and then the answer is no.
  if (opened !== facts.execPath && opened !== facts.resolved) return false
  if (platform === 'win32') {
    if (/^[A-Za-z]:(?![\\/])/.test(normalized)) return false
    if (/^[\\/](?![\\/])/.test(normalized)) return false
  }
  return flavor.isAbsolute(normalized) || !climbs(flavor.normalize(normalized), flavor)
}

/** The decision shape pi's bridge takes (`PiBridgeHost.GateDecision`, structurally). */
type GuardDecision =
  | { behavior: 'allow'; updatedInput?: Record<string, unknown> }
  | { behavior: 'deny'; reason?: string }

/**
 * Wrap one gate run for a path-tool call:
 *
 *  - an ALLOW (whoever gave it: the ladder, a rule, the judge, a human) carries `updatedInput`
 *    with `path` replaced by the path that was gated (R2). The ladder: (1) its canonical absolute
 *    spelling when pi's own re-resolution leaves that unchanged; else (2) the cwd-relative spelling
 *    when THAT round-trips and does not start with `..` ({@link pinFor}); else (3) the model's own
 *    spelling, unpinned, when {@link rawSpellingHolds} (it resolves to the gated path, is not a
 *    relative spelling climbing above the cwd, and on win32 is neither drive-relative nor
 *    rooted-driveless); else (4) the call is denied with {@link pinMismatchReason}. pi opens exactly
 *    what was gated, so a normaliser that drifts from pi's can only cost an ask or a deny, never
 *    open another file.
 *    pi shows the model's original arguments in its transcript (the hook mutates a clone: the
 *    `tool_call` extension event and the tool itself see the rewritten path).
 *  - the facts are taken again once the decision has settled; if anything that decides a verdict
 *    changed — the landing, a link appearing or going, the scope class — while a human sat on the
 *    card, the call is denied (R15) instead of running against a path nobody approved.
 *
 * Passes every other call through untouched. No scope = no guard (other engines).
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
  const pin = pinFor(after.execPath, after.resolved, scope)
  if (pin === undefined) {
    // No rewritten spelling survives pi's folding (a unicode space in a home or temp directory
    // outside the cwd tree). The model's own spelling is what the facts were taken from: pass it
    // through unpinned only where its meaning does not depend on a base pi may see differently.
    return rawSpellingHolds(after, scope)
      ? decision
      : { behavior: 'deny', reason: pinMismatchReason(after.execPath) }
  }
  return {
    ...decision,
    updatedInput: { ...(decision.updatedInput ?? input), path: pin }
  } as D
}

// ---------------------------------------------------------------------------
// "Always allow" rules for an outside path
// ---------------------------------------------------------------------------

const RULE_GLOB_CHARS = /[*?[\]{}()]/

/**
 * `abs` as the ABSOLUTE specifier of a path rule (`//<path>` — a doubled leading slash marks an
 * absolute path in the rule grammar; a Windows drive is `//c/rest`), for the standing-allow rule
 * a card suggests. Undefined where no safe spelling exists: a relative or network path, a
 * filesystem root (nobody means "allow all of it"), or a name with a glob character in it (the
 * rule would over-match).
 */
export function absoluteRuleSpecifier(abs: string, platform: NodeJS.Platform): string | undefined {
  if (RULE_GLOB_CHARS.test(abs)) return undefined
  const flavor = flavorOf(platform)
  if (!flavor.isAbsolute(abs) || flavor.parse(abs).root === abs) return undefined
  if (platform === 'win32') {
    const drive = /^([A-Za-z]):[\\/]+(.+?)[\\/]*$/.exec(abs)
    return drive ? `//${drive[1].toLowerCase()}/${drive[2].replaceAll('\\', '/')}` : undefined
  }
  return `/${abs.replace(/\/+$/, '')}`
}

/**
 * The allow rules to suggest on the card of a path-tool call that asked only because its target
 * is OUTSIDE the workspace: scoped to that location, never the bare tool (which would be a
 * standing allow for the whole disk). A file tool's rule covers its directory — `Read(//<dir>/**)`
 * for `read`, `Edit(//<dir>/**)` for `edit`/`write` (an `Edit` rule governs both) — and a
 * search's covers the searched path itself and everything under it. The rule grammar and which
 * kinds each Claude tool governs are the ladder's (`CLAUDE_TOOL_TO_KINDS`).
 *
 * Undefined when there is nothing safe to offer.
 */
export function outsideAllowRules(
  toolName: string,
  target: string,
  platform: NodeJS.Platform
): Array<{ toolName: string; ruleContent: string }> | undefined {
  if (!PATH_TOOLS.has(toolName)) return undefined
  const claudeTool = toolName === 'edit' || toolName === 'write' ? 'Edit' : 'Read'
  const flavor = flavorOf(platform)
  const dir = SEARCH_TOOLS.has(toolName) ? target : flavor.dirname(target)
  const specifier = absoluteRuleSpecifier(dir, platform)
  if (specifier === undefined) return undefined
  const rules = [{ toolName: claudeTool, ruleContent: `${specifier}/**` }]
  if (SEARCH_TOOLS.has(toolName)) rules.unshift({ toolName: claudeTool, ruleContent: specifier })
  return rules
}

/**
 * The allow rule to suggest on the card of an `edit` / `write` that asked INSIDE the workspace
 * (default mode: edits ask): `Edit(//<root>/**)` for the narrowest workspace root (cwd or an
 * additional directory, as spelled) that contains where the call lands — never the bare `Edit` /
 * `Write` rule, which would be a standing allow for every file the tool can reach, the
 * out-of-workspace ones included. An `Edit` rule governs both tools. Undefined where there is
 * nothing safe to offer: not a file-changing tool, a target the scope does not place inside a
 * root, an agent-control path, or a root with no safe rule spelling (a glob character in its name,
 * a filesystem root). The spellings tried are the ones the allow tier matches: the landing and the
 * landing re-expressed under a root's lexical spelling.
 */
export function workspaceEditRules(
  toolName: string,
  input: Record<string, unknown>,
  scope: PiPathScope
): Array<{ toolName: string; ruleContent: string }> | undefined {
  if (toolName !== 'edit' && toolName !== 'write') return undefined
  const facts = pathFacts(toolName, input, scope)
  if (!facts || !facts.inScope || facts.sensitive || facts.state === 'unresolved') return undefined
  const platform = scope.platform ?? process.platform
  const flavor = flavorOf(platform)
  const spellings = [facts.landing ?? facts.execPath, ...(facts.landingAliases ?? [])]
  let best: string | undefined
  for (const root of scope.roots) {
    const abs = flavor.resolve(root)
    if (!spellings.some((s) => insideRoot(s, abs, flavor))) continue
    if (best === undefined || abs.length > best.length) best = abs
  }
  if (best === undefined) return undefined
  const specifier = absoluteRuleSpecifier(best, platform)
  return specifier === undefined
    ? undefined
    : [{ toolName: 'Edit', ruleContent: `${specifier}/**` }]
}
