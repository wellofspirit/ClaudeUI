/**
 * Claude path specifiers (`Read(…)`, `Edit(…)`) → the resource globs opencode
 * 2.x matches file asks against (ADR-097 §3, S6). Pure.
 *
 * ## How 2.x names a file (`vendor/opencode-src/packages/core/src/file-access.ts` `resolve`)
 *
 * A file inside the session directory OR the session's git worktree is asked
 * as `path.relative(sessionDir, file)` with forward slashes — so a file in the
 * worktree but outside a sub-directory session is `../secrets/k.pem`. Any
 * other file is asked by its absolute path. Matching is `Wildcard.match`: `*`
 * crosses `/`, so `**\/x` needs at least one `/` and misses a top-level `x`.
 *
 * ## Deny and ask rules: every form the resolver can produce (conservative)
 *
 * A deny that misses its file is a silent allow, so deny/ask rules compile to
 * every spelling of the files they cover:
 * - an absolute rule (`//abs`, `~/x`, `C:\x`): the absolute form, plus the
 *   relative form against the session directory AND each of its ancestors
 *   (`../`-prefixed) whose subtree the rule's literal prefix lies in — the
 *   worktree root is one of them, wherever it is. A form for an ancestor above
 *   the worktree only ever matches the same file (2.x asks outside files
 *   absolutely), so it never denies anything else;
 * - when the session directory sits INSIDE the rule's glob (`//**\/prod.yaml`,
 *   `//repo/**\/x` with cwd `/repo/pkg`): also the glob part on its own;
 * - every `**\/` may also match zero directories (Claude's gitignore reading):
 *   `**\/x` also emits `x`, `a/**\/b` also `a/b`;
 * - a settings-relative rule (`/x` — relative to the settings file's project
 *   in Claude Code): the verbatim form plus `x` resolved against each project
 *   root it may mean (the session directory and the git worktree root), both
 *   then expanded as an absolute rule. The merged rule set no longer records
 *   which settings file a rule came from, so every candidate root is covered.
 *
 * ## Allow rules: precise, never widened
 *
 * An allow keeps its own spelling: the absolute form plus its relative form
 * only when it lies literally under the session directory; a relative rule as
 * written; a settings-relative `/x` verbatim (inert, as in 1.x). An allow that
 * misses only costs an ask.
 */
import { homedir } from 'node:os'

export interface PathCompileContext {
  /** Home directory for `~` (default `os.homedir()`). */
  home?: string
  /** The session directory (absolute). */
  cwd?: string
  /** The session's git worktree root, when known (a settings-relative root candidate). */
  worktree?: string
  /** Fold case when comparing directories (default: on win32). */
  caseInsensitive?: boolean
}

const GLOB = /[*?]/
const slash = (value: string): string => value.replaceAll('\\', '/')
const trimTrailing = (value: string): string =>
  value.length > 1 ? value.replace(/\/+$/, '') : value

function isWindowsAbsolute(spec: string): boolean {
  return /^[A-Za-z]:[\\/]/.test(spec) || spec.startsWith('\\\\')
}

/** A Claude specifier's absolute form, or `null` for a relative / settings-relative one. */
export function absoluteSpecifier(spec: string, home: string = homedir()): string | null {
  if (spec.startsWith('//')) return slash(spec.slice(1))
  if (spec === '~') return trimTrailing(slash(home))
  if (spec.startsWith('~/') || spec.startsWith('~\\'))
    return `${trimTrailing(slash(home))}/${slash(spec.slice(2))}`
  if (isWindowsAbsolute(spec)) return slash(spec)
  return null
}

/** `dir` and its ancestors, nearest first (`''` is the POSIX root, `C:` a drive root). */
function ancestors(dir: string): string[] {
  const out: string[] = []
  let current = trimTrailing(slash(dir))
  if (current === '/') current = ''
  for (;;) {
    out.push(current)
    const cut = current.lastIndexOf('/')
    if (cut < 0) break
    current = current.slice(0, cut)
  }
  return out
}

function under(path: string, dir: string, fold: boolean): boolean {
  const p = fold ? path.toLowerCase() : path
  const d = fold ? dir.toLowerCase() : dir
  if (d === '') return p.startsWith('/')
  return p === d || p.startsWith(`${d}/`)
}

const relativeTo = (path: string, dir: string): string =>
  dir === '' ? path.slice(1) : path.slice(dir.length + 1)

/** Every way of letting each `**\/` match zero directories (first four occurrences). */
function zeroDirVariants(pattern: string): string[] {
  const starts: number[] = []
  for (
    let i = pattern.indexOf('**/');
    i >= 0 && starts.length < 4;
    i = pattern.indexOf('**/', i + 3)
  )
    if (i === 0 || pattern[i - 1] === '/') starts.push(i)
  const out: string[] = []
  for (let mask = 1; mask < 1 << starts.length; mask++) {
    let result = ''
    let from = 0
    starts.forEach((start, bit) => {
      if (!(mask & (1 << bit))) return
      result += pattern.slice(from, start)
      from = start + 3
    })
    result += pattern.slice(from)
    if (result) out.push(result)
  }
  return out
}

/** Every resource an ABSOLUTE deny/ask pattern may be asked with from `cwd`. */
function conservativeAbsolute(abs: string, cwd: string | undefined, fold: boolean): string[] {
  const out = [abs]
  if (cwd === undefined) return out
  const segments = abs.split('/')
  const firstGlob = segments.findIndex((segment) => GLOB.test(segment))
  const literal = firstGlob < 0 ? abs : segments.slice(0, firstGlob).join('/')
  ancestors(cwd).forEach((dir, depth) => {
    if (!under(literal, dir, fold)) return
    const rest = relativeTo(abs, dir)
    const up = '../'.repeat(depth)
    out.push(rest ? `${up}${rest}` : depth === 0 ? '.' : up.slice(0, -1))
  })
  if (firstGlob >= 0 && under(trimTrailing(slash(cwd)), literal, fold)) {
    out.push(segments.slice(firstGlob).join('/'))
  }
  return out
}

/**
 * A Claude path specifier → the 2.x resources for `read`/`edit`. `conservative`
 * is set for deny and ask rules (see the module doc); allows stay precise.
 */
export function pathResources(
  specifier: string,
  ctx: PathCompileContext,
  conservative: boolean
): string[] {
  const home = ctx.home ?? homedir()
  const fold = ctx.caseInsensitive ?? process.platform === 'win32'
  const cwd = ctx.cwd ? trimTrailing(slash(ctx.cwd)) : undefined
  const out: string[] = []
  const add = (value: string) => {
    if (value && !out.includes(value)) out.push(value)
  }
  const abs = absoluteSpecifier(specifier, home)

  if (!conservative) {
    if (abs !== null) {
      add(abs)
      if (cwd && abs.startsWith(`${cwd}/`) && abs.length > cwd.length + 1)
        add(abs.slice(cwd.length + 1))
    } else {
      add(specifier.startsWith('./') ? specifier.slice(2) : slash(specifier))
    }
    return out
  }

  if (abs !== null) {
    conservativeAbsolute(abs, cwd, fold).forEach(add)
  } else if (specifier.startsWith('/')) {
    add(slash(specifier))
    const roots = [cwd, ctx.worktree ? trimTrailing(slash(ctx.worktree)) : undefined]
    for (const root of new Set(roots.filter((r): r is string => !!r)))
      conservativeAbsolute(`${root}${slash(specifier)}`, cwd, fold).forEach(add)
  } else {
    add(specifier.startsWith('./') ? slash(specifier.slice(2)) : slash(specifier))
  }
  for (const pattern of [...out]) zeroDirVariants(pattern).forEach(add)
  return out
}
