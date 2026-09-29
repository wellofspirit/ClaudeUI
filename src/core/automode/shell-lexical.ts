/**
 * Pure, text-only helpers over shell commands and paths, shared by
 * `ground-truth.ts` (redirect analysis) and `read-only.ts` (the ADR-084 static
 * bypass).
 *
 * They live apart from `ground-truth.ts` because that module imports
 * `node:child_process` and `node:os` for its captures, and the read-only
 * checker must stay pure so it can run wherever the command runs (ADR-084 §1).
 * Nothing here touches the filesystem or the environment: `platform` is
 * always a parameter, so each branch is testable on any OS.
 */

/**
 * Permission categories whose input carries a raw shell command string. Kept
 * here rather than in the engine wiring so both engines share one list.
 */
const SHELL_CATEGORIES = new Set(['bash', 'shell'])

/** True when `toolName` is a shell tool, whatever its command looks like. */
export function isShellToolName(toolName: string): boolean {
  return SHELL_CATEGORIES.has(toolName.toLowerCase())
}

/** The shell command a proposed action would run, or `null` if it is not one. */
export function shellCommandOf(
  toolName: string,
  input: Record<string, unknown> | undefined
): string | null {
  if (!isShellToolName(toolName)) return null
  const command = input?.command
  return typeof command === 'string' && command.trim().length > 0 ? command : null
}

/** `\` → `/`, collapsed slashes, and (win32 only) the Git-Bash `/d/x` spelling
 *  folded onto `d:/x`. Gated on platform because `/e/tc` is a real directory on
 *  Linux; `platform` is injectable so both branches are testable anywhere. */
export function toPosixish(raw: string, platform: NodeJS.Platform): string {
  let s = raw.replace(/\\/g, '/').replace(/\/{2,}/g, '/')
  if (platform === 'win32') {
    const msys = /^\/([A-Za-z])(\/|$)/.exec(s)
    if (msys) s = `${msys[1]}:${s.slice(2) || '/'}`
  }
  return s
}

export function isAbsolutePosixish(s: string, platform: NodeJS.Platform): boolean {
  if (s.startsWith('/')) return true
  return platform === 'win32' && /^[A-Za-z]:\//.test(s)
}

export interface NormalizedPath {
  /** Canonical comparison form, e.g. `d:/repo/build.log` or `/repo/build.log`. */
  full: string
  /** Path components, drive prefix excluded — what the protected-name check reads. */
  components: string[]
}

/**
 * Resolve+normalize without `node:path`, so a test's verdict does not depend on
 * the OS running it (the whole point of the injectable `platform`). `.` and `..`
 * are collapsed textually — there are no symlinks to consult, and a `..` that
 * climbs past the root simply stops there.
 */
export function normalizePath(raw: string, platform: NodeJS.Platform): NormalizedPath {
  const s = toPosixish(raw, platform)
  let drive = ''
  let rest = s
  if (platform === 'win32') {
    const m = /^([A-Za-z]:)(\/|$)/.exec(s)
    if (m) {
      drive = m[1].toLowerCase()
      rest = s.slice(m[1].length)
    }
  }
  const absolute = rest.startsWith('/')
  const components: string[] = []
  for (const part of rest.split('/')) {
    if (part === '' || part === '.') continue
    if (part === '..') {
      components.pop()
      continue
    }
    components.push(part)
  }
  return { full: drive + (absolute || drive ? '/' : '') + components.join('/'), components }
}

/** Resolve a possibly-relative target against `cwd`, both in posix-ish form. */
export function resolveTarget(
  cwd: string,
  target: string,
  platform: NodeJS.Platform
): NormalizedPath {
  const t = toPosixish(target, platform)
  if (isAbsolutePosixish(t, platform)) return normalizePath(t, platform)
  return normalizePath(`${toPosixish(cwd, platform).replace(/\/+$/, '')}/${t}`, platform)
}

/** True iff `target` is a PROPER descendant of `root` (root-equal is not inside,
 *  mirroring {@link isPathInside} in services/path-containment.ts). */
export function isDescendant(root: string, target: string, platform: NodeJS.Platform): boolean {
  const fold = (s: string): string => (platform === 'win32' ? s.toLowerCase() : s)
  const r = fold(root).replace(/\/+$/, '')
  return fold(target).startsWith(`${r}/`)
}
