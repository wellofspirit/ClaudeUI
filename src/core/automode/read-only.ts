/**
 * ADR-084 §1 — the static read-only path in front of the auto-mode judge.
 *
 * `readOnlyVerdict` decides, from the command TEXT alone, whether a shell call
 * is "plainly read-only and doesn't affect others". A yes lets the engine
 * wiring allow the call without a judge round trip; a no sends it to the judge
 * exactly as before. It is a pure positive filter: every rule fails closed, and
 * the bar is "never allow what the judge would have blocked", not "match the
 * judge".
 *
 * **This module is pure.** No `node:fs`, no `node:child_process`, no
 * environment reads. The one filesystem fact it needs — where a path really
 * lands — arrives through `scope.realpath`, so the check can run wherever the
 * command runs (the host today, a remote task host later).
 *
 * ## Why two views of every token
 *
 * The shell that runs an opencode command is not knowable from here (it may be
 * Git Bash, pwsh or Windows PowerShell), and pi always runs Git Bash. So a
 * command is accepted only if it is safe under BOTH readings:
 *
 * - the **POSIX view**: bash quoting, backslash escapes removed outside single
 *   quotes (`cat .e\nv` reads `.env`);
 * - the **Windows view**: PowerShell quoting (`''` / `""` escapes), backslash is
 *   a path separator, an unquoted comma makes an array.
 *
 * Token BOUNDARIES are forced to agree between the two readings by refusing the
 * few constructs where bash and PowerShell split differently (a backslash before
 * anything but a plain word character, text glued after a closing quote,
 * backticks, `$`). Flags are checked against
 * per-word tables that already hold the intersection of both meanings (the
 * `ls`/`cat` alias words were vetted flag by flag), so there is no dialect guess.
 *
 * ## Layout
 *
 * 1. text hygiene and forbidden characters;
 * 2. the lexer (segments, tokens, both views) — 1 and 2 live in the leaf
 *    `./shell-strict-lexer.ts`, shared with ADR-085's rule matcher;
 * 3. per-segment checks: command name, the pipe-consumer rule, the command's
 *    typed tables; before them, the user's Bash deny/ask rules over the whole
 *    command (ADR-085's matcher, `../permissions/shell-rules.ts`, the same one
 *    the pi and Codex ladders use, so the bypass and the ladder cannot
 *    disagree);
 * 4. path rules (scope, realpath, sensitive names, Read deny rules).
 *
 * Every refusal names the first rule that fired (`token:$`, `flag:rg --pre`,
 * `path:out-of-scope`, …) for the debug log, which is where the allowlist grows
 * from.
 */

import { wildcardMatch } from '../opencode/wildcard'
import { denyAskHit } from '../permissions/shell-rules'
import {
  badCodePoint,
  lex,
  parseRuleText,
  refuse,
  Refusal,
  textHygiene,
  type Tok
} from './shell-strict-lexer'
import {
  isAbsolutePosixish,
  isDescendant,
  isShellToolName,
  normalizePath,
  resolveTarget,
  type NormalizedPath
} from './shell-lexical'

export { parseRuleText } from './shell-strict-lexer'

// ── Public contract ───────────────────────────────────────────────────────────

export interface ReadOnlyScope {
  /** Session cwd. */
  cwd: string
  /** User-granted roots. */
  additionalDirectories: string[]
  /** Path semantics for the Windows view. */
  platform: NodeJS.Platform
  /** The user's merged Claude-syntax rules. */
  rules: { allow?: string[]; ask?: string[]; deny?: string[] }
  /** realpath of an EXISTING path, `undefined` if it does not exist, `null` if it could not be
   *  determined (→ refuse). Injected so the module stays pure and can run where the command runs. */
  realpath: (absPath: string) => string | undefined | null
}

export type ReadOnlyVerdict =
  { ok: true; summary: string; needsGitCheck: boolean } | { ok: false; reason: string }

/** Longest command the checker will look at; anything longer goes to the judge. */
export const READ_ONLY_MAX_LENGTH = 2000
/** Cap on `summary` (the info-log line). */
export const READ_ONLY_SUMMARY_MAX = 160

/**
 * Is this shell call plainly read-only inside the session's scope?
 *
 * Never throws: an unexpected exception is itself a refusal (`internal`).
 */
export function readOnlyVerdict(
  action: { toolName: string; input: Record<string, unknown> },
  scope: ReadOnlyScope
): ReadOnlyVerdict {
  try {
    return check(action, scope)
  } catch (err) {
    if (err instanceof Refusal) return { ok: false, reason: err.reason }
    return { ok: false, reason: 'internal' }
  }
}

// ── Plumbing ──────────────────────────────────────────────────────────────────

/** `'` or `"` anywhere in a raw token. */
const QUOTE_RE = /['"]/

// ── Context ───────────────────────────────────────────────────────────────────

interface ReadDenyRule {
  text: string
  /** A bare `Read` deny: every read is denied. */
  all: boolean
  patterns: string[]
}

interface Ctx {
  platform: NodeJS.Platform
  /** Normalised scope roots, plus their realpaths where known. */
  roots: string[]
  /** Normalised effective cwd (`workdir` when set). */
  effCwd: string
  realpath: (absPath: string) => string | undefined | null
  readDeny: ReadDenyRule[]
}

function normalizeWs(s: string): string {
  return s.trim().replace(/\s+/g, ' ')
}

/**
 * Read deny specifier → patterns for {@link wildcardMatch}. Deliberately
 * over-matching (fail closed): the settings directory and `~` are unknowable
 * here, so `/x` and `~/x` are both treated as "`x` at any depth".
 */
function readDenyPatterns(specifier: string): string[] {
  let q = specifier.replace(/\\/g, '/')
  if (q.startsWith('//')) q = q.slice(1)
  else if (q.startsWith('~/')) q = `**/${q.slice(2)}`
  else if (q.startsWith('./')) q = q.slice(2)
  else if (q.startsWith('/')) q = `**${q}`
  const out = [q]
  if (!q.startsWith('/') && !q.startsWith('*')) out.push(`**/${q}`)
  return out
}

function buildCtx(scope: ReadOnlyScope): Omit<Ctx, 'effCwd'> {
  const platform = scope.platform
  const safeRealpath = (p: string): string | undefined | null => {
    try {
      return scope.realpath(p)
    } catch {
      return null
    }
  }
  if (typeof scope.cwd !== 'string' || scope.cwd.trim().length === 0) refuse('scope:no-cwd')
  const cwd = normalizePath(scope.cwd, platform).full
  // A relative root would be compared against absolute targets textually.
  if (!isAbsolutePosixish(cwd, platform)) refuse('scope:cwd-not-absolute')
  const roots: string[] = []
  for (const r of [cwd, ...(scope.additionalDirectories ?? [])]) {
    if (typeof r !== 'string' || r.trim().length === 0) continue
    // A relative additional directory is relative to the session cwd.
    const norm = resolveTarget(cwd, r, platform).full
    roots.push(norm)
    const real = safeRealpath(norm)
    if (typeof real === 'string' && real.length > 0) roots.push(normalizePath(real, platform).full)
  }

  const readDeny: ReadDenyRule[] = []
  for (const text of scope.rules?.deny ?? []) {
    const parsed = parseRuleText(text)
    if (parsed?.tool !== 'Read') continue
    readDeny.push({
      text,
      all: !parsed.specifier,
      patterns: parsed.specifier ? readDenyPatterns(parsed.specifier) : []
    })
  }
  return { platform, roots, realpath: safeRealpath, readDeny }
}

// ── 4. Path rules ─────────────────────────────────────────────────────────────

/** Exact (case-insensitive) sensitive path components. */
const SENSITIVE_EXACT: ReadonlySet<string> = new Set([
  // Shell / REPL history files (the `*_history` form is a suffix below).
  'consolehost_history.txt',
  '.history',
  '.lesshst',
  '.ssh',
  '.aws',
  '.azure',
  '.gcloud',
  '.gnupg',
  '.kube',
  '.docker',
  '.netrc',
  '_netrc',
  '.npmrc',
  '.pypirc',
  '.git-credentials',
  '.gitconfig',
  'credentials',
  'secrets',
  'auth.json',
  'auth-vault.json',
  'kubeconfig',
  // The directory itself: `.git/config` can hold URL credentials. `git`
  // commands read it through git, which the armed-config capture covers.
  '.git'
])
const SENSITIVE_PREFIXES = [
  '.env',
  'id_rsa',
  'id_dsa',
  'id_ecdsa',
  'id_ed25519',
  'credentials.',
  'secret.',
  'secrets.'
] as const
const SENSITIVE_SUFFIXES = [
  '.pem',
  '.key',
  '.p12',
  '.pfx',
  '.jks',
  '.keystore',
  '.ppk',
  '.gpg',
  '.pgp',
  '.asc',
  '.kdbx',
  '_history',
  '.secret',
  '.tfstate',
  '.tfvars'
] as const

/** Is this single path component secret-shaped? Case-insensitive on every platform. */
export function isSensitiveComponent(component: string): boolean {
  const c = component.toLowerCase().replace(/[. ]+$/, '')
  if (c === '') return false
  if (SENSITIVE_EXACT.has(c)) return true
  return (
    SENSITIVE_PREFIXES.some((p) => c.startsWith(p)) || SENSITIVE_SUFFIXES.some((p) => c.endsWith(p))
  )
}

/**
 * Concrete secret-shaped names, for a glob that someone else expands: a git
 * pathspec (`git diff -- ".e*"`) or a positive rg `--glob`, which whitelists
 * what it matches past rg's hidden/ignore defaults. A glob matching any of these
 * is refused. Derived from the pattern lists above so the two cannot drift:
 * every exact name, every prefix (plus a `.local` variant, or a `json`
 * extension for the `credentials.`-style prefixes) and `x` + every suffix.
 */
export const SENSITIVE_SAMPLES: readonly string[] = [
  ...SENSITIVE_EXACT,
  ...SENSITIVE_PREFIXES.flatMap((p) => (p.endsWith('.') ? [`${p}json`] : [p, `${p}.local`])),
  ...SENSITIVE_SUFFIXES.map((x) => `x${x}`)
]

/** Could this glob component match a secret-shaped name? */
function matchesSecretSample(globComponent: string): boolean {
  return SENSITIVE_SAMPLES.some((sample) => wildcardMatch(sample, globComponent, 'win32'))
}

/** Windows device names — `cat CON` blocks, `COM1` is a port someone else may own. */
const DEVICE_RE = /^(con|prn|aux|nul|com\d|lpt\d)(\..*)?$/i

const GLOB_RE = /[*?[]/

/** git revision-ancestry suffixes (`HEAD~1`, `main^`, `HEAD~2..HEAD`) — the only
 *  place `~` and `^` are tolerated (8.3 short names and cmd's `^` escape are
 *  why they are refused elsewhere). */
const REV_RE =
  /^[A-Za-z0-9_][A-Za-z0-9_./-]*(?:[~^]\d*)+(?:\.\.\.?[A-Za-z0-9_][A-Za-z0-9_./-]*(?:[~^]\d*)*)?$/

interface PathOpts {
  /** Glob chars allowed (a pattern, not an opened path). */
  glob?: boolean
  /** A glob someone else expands (find -name, a git pathspec): refuse one that could match a secret name. */
  refuseSecretGlobs?: boolean
  /** A git revision may carry `~`/`^` ancestry suffixes. */
  revOk?: boolean
  /** One literal view only (`workdir` is not shell-parsed). */
  single?: boolean
}

function isWithin(root: string, target: string, platform: NodeJS.Platform): boolean {
  const fold = (s: string): string => (platform === 'win32' ? s.toLowerCase() : s)
  return (
    fold(root).replace(/\/+$/, '') === fold(target).replace(/\/+$/, '') ||
    isDescendant(root, target, platform)
  )
}

/** The scope root `full` lies in (the deepest, when roots nest), or `undefined`. */
function rootOf(ctx: Pick<Ctx, 'roots' | 'platform'>, full: string): string | undefined {
  let best: string | undefined
  for (const r of ctx.roots) {
    if (!isWithin(r, full, ctx.platform)) continue
    if (!best || r.length > best.length) best = r
  }
  return best
}

function foldPath(ctx: Pick<Ctx, 'platform'>, s: string): string {
  return (ctx.platform === 'win32' ? s.toLowerCase() : s).replace(/\/+$/, '')
}

function readDenyHit(full: string, ctx: Pick<Ctx, 'readDeny'>): string | undefined {
  if (ctx.readDeny.length === 0) return undefined
  const comps = full.split('/').filter(Boolean)
  const bases = new Set<string>([full, `/${full.replace(/^\/+/, '')}`])
  const drive = /^([a-z]):\//i.exec(full)
  if (drive) bases.add(`/${drive[1]}${full.slice(2)}`)
  for (let k = 0; k < comps.length; k++) {
    const suffix = comps.slice(k).join('/')
    bases.add(suffix)
    bases.add(`/${suffix}`)
  }
  const candidates = [...bases].flatMap((c) => [c, `${c}/`])
  for (const rule of ctx.readDeny) {
    if (rule.all) return rule.text
    for (const pattern of rule.patterns) {
      if (candidates.some((c) => wildcardMatch(c, pattern, 'win32'))) return rule.text
    }
  }
  return undefined
}

function checkSensitive(components: readonly string[]): void {
  for (const c of components) {
    if (isSensitiveComponent(c)) refuse(`path:sensitive ${c}`)
  }
}

/**
 * Check one resolved-or-real path: scope, then sensitive names on the
 * components BELOW the scope root it landed in (a workspace that happens to
 * live under a directory called `secrets` is still a workspace), then the
 * user's Read deny rules on the full path. Returns that root.
 */
function checkResolved(p: NormalizedPath, ctx: Ctx, outReason: string): string {
  const root = rootOf(ctx, p.full)
  if (!root) refuse(outReason)
  checkSensitive(p.components.slice(normalizePath(root, ctx.platform).components.length))
  const deny = readDenyHit(p.full, ctx)
  if (deny) refuse(`path:read-deny ${deny}`)
  return root
}

/** The path rules for one piece of one view. */
function checkPiece(piece: string, isWin: boolean, ctx: Ctx, opts: PathOpts): void {
  if (piece === '') refuse('path:empty')
  const hasGlob = GLOB_RE.test(piece)
  if (hasGlob && !opts.glob) refuse('path:glob')
  if (!opts.revOk && /[~^]/.test(piece)) refuse('path:special ~^')
  // cmd.exe would expand `%VAR%`; harmless in bash/pwsh but never needed in a path.
  if (piece.includes('%')) refuse('path:special %')
  // Win32 file APIs treat `<`, `>` and `"` as wildcards (DOS_STAR/QM/DOT).
  if (/[<>"]/.test(piece)) refuse('path:special <>"')
  // zsh (a macOS $SHELL) expands a leading `=cmd` to that command's path.
  if (piece.startsWith('=')) refuse('path:=')
  if (piece.includes('://')) refuse('path:url')
  if (/^(?:\\\\|\/\/)/.test(piece)) refuse('path:unc')
  if (/^[A-Za-z]{2,}:/.test(piece)) refuse('path:provider')
  if (/^[A-Za-z]:(?![\\/])/.test(piece)) refuse('path:drive-relative')
  if (piece.slice(/^[A-Za-z]:/.test(piece) ? 2 : 0).includes(':')) refuse('path:colon')

  // Windows opens `.env.` as `.env`: strip trailing dots/spaces per component.
  const parts = piece.split(/[\\/]/)
  const cleaned: string[] = []
  for (const part of parts) {
    if (part === '' || part === '.' || part === '..') {
      cleaned.push(part)
      continue
    }
    const stripped = part.replace(/[. ]+$/, '')
    if (stripped === '') refuse('path:dots')
    if (DEVICE_RE.test(stripped)) refuse(`path:device ${stripped}`)
    cleaned.push(stripped)
  }
  if (opts.refuseSecretGlobs && hasGlob) {
    for (const part of cleaned) {
      if (GLOB_RE.test(part) && matchesSecretSample(part)) {
        refuse(`path:pattern-may-match-sensitive ${part}`)
      }
    }
  }
  // PowerShell reads `/x` / `\x` as the ROOT of the current drive, where bash
  // on Git for Windows reads `/d/x` as `D:\x`. Resolve the Windows view as
  // PowerShell would, so a Git-Bash spelling must also be in scope there.
  const resolveParts = (list: readonly string[]): NormalizedPath => {
    let target = list.join('/')
    if (isWin && ctx.platform === 'win32' && /^\/(?!\/)/.test(target)) {
      const drive = /^[a-z]:/i.exec(ctx.effCwd)
      target = `${drive ? drive[0] : ''}${target}`
    }
    return resolveTarget(ctx.effCwd, target, ctx.platform)
  }
  const resolved = resolveParts(cleaned)
  const root = checkResolved(resolved, ctx, 'path:out-of-scope')
  // The token's own components too (`a/.ssh/../b` never names `.ssh` once
  // resolved) — minus a leading spelling of the scope root itself
  // (`"D:\secrets\ws\src"` for a workspace at D:\secrets\ws).
  let skip = 0
  for (let k = cleaned.length; k > 0; k--) {
    const prefix = cleaned.slice(0, k)
    if (prefix.includes('..')) continue
    if (foldPath(ctx, resolveParts(prefix).full) === foldPath(ctx, root)) {
      skip = k
      break
    }
  }
  for (const part of cleaned.slice(skip)) {
    if (isSensitiveComponent(part)) refuse(`path:sensitive ${part}`)
  }
  // A glob is a pattern, not a file that exists: nothing to realpath.
  if (hasGlob) return
  const real = ctx.realpath(resolved.full)
  if (real === null) refuse('path:realpath-unknown')
  if (typeof real === 'string') {
    checkResolved(normalizePath(real, ctx.platform), ctx, 'path:realpath-out-of-scope')
  }
}

/**
 * The Windows view's comma pieces. PowerShell's `a, b` array syntax leaves an
 * empty piece at a token edge (`a,` then `b`), which is not a path; an empty
 * piece anywhere else is kept (and refused).
 */
function winPieces(tok: Tok): string[] {
  const pieces = tok.win.split(',')
  if (pieces.length > 1 && pieces[0] === '') pieces.shift()
  if (pieces.length > 1 && pieces[pieces.length - 1] === '') pieces.pop()
  return pieces
}

/** Path rules for a token, in every view (and, for the Windows view, every comma piece). */
function checkPath(tok: Tok, ctx: Ctx, opts: PathOpts = {}): void {
  if (opts.single) {
    checkPiece(tok.raw, false, ctx, opts)
    return
  }
  checkPiece(tok.posix, false, ctx, opts)
  for (const piece of winPieces(tok)) checkPiece(piece, true, ctx, opts)
}

// ── 3. Command tables ─────────────────────────────────────────────────────────

/**
 * - `native`: a real program in every shell (pwsh runs the same binary);
 * - `alias`: a bash command AND a PowerShell alias (`ls`, `cat`) — both
 *   meanings apply, so every argument is also a bash positional path;
 * - `cmdlet`: PowerShell only — bash would say "command not found".
 */
type Dialect = 'native' | 'alias' | 'cmdlet'

type Kind =
  | 'num'
  | 'count'
  | 'text'
  | 'path'
  | 'pattern'
  | 'name-pattern'
  | 'find-pattern'
  | 'rg-glob'
  | 'names'
  | 'context'
  | RegExp
  | { optional: Kind }

interface Spec {
  /** For refusal reasons. */
  name: string
  dialect: Dialect
  /** Flag → value kind (`null` = switch). Keys may also be whole exact tokens. */
  flags: Record<string, Kind | null>
  /** Explicitly refused flags, for a visible reason (`-exec*` = prefix). */
  refused?: readonly string[]
  /** GNU short-option bundling (`-rn`, `-A3`). */
  bundling?: boolean
  /** `head -20`, `git log -10`. */
  dashNumber?: boolean
  /** PowerShell parameter names match case-insensitively. */
  ci?: boolean
  /** A token of dashes only (`---`) is text, not a flag. */
  dashRunsText?: boolean
  /** GNU `ls` bundles vetted against Get-ChildItem's parameters ({@link bindsGciParameter}). */
  lsBundles?: boolean
}

interface Positional {
  tok: Tok
  afterDashDash: boolean
}

interface Parsed {
  /** Flag name → values seen (empty for a switch). */
  flags: Map<string, Tok[]>
  values: Array<{ key: string; kind: Kind; tok: Tok }>
  positionals: Positional[]
}

const EA = /^(SilentlyContinue|Stop|Continue|Ignore)$/i
const NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/

function isFlagLike(t: Tok): boolean {
  return t.posix.length > 1 && t.posix.startsWith('-')
}

function isRefusedFlag(spec: Spec, name: string): boolean {
  return (spec.refused ?? []).some((r) =>
    r.endsWith('*') ? name.startsWith(r.slice(0, -1)) : name === r
  )
}

function subTok(t: Tok, offset: number): Tok {
  const raw = t.raw.slice(offset)
  return {
    raw,
    posix: t.posix.slice(offset),
    win: t.win.slice(offset),
    quoted: QUOTE_RE.test(raw),
    uglob: t.uglob,
    ucomma: t.ucomma
  }
}

function plainTok(text: string, from: Tok): Tok {
  return {
    raw: text,
    posix: text,
    win: text,
    quoted: false,
    uglob: from.uglob,
    ucomma: from.ucomma
  }
}

function lookup(spec: Spec, name: string): Kind | null | undefined {
  if (!spec.ci)
    return Object.prototype.hasOwnProperty.call(spec.flags, name) ? spec.flags[name] : undefined
  const lower = name.toLowerCase()
  for (const key of Object.keys(spec.flags)) {
    if (key.toLowerCase() === lower) return spec.flags[key]
  }
  return undefined
}

/** Generic typed-flag parser. Unknown flag → refuse. */
function parseArgs(args: Tok[], spec: Spec): Parsed {
  const out: Parsed = { flags: new Map(), values: [], positionals: [] }
  const record = (key: string, kind?: Kind, tok?: Tok): void => {
    const list = out.flags.get(key) ?? []
    if (tok) list.push(tok)
    out.flags.set(key, list)
    if (kind !== undefined && tok) out.values.push({ key, kind, tok })
  }
  let ended = false
  for (let i = 0; i < args.length; i++) {
    const t = args[i]
    if (!ended && t.raw === '--') {
      ended = true
      continue
    }
    if (
      ended ||
      !isFlagLike(t) ||
      (spec.dashRunsText && /^-+$/.test(t.posix)) ||
      // To PowerShell a token that STARTS with a quote is a string, never a
      // parameter (and a cmdlet is "command not found" to bash).
      (spec.dialect === 'cmdlet' && QUOTE_RE.test(t.raw[0]))
    ) {
      out.positionals.push({ tok: t, afterDashDash: ended })
      continue
    }
    // A quoted flag is a flag to bash but a plain string to PowerShell.
    const eq = t.posix.startsWith('--') ? t.posix.indexOf('=') : -1
    const namePart = eq >= 0 ? t.raw.slice(0, eq) : t.raw
    if (QUOTE_RE.test(namePart) || namePart !== (eq >= 0 ? t.posix.slice(0, eq) : t.posix)) {
      refuse('token:quoted-flag')
    }
    if (spec.lsBundles && LS_BUNDLE_RE.test(t.posix) && !bindsGciParameter(t.posix.slice(1))) {
      record(t.posix)
      continue
    }
    // A whole-token entry wins (`-uno`, `--porcelain=v2`).
    if (lookup(spec, t.posix) === null) {
      if (isRefusedFlag(spec, t.posix)) refuse(`flag:${spec.name} ${t.posix}`)
      record(t.posix)
      continue
    }
    if (spec.dashNumber && /^-\d+$/.test(t.posix)) {
      record('-N')
      continue
    }
    if (t.posix.startsWith('--') || !spec.bundling) {
      const name = eq >= 0 ? t.posix.slice(0, eq) : t.posix
      if (isRefusedFlag(spec, name)) refuse(`flag:${spec.name} ${name}`)
      const kind = lookup(spec, name)
      if (kind === undefined) refuse(`flag:${spec.name} ${name}`)
      if (kind === null) {
        if (eq >= 0) refuse(`flag:${spec.name} ${name}=`)
        record(name)
        continue
      }
      if (typeof kind === 'object' && 'optional' in kind) {
        if (eq >= 0) record(name, kind.optional, subTok(t, eq + 1))
        else record(name)
        continue
      }
      if (eq >= 0) {
        record(name, kind, subTok(t, eq + 1))
        continue
      }
      let value = args[i + 1]
      if (!value) refuse(`flag:${spec.name} ${name} missing value`)
      i++
      // PowerShell array spelled across tokens: `-Context 2, 10`.
      const next = args[i + 1]
      if (kind === 'context' && /^\d+,$/.test(value.raw) && next && /^\d+$/.test(next.raw)) {
        value = plainTok(value.raw + next.raw, value)
        i++
      }
      record(name, kind, value)
      continue
    }
    // GNU short bundle.
    const chars = t.posix.slice(1)
    for (let j = 0; j < chars.length; j++) {
      const key = `-${chars[j]}`
      if (isRefusedFlag(spec, key)) refuse(`flag:${spec.name} ${key}`)
      const kind = lookup(spec, key)
      if (kind === undefined) refuse(`flag:${spec.name} ${key}`)
      if (kind === null) {
        record(key)
        continue
      }
      const rest = chars.slice(j + 1)
      if (typeof kind === 'object' && 'optional' in kind) {
        if (rest) record(key, kind.optional, plainTok(rest, t))
        else record(key)
        break
      }
      if (rest) {
        record(key, kind, plainTok(rest, t))
        break
      }
      const value = args[i + 1]
      if (!value) refuse(`flag:${spec.name} ${key} missing value`)
      i++
      record(key, kind, value)
      break
    }
  }
  return out
}

/** Text rules that depend on the dialect (the global rules already ran). */
function checkText(tok: Tok, dialect: Dialect): void {
  // PowerShell turns an unquoted comma into separate NATIVE arguments, which
  // can shift a piece into a path position the table never saw.
  if (dialect === 'native' && tok.ucomma) refuse('token:comma')
}

function checkValue(kind: Kind, tok: Tok, ctx: Ctx, spec: Spec): void {
  if (kind instanceof RegExp) {
    checkText(tok, spec.dialect)
    if (!kind.test(tok.posix) || !kind.test(tok.win)) refuse(`value:${spec.name} ${tok.raw}`)
  } else if (typeof kind === 'object') {
    checkValue(kind.optional, tok, ctx, spec)
  } else {
    switch (kind) {
      case 'num':
      case 'count': {
        const re = kind === 'num' ? /^\d+$/ : /^[+-]?\d+$/
        if (!re.test(tok.posix) || !re.test(tok.win)) refuse(`value:${spec.name} ${tok.raw}`)
        break
      }
      case 'context':
        if (!/^\d+(,\d+)?$/.test(tok.posix) || tok.posix !== tok.win) {
          refuse(`value:${spec.name} ${tok.raw}`)
        }
        break
      case 'text':
      case 'pattern':
        checkText(tok, spec.dialect)
        break
      case 'path':
        checkPath(tok, ctx)
        break
      case 'find-pattern':
        // A name filter: find lists matching names, it never reads them.
        // (Windows find.exe rejects every `-x` token as a bad switch, so the
        // only file it could open is a start point, path-checked above.)
        checkPath(tok, ctx, { glob: true })
        break
      case 'rg-glob': {
        // An rg glob WHITELISTS what it matches, overriding the hidden/ignore
        // defaults. A negated glob only excludes; a positive one must name
        // files by a pattern that cannot match a secret-shaped name.
        checkText(tok, spec.dialect)
        if (tok.posix !== tok.win) refuse(`value:${spec.name} ${tok.raw}`)
        if (tok.posix.startsWith('!')) break
        const comps = tok.posix.split('/').filter((c) => c !== '')
        const last = comps[comps.length - 1] ?? ''
        for (const c of comps) {
          if (GLOB_RE.test(c) ? matchesSecretSample(c) : isSensitiveComponent(c)) {
            refuse(`path:pattern-may-match-sensitive ${c}`)
          }
        }
        // A glob-free last component can name a whole directory.
        if (!GLOB_RE.test(last)) refuse(`value:${spec.name} ${tok.raw} (a directory glob)`)
        break
      }
      case 'name-pattern':
        // PowerShell -Filter/-Include/-Exclude: a NAME wildcard applied under
        // an already-checked -Path; it lists names, never contents.
        for (const piece of winPieces(tok)) {
          if (piece === '' || /[\\/:[<>"]/.test(piece) || piece.includes('..')) {
            refuse(`value:${spec.name} ${tok.raw}`)
          }
          if (isSensitiveComponent(piece)) refuse(`path:sensitive ${piece}`)
        }
        break
      case 'names':
        for (const piece of winPieces(tok)) {
          if (piece !== '' && !NAME_RE.test(piece)) refuse(`value:${spec.name} ${tok.raw}`)
        }
        break
    }
  }
  // An alias word is also the bash command, where every argument is a
  // positional file operand.
  if (spec.dialect === 'alias' && kind !== 'path') checkPath(tok, ctx)
}

function checkValues(parsed: Parsed, ctx: Ctx, spec: Spec): void {
  for (const v of parsed.values) checkValue(v.kind, v.tok, ctx, spec)
}

type Positionals = 'none' | 'paths' | 'text' | 'names' | 'pattern-then-paths'

function checkPositionals(
  parsed: Parsed,
  mode: Positionals,
  ctx: Ctx,
  spec: Spec,
  patternGiven = false
): void {
  const list = parsed.positionals
  if (mode === 'none') {
    if (list.length > 0) refuse(`arg:${spec.name} positional`)
    return
  }
  list.forEach((p, idx) => {
    if (mode === 'text') {
      checkText(p.tok, spec.dialect)
      if (spec.dialect === 'alias') checkPath(p.tok, ctx)
    } else if (mode === 'names') {
      checkValue('names', p.tok, ctx, spec)
    } else if (mode === 'pattern-then-paths' && idx === 0 && !patternGiven) {
      checkValue('pattern', p.tok, ctx, spec)
    } else {
      checkPath(p.tok, ctx)
    }
  })
}

// ---- POSIX / native -----------------------------------------------------------

const WC: Spec = {
  name: 'wc',
  dialect: 'native',
  bundling: true,
  flags: { '-l': null, '-w': null, '-c': null, '-m': null },
  refused: ['--files0-from*']
}

const HEAD_TAIL = (name: string): Spec => ({
  name,
  dialect: 'native',
  bundling: true,
  dashNumber: true,
  flags: { '-n': 'count', '-c': 'count' },
  refused: ['-f', '-F', '--follow*', '--pid*']
})

const GREP: Spec = {
  name: 'grep',
  dialect: 'native',
  bundling: true,
  flags: {
    '-n': null,
    '-i': null,
    '-l': null,
    '-c': null,
    '-E': null,
    '-F': null,
    '-w': null,
    '-x': null,
    '-h': null,
    '-H': null,
    '-o': null,
    '-v': null,
    '-P': null,
    '-A': 'num',
    '-B': 'num',
    '-C': 'num',
    '-m': 'num',
    '-e': 'pattern',
    '--include': 'pattern',
    '--exclude': 'pattern',
    '--exclude-dir': 'pattern'
  },
  // No recursion at all: a recursive grep prints every secret file inside the
  // tree it walks (`.env`, `.git/config`), which no per-path check can see.
  refused: [
    '-r',
    '-R',
    '--recursive',
    '--dereference-recursive',
    '-d',
    '--directories*',
    '-f',
    '--file',
    '--exclude-from*',
    '-D',
    '--devices*'
  ]
}

const RG: Spec = {
  name: 'rg',
  dialect: 'native',
  bundling: true,
  flags: {
    '-n': null,
    '-i': null,
    '-l': null,
    '-c': null,
    '-w': null,
    '-x': null,
    '-F': null,
    '-S': null,
    '-e': 'pattern',
    '-t': /^[A-Za-z0-9_+-]+$/,
    '--type': /^[A-Za-z0-9_+-]+$/,
    '-g': 'rg-glob',
    '--glob': 'rg-glob',
    '-A': 'num',
    '-B': 'num',
    '-C': 'num',
    '-m': 'num',
    '--max-count': 'num',
    '--files': null,
    '--json': null
  },
  // rg's defaults skip hidden and gitignored files (`.env`, `.git/`), and every
  // switch that turns that off is refused. It still READS every other file
  // under its paths by content, so a tracked or untracked-but-not-ignored
  // secret-shaped file (`config/credentials.json`) can surface — an accepted
  // residual (ADR-084); the judge would see the same command anyway.
  refused: [
    '--hidden',
    '-.',
    '-u',
    '--unrestricted',
    '--no-ignore*',
    '--pre*',
    '--hostname-bin*',
    '-f',
    '--file',
    '--ignore-file*',
    '-L',
    '--follow',
    '-z',
    '--search-zip',
    '--type-add*'
  ]
}

const DATE: Spec = {
  name: 'date',
  dialect: 'native',
  bundling: true,
  flags: { '-u': null, '-R': null, '-I': null }
}

const FIND_FLAGS: Record<string, Kind | null> = {
  '-name': 'find-pattern',
  '-iname': 'find-pattern',
  '-path': 'find-pattern',
  '-type': /^[bcdpfls]$/,
  '-maxdepth': 'num',
  '-mindepth': 'num',
  '-size': /^[+-]?\d+[bcwkMG]?$/,
  '-mtime': /^[+-]?\d+$/,
  '-not': null,
  '-o': null,
  '-a': null,
  '-print': null,
  '-print0': null,
  '-prune': null
}
const FIND_REFUSED =
  /^-(exec|execdir|ok|okdir|delete|fprint|fprint0|fprintf|fls|files0-from|L|H|follow|samefile|newer.*)$/
const FIND_SPEC: Spec = { name: 'find', dialect: 'native', flags: FIND_FLAGS }

function checkFind(args: Tok[], ctx: Ctx): void {
  let i = 0
  // Start points: every token before the first expression token.
  while (i < args.length && !isFlagLike(args[i])) {
    checkPath(args[i], ctx)
    i++
  }
  for (; i < args.length; i++) {
    const t = args[i]
    if (!isFlagLike(t)) refuse(`arg:find ${t.raw}`)
    if (t.raw !== t.posix) refuse('token:quoted-flag')
    if (FIND_REFUSED.test(t.posix)) refuse(`flag:find ${t.posix}`)
    const kind = FIND_FLAGS[t.posix]
    if (kind === undefined) refuse(`flag:find ${t.posix}`)
    if (kind === null) continue
    const value = args[++i]
    if (!value) refuse(`flag:find ${t.posix} missing value`)
    checkValue(kind, value, ctx, FIND_SPEC)
  }
}

// ---- git -----------------------------------------------------------------------

const GIT_GLOBAL_OK: ReadonlySet<string> = new Set(['--no-pager', '-P', '--no-optional-locks'])

/** Refused on every subcommand, whatever its table says (ADR-084). */
const GIT_ALWAYS_REFUSED =
  /^(?:--output|--ext-diff|--textconv|-O|--edit|--exec|--show-signature|--contents|--no-index)/

const COLOR = { optional: /^(never|always|auto)$/ } as const
const OPT_NUM = { optional: 'num' } as const

const DIFF_COMMON: Record<string, Kind | null> = {
  '--stat': OPT_NUM,
  '--shortstat': null,
  '--numstat': null,
  '--name-only': null,
  '--name-status': null,
  '--summary': null,
  '--raw': null,
  '--patch': null,
  '-p': null,
  '--no-patch': null,
  '-s': null,
  '--no-color': null,
  '--color': COLOR,
  '--word-diff': { optional: /^(color|plain|porcelain|none)$/ },
  '--no-ext-diff': null,
  '--no-textconv': null,
  '-U': OPT_NUM,
  '--unified': 'num',
  '--abbrev': OPT_NUM,
  '-M': { optional: /^\d+%?$/ },
  '--find-renames': null,
  '--no-renames': null,
  '--diff-filter': /^[A-Za-z]+$/
}

const GIT_SUBS: Record<string, { flags: Record<string, Kind | null>; dashNumber?: boolean }> = {
  status: {
    flags: {
      '-s': null,
      '--short': null,
      '-b': null,
      '--branch': null,
      '--porcelain': null,
      '--porcelain=v1': null,
      '--porcelain=v2': null,
      '--long': null,
      '-v': null,
      '--verbose': null,
      '--show-stash': null,
      '--ahead-behind': null,
      '--no-ahead-behind': null,
      '-z': null,
      '--ignored': null,
      '--no-renames': null,
      '-u': null,
      '-uno': null,
      '-unormal': null,
      '-uall': null,
      '--untracked-files': { optional: /^(no|normal|all)$/ }
    }
  },
  diff: {
    flags: {
      ...DIFF_COMMON,
      '--cached': null,
      '--staged': null,
      '--check': null,
      '--exit-code': null,
      '--quiet': null,
      '--ignore-space-change': null,
      '-b': null,
      '-w': null,
      '--ignore-all-space': null,
      '--ignore-blank-lines': null,
      '--ignore-space-at-eol': null,
      '--minimal': null,
      '--patience': null,
      '--histogram': null,
      '-R': null
    }
  },
  log: {
    dashNumber: true,
    flags: {
      ...DIFF_COMMON,
      '--oneline': null,
      '-n': 'num',
      '--max-count': 'num',
      '--skip': 'num',
      '--graph': null,
      '--decorate': { optional: /^(short|full|auto|no)$/ },
      '--no-decorate': null,
      '--all': null,
      '--branches': null,
      '--tags': null,
      '--remotes': null,
      '--left-right': null,
      '--reverse': null,
      '--first-parent': null,
      '--no-merges': null,
      '--merges': null,
      '--follow': null,
      '--abbrev-commit': null,
      '--no-abbrev-commit': null,
      '--cherry-pick': null,
      '--cherry-mark': null,
      '--boundary': null,
      '--ancestry-path': null,
      '--full-history': null,
      '--date-order': null,
      '--topo-order': null,
      '-i': null,
      '--regexp-ignore-case': null,
      '--all-match': null,
      '--invert-grep': null,
      '-E': null,
      '-F': null,
      '--author': 'text',
      '--committer': 'text',
      '--grep': 'text',
      '--since': 'text',
      '--until': 'text',
      '--after': 'text',
      '--before': 'text',
      '-G': 'text',
      '-S': 'text',
      '--format': 'text',
      '--pretty': { optional: 'text' },
      '--date': 'text'
    }
  },
  show: {
    flags: {
      ...DIFF_COMMON,
      '--oneline': null,
      '--abbrev-commit': null,
      '--no-abbrev-commit': null,
      '-q': null,
      '--quiet': null,
      '--format': 'text',
      '--pretty': { optional: 'text' },
      '--date': 'text'
    }
  },
  branch: {
    flags: {
      '-a': null,
      '--all': null,
      '-r': null,
      '--remotes': null,
      '-v': null,
      '--verbose': null,
      '-l': null,
      '--list': null,
      '--show-current': null,
      '--merged': null,
      '--no-merged': null,
      '--contains': null,
      '--no-contains': null,
      '-i': null,
      '--ignore-case': null,
      '--omit-empty': null,
      '--no-color': null,
      '--color': COLOR,
      '--sort': 'text',
      '--format': 'text'
    }
  },
  'rev-parse': {
    flags: {
      '--show-toplevel': null,
      '--abbrev-ref': { optional: /^(strict|loose)$/ },
      '--short': OPT_NUM,
      '--git-dir': null,
      '--git-common-dir': null,
      '--absolute-git-dir': null,
      '--is-inside-work-tree': null,
      '--is-inside-git-dir': null,
      '--is-bare-repository': null,
      '--is-shallow-repository': null,
      '--verify': null,
      '--quiet': null,
      '-q': null,
      '--symbolic': null,
      '--symbolic-full-name': null,
      '--show-prefix': null,
      '--show-cdup': null,
      '--show-superproject-working-tree': null
    }
  },
  'ls-files': {
    flags: {
      '-c': null,
      '--cached': null,
      '-d': null,
      '--deleted': null,
      '-m': null,
      '--modified': null,
      '-o': null,
      '--others': null,
      '-i': null,
      '--ignored': null,
      '-s': null,
      '--stage': null,
      '-u': null,
      '--unmerged': null,
      '-k': null,
      '--killed': null,
      '--directory': null,
      '--no-empty-directory': null,
      '--exclude-standard': null,
      '--full-name': null,
      '--eol': null,
      '--deduplicate': null,
      '-z': null,
      '-t': null,
      '-v': null,
      '--error-unmatch': null
    }
  },
  'merge-base': {
    flags: {
      '--is-ancestor': null,
      '-a': null,
      '--all': null,
      '--fork-point': null,
      '--octopus': null,
      '--independent': null
    }
  }
}

function checkGit(args: Tok[], ctx: Ctx): void {
  let i = 0
  while (i < args.length && isFlagLike(args[i])) {
    const g = args[i]
    if (g.raw !== g.posix || !GIT_GLOBAL_OK.has(g.raw)) refuse(`flag:git ${g.raw}`)
    i++
  }
  const subTokRaw = args[i]
  if (!subTokRaw) refuse('cmd:git bare')
  if (subTokRaw.raw !== subTokRaw.posix || subTokRaw.quoted) refuse('cmd:git quoted')
  const sub = subTokRaw.raw
  const rest = args.slice(i + 1)

  if (sub === 'remote') {
    const words = rest.map((t) => t.raw)
    if (words.length === 0) return
    if (words.length === 1 && (words[0] === '-v' || words[0] === '--verbose')) return
    refuse('arg:git remote')
  }
  const table = Object.prototype.hasOwnProperty.call(GIT_SUBS, sub) ? GIT_SUBS[sub] : undefined
  if (!table) refuse(`cmd:git ${sub}`)
  for (const t of rest) {
    if (!isFlagLike(t)) continue
    const name = t.posix.split('=')[0]
    if (GIT_ALWAYS_REFUSED.test(name)) refuse(`flag:git ${name}`)
  }
  const spec: Spec = {
    name: `git ${sub}`,
    dialect: 'native',
    bundling: true,
    dashNumber: table.dashNumber,
    flags: table.flags
  }
  const parsed = parseArgs(rest, spec)
  // `~` is tolerated only as a revision suffix in a positional (checked below).
  const positionalToks = new Set(parsed.positionals.map((p) => p.tok))
  for (const t of rest) if (!positionalToks.has(t) && t.raw.includes('~')) refuse('token:~')
  checkValues(parsed, ctx, spec)
  if (sub === 'branch' && parsed.positionals.length > 0) {
    // `git branch X` creates a ref; only a listing may take patterns.
    if (!parsed.flags.has('--list') && !parsed.flags.has('-l')) refuse('arg:git branch positional')
  }
  for (const p of parsed.positionals) {
    const v = p.tok.posix
    // Pathspec magic (`:/`, `:(top)`, `:!x`) can address the repo root above
    // the cwd/workdir; refused outright (stricter than "only with workdir").
    if (v.startsWith(':')) refuse('path:git-magic')
    const hasRevChar = /[~^]/.test(p.tok.raw)
    if (hasRevChar && (p.afterDashDash || !REV_RE.test(v) || v !== p.tok.win)) {
      refuse('token:~')
    }
    if (sub === 'branch') {
      // `--list` patterns name branches, not files.
      checkValue('pattern', p.tok, ctx, spec)
      continue
    }
    // A quoted glob is a pathspec git matches itself, inside the repo (an
    // unquoted one was already refused for bash's sake) — but `".e*"` must not
    // reach a secret-shaped file the literal spelling would be refused for.
    checkPath(p.tok, ctx, { revOk: hasRevChar, glob: true, refuseSecretGlobs: true })
  }
}

// ---- alias words (bash command AND PowerShell alias) ----------------------------

/**
 * `ls` / `dir` — GNU listing flags whose PowerShell reading (Get-ChildItem's
 * prefix-matched parameters) is harmless, plus Get-ChildItem's own parameters
 * whose GNU reading is an invalid-option error. Vetted per token:
 *
 * - `-l` → -LiteralPath (binds the next token, which is path-checked anyway);
 * - `-a`/`-A` → -Attributes (next token; an invalid enum errors);
 * - `-h` → -Hidden; `-S` → the `-s` alias of -Recurse; `-t`, `-1` → no such
 *   parameter (error); `-r`/`-R`/`-d`/`-F` → ambiguous (error);
 * - a bundle of GNU listing letters (`-la`, `-alh`, `-lart`) passes when its
 *   letters are no prefix of any Get-ChildItem parameter or alias
 *   ({@link bindsGciParameter}), i.e. PowerShell can only reject it;
 * - never `-fol…` (→ -FollowSymlink), never GNU `-L`/`-H` (dereference);
 * - `-Recurse`, `-Force`, `-Name`, `-File`, `-Directory`, `-Hidden`, `-Depth`,
 *   `-Path`, `-LiteralPath`, `-Filter`, `-Exclude`, `-ErrorAction`,
 *   `-Attributes` all contain a letter GNU ls rejects (`e`/`P`/`E`), and
 *   `-Include` is GNU `-I nclude` (an ignore pattern — harmless).
 */
/**
 * Every Get-ChildItem parameter and parameter alias (FileSystem provider +
 * common parameters). PowerShell binds a `-xyz` token to the parameter it
 * uniquely prefixes, so a GNU bundle is safe only when it prefixes none.
 */
export const GCI_PARAMETERS: readonly string[] = [
  'Path',
  'LiteralPath',
  'PSPath',
  'LP',
  'Filter',
  'Include',
  'Exclude',
  'Recurse',
  's',
  'Depth',
  'Force',
  'Name',
  'Attributes',
  'FollowSymlink',
  'Directory',
  'ad',
  'File',
  'af',
  'Hidden',
  'ah',
  'h',
  'ReadOnly',
  'ar',
  'System',
  'as',
  'Verbose',
  'vb',
  'Debug',
  'db',
  'ErrorAction',
  'ea',
  'WarningAction',
  'wa',
  'InformationAction',
  'infa',
  'ProgressAction',
  'proga',
  'ErrorVariable',
  'ev',
  'WarningVariable',
  'wv',
  'InformationVariable',
  'iv',
  'OutVariable',
  'ov',
  'OutBuffer',
  'ob',
  'PipelineVariable',
  'pv'
]

/** Would PowerShell bind `-<letters>` to some Get-ChildItem parameter? */
export function bindsGciParameter(letters: string): boolean {
  const l = letters.toLowerCase()
  return GCI_PARAMETERS.some((p) => p.toLowerCase().startsWith(l))
}

/** GNU ls listing letters (all harmless to GNU ls) in a bundle of two or more. */
const LS_BUNDLE_RE = /^-[alhtrRS1dF]{2,}$/

const LS: Spec = {
  name: 'ls',
  dialect: 'alias',
  flags: {
    '-l': null,
    '-a': null,
    '-A': null,
    '-1': null,
    '-h': null,
    '-R': null,
    '-r': null,
    '-t': null,
    '-S': null,
    '-d': null,
    '-F': null,
    '-Recurse': null,
    '-Force': null,
    '-Name': null,
    '-File': null,
    '-Directory': null,
    '-Hidden': null,
    '-Depth': 'num',
    '-Path': 'path',
    '-LiteralPath': 'path',
    '-Filter': 'name-pattern',
    '-Include': 'name-pattern',
    '-Exclude': 'name-pattern',
    '-Attributes': /^[A-Za-z,!+]+$/,
    '-ErrorAction': EA
  },
  refused: ['-L', '-H', '-FollowSymlink'],
  lsBundles: true
}

/**
 * `cat` / `type` — GNU cat's display flags whose Get-Content reading is
 * harmless (`-n`/`-b` no such parameter, `-e`/`-T` ambiguous, `-A`
 * -AsByteStream, `-v` -Verbose), plus Get-Content's read parameters whose GNU
 * reading is an invalid option. `-s` is NOT here although the ADR lists it:
 * PowerShell reads it as `-Stream`, which the Get-Content table refuses.
 */
const CAT: Spec = {
  name: 'cat',
  dialect: 'alias',
  flags: {
    '-n': null,
    '-A': null,
    '-b': null,
    '-e': null,
    '-T': null,
    '-v': null,
    '-Path': 'path',
    '-LiteralPath': 'path',
    '-Raw': null,
    '-Tail': 'num',
    '-TotalCount': 'num',
    '-Head': 'num',
    '-Encoding': /^[A-Za-z0-9-]+$/,
    '-ReadCount': 'num',
    '-AsByteStream': null,
    '-ErrorAction': EA
  },
  refused: ['-s', '-Wait', '-Credential', '-Stream', '-Filter', '-Include', '-Exclude']
}

// ---- PowerShell cmdlets --------------------------------------------------------

const GCI: Spec = {
  name: 'Get-ChildItem',
  dialect: 'cmdlet',
  ci: true,
  flags: {
    '-Path': 'path',
    '-LiteralPath': 'path',
    '-Filter': 'name-pattern',
    '-Include': 'name-pattern',
    '-Exclude': 'name-pattern',
    '-Recurse': null,
    '-Depth': 'num',
    '-Force': null,
    '-Name': null,
    '-File': null,
    '-Directory': null,
    '-Hidden': null,
    '-Attributes': /^[A-Za-z,!+]+$/,
    '-ErrorAction': EA
  },
  refused: ['-FollowSymlink']
}

const GC: Spec = {
  name: 'Get-Content',
  dialect: 'cmdlet',
  ci: true,
  flags: {
    '-Path': 'path',
    '-LiteralPath': 'path',
    '-Raw': null,
    '-Tail': 'num',
    '-TotalCount': 'num',
    '-Head': 'num',
    '-Encoding': /^[A-Za-z0-9-]+$/,
    '-ReadCount': 'num',
    '-AsByteStream': null,
    '-ErrorAction': EA
  },
  refused: ['-Wait', '-Credential', '-Stream', '-Filter', '-Include', '-Exclude']
}

const SLS: Spec = {
  name: 'Select-String',
  dialect: 'cmdlet',
  ci: true,
  flags: {
    '-Pattern': 'pattern',
    '-Path': 'path',
    '-LiteralPath': 'path',
    '-SimpleMatch': null,
    '-CaseSensitive': null,
    '-Context': 'context',
    '-AllMatches': null,
    '-Quiet': null,
    '-List': null,
    '-NotMatch': null,
    '-Encoding': /^[A-Za-z0-9-]+$/,
    '-Raw': null,
    '-ErrorAction': EA
  }
}

const TEST_PATH: Spec = {
  name: 'Test-Path',
  dialect: 'cmdlet',
  ci: true,
  flags: {
    '-Path': 'path',
    '-LiteralPath': 'path',
    '-PathType': /^(Any|Container|Leaf)$/i,
    '-ErrorAction': EA
  }
}

const GCM: Spec = {
  name: 'Get-Command',
  dialect: 'cmdlet',
  ci: true,
  flags: { '-Name': 'path', '-ErrorAction': EA }
}

const SELECT: Spec = {
  name: 'Select-Object',
  dialect: 'cmdlet',
  ci: true,
  flags: {
    '-First': 'num',
    '-Last': 'num',
    '-Skip': 'num',
    '-Unique': null,
    '-Property': 'names',
    '-ExpandProperty': NAME_RE
  }
}

const MEASURE: Spec = {
  name: 'Measure-Object',
  dialect: 'cmdlet',
  ci: true,
  flags: {
    '-Line': null,
    '-Word': null,
    '-Character': null,
    '-Sum': null,
    '-Average': null,
    '-Maximum': null,
    '-Minimum': null,
    '-Property': 'names'
  }
}

const FT: Spec = {
  name: 'Format-Table',
  dialect: 'cmdlet',
  ci: true,
  flags: { '-Property': 'names', '-AutoSize': null, '-HideTableHeaders': null, '-Wrap': null }
}

const WRITE_HOST: Spec = {
  name: 'Write-Host',
  dialect: 'cmdlet',
  ci: true,
  dashRunsText: true,
  flags: {
    '-NoNewline': null,
    '-ForegroundColor': NAME_RE,
    '-BackgroundColor': NAME_RE,
    '-Separator': 'text'
  }
}

const WRITE_OUTPUT: Spec = {
  name: 'Write-Output',
  dialect: 'cmdlet',
  ci: true,
  dashRunsText: true,
  flags: {}
}

const WHERE_OPS: ReadonlySet<string> = new Set([
  '-eq',
  '-ne',
  '-like',
  '-notlike',
  '-match',
  '-notmatch',
  '-gt',
  '-lt',
  '-ge',
  '-le',
  '-contains',
  '-notcontains'
])

// ---- the command registry --------------------------------------------------------

interface Command {
  /** Canonical name (log reasons, pipe rules). */
  canonical: string
  dialect: Dialect
  check: (args: Tok[], ctx: Ctx) => void
}

function specCommand(spec: Spec, positionals: Positionals, canonical = spec.name): Command {
  return {
    canonical,
    dialect: spec.dialect,
    check: (args, ctx) => {
      const parsed = parseArgs(args, spec)
      checkValues(parsed, ctx, spec)
      checkPositionals(parsed, positionals, ctx, spec)
    }
  }
}

const noArgs = (canonical: string, dialect: Dialect): Command => ({
  canonical,
  dialect,
  check: (args) => {
    if (args.length > 0) refuse(`arg:${canonical} takes no arguments`)
  }
})

function patternCommand(spec: Spec, patternFlags: readonly string[]): Command {
  return {
    canonical: spec.name,
    dialect: spec.dialect,
    check: (args, ctx) => {
      const parsed = parseArgs(args, spec)
      checkValues(parsed, ctx, spec)
      const given = patternFlags.some((f) => parsed.flags.has(f))
      checkPositionals(parsed, 'pattern-then-paths', ctx, spec, given)
    }
  }
}

const ECHO: Command = {
  canonical: 'echo',
  dialect: 'alias',
  check: (args) => {
    for (const t of args) {
      // `-n`/`-e`/`-E` mean the same harmless thing to bash echo and are
      // -NoEnumerate / an ambiguity error to Write-Output.
      if (/^-[A-Za-z]/.test(t.posix) && !['-n', '-e', '-E'].includes(t.raw)) {
        refuse(`flag:echo ${t.raw}`)
      }
    }
  }
}

const WHERE: Command = {
  canonical: 'Where-Object',
  dialect: 'cmdlet',
  check: (args) => {
    // Comparison form ONLY: `<prop> -<op> <value>` (a script block is `{`).
    const [prop, op, value] = args
    if (
      args.length !== 3 ||
      prop.quoted ||
      !NAME_RE.test(prop.raw) ||
      op.raw !== op.posix ||
      !WHERE_OPS.has(op.raw.toLowerCase()) ||
      (isFlagLike(value) && !value.quoted)
    ) {
      refuse('arg:Where-Object form')
    }
  }
}

const COMMANDS: Record<string, Command> = {
  pwd: noArgs('pwd', 'alias'),
  echo: ECHO,
  date: {
    canonical: 'date',
    dialect: 'native',
    check: (args, ctx) => {
      const parsed = parseArgs(args, DATE)
      for (const p of parsed.positionals) {
        if (!p.tok.posix.startsWith('+')) refuse(`arg:date ${p.tok.raw}`)
        checkText(p.tok, 'native')
      }
      checkValues(parsed, ctx, DATE)
    }
  },
  wc: specCommand(WC, 'paths'),
  cat: specCommand(CAT, 'paths', 'Get-Content'),
  type: specCommand({ ...CAT, name: 'type' }, 'paths', 'Get-Content'),
  head: specCommand(HEAD_TAIL('head'), 'paths'),
  tail: specCommand(HEAD_TAIL('tail'), 'paths'),
  grep: patternCommand(GREP, ['-e']),
  rg: patternCommand(RG, ['-e', '--files']),
  find: { canonical: 'find', dialect: 'native', check: checkFind },
  ls: specCommand(LS, 'paths', 'Get-ChildItem'),
  dir: specCommand({ ...LS, name: 'dir' }, 'paths', 'Get-ChildItem'),
  git: { canonical: 'git', dialect: 'native', check: checkGit },
  'get-childitem': specCommand(GCI, 'paths'),
  gci: specCommand(GCI, 'paths'),
  'get-content': specCommand(GC, 'paths'),
  gc: specCommand(GC, 'paths'),
  'select-string': patternCommand(SLS, ['-Pattern']),
  sls: patternCommand(SLS, ['-Pattern']),
  'test-path': specCommand(TEST_PATH, 'paths'),
  'get-location': noArgs('Get-Location', 'cmdlet'),
  gl: noArgs('Get-Location', 'cmdlet'),
  'get-command': specCommand(GCM, 'paths'),
  gcm: specCommand(GCM, 'paths'),
  'select-object': specCommand(SELECT, 'names'),
  select: specCommand(SELECT, 'names'),
  'where-object': WHERE,
  'measure-object': specCommand(MEASURE, 'names'),
  measure: specCommand(MEASURE, 'names'),
  'format-table': specCommand(FT, 'names'),
  ft: specCommand(FT, 'names'),
  'write-output': specCommand(WRITE_OUTPUT, 'text'),
  'write-host': specCommand(WRITE_HOST, 'text')
}

/**
 * Refused by name so a reviewer sees intent, not just absence. `write` is here
 * although the ADR aliases it to Write-Output: to bash it is util-linux
 * `write`, which messages another user's terminal.
 */
const REFUSED_NAMES: ReadonlySet<string> = new Set([
  'sed',
  'awk',
  'xargs',
  'jq',
  'env',
  'printenv',
  'set',
  'export',
  'curl',
  'wget',
  'gh',
  'ssh',
  'scp',
  'docker',
  'wsl',
  'cmd',
  'pwsh',
  'powershell',
  'bash',
  'sh',
  'source',
  '.',
  'eval',
  'exec',
  'sudo',
  'kill',
  'ps',
  'node',
  'npm',
  'npx',
  'write',
  'out-file',
  'tee-object',
  'get-clipboard',
  'get-itemproperty',
  'get-variable',
  'get-history',
  'get-credential',
  'get-wmiobject',
  'get-ciminstance',
  'get-process',
  'iex',
  'icm',
  'sc',
  '%',
  '?',
  '&',
  'h',
  'r'
])
const REFUSED_PREFIXES = [
  'python',
  'bun',
  'uv',
  'invoke-',
  'start-',
  'set-',
  'new-',
  'remove-',
  'add-',
  'import-',
  'export-'
] as const

/**
 * What a Get-Content / Select-String may read from the pipeline without
 * reaching a path nobody checked: native programs emit plain strings (no path
 * property to bind); Get-Content and Select-String only emit paths of files
 * they were already allowed to read; Select-Object / Where-Object pass those
 * through.
 */
const SAFE_UPSTREAM: ReadonlySet<string> = new Set([
  'git',
  'rg',
  'grep',
  'find',
  'head',
  'tail',
  'wc',
  'Get-Content',
  'Select-String',
  'Select-Object',
  'Where-Object'
])

/** What may format Get-Command's objects, and the properties that would print file contents. */
const GCM_DOWNSTREAM: ReadonlySet<string> = new Set([
  'Select-Object',
  'Format-Table',
  'Where-Object',
  'Measure-Object'
])
const GCM_CONTENT_PROPS = /^(ScriptContents|ScriptBlock|Definition)$/i

/** Cmdlets that bind piped STRINGS to a path/name parameter, or read one off a piped object. */
const PIPELINE_START_ONLY: ReadonlySet<string> = new Set([
  'Get-ChildItem',
  'Test-Path',
  'Get-Command'
])

/**
 * After a `|`, PowerShell binds piped FileInfo / MatchInfo / CommandInfo
 * objects to a cmdlet's path parameter: `ls | cat` READS every listed file
 * (bash just prints the names), `Get-Content list.txt | Get-ChildItem` lists
 * whatever the file names. So:
 * - Get-ChildItem, Test-Path and Get-Command (which bind plain strings by
 *   value) may only start a pipeline;
 * - only a formatter may follow Get-Command, and never on a property that
 *   holds a script's contents (`ScriptContents`, `ScriptBlock`, `Definition`):
 *   its objects point at files outside the workspace;
 * - Get-Content and Select-String may follow only {@link SAFE_UPSTREAM}.
 */
function checkPipePosition(cmd: Command, upstream: readonly Command[], args: Tok[]): void {
  if (upstream.length === 0) return
  if (PIPELINE_START_ONLY.has(cmd.canonical)) refuse(`pipe:${cmd.canonical} after |`)
  if (upstream.some((u) => u.canonical === 'Get-Command')) {
    if (!GCM_DOWNSTREAM.has(cmd.canonical)) refuse('pipe:after Get-Command')
    for (const a of args) {
      for (const piece of winPieces(a)) {
        if (GCM_CONTENT_PROPS.test(piece)) refuse(`pipe:Get-Command ${piece}`)
      }
    }
  }
  if (cmd.canonical === 'Get-Content' || cmd.canonical === 'Select-String') {
    const bad = upstream.find((u) => !SAFE_UPSTREAM.has(u.canonical))
    if (bad) refuse(`pipe:${cmd.canonical} after ${bad.canonical}`)
  }
}

function resolveCommand(tok: Tok): Command {
  if (tok.quoted || tok.raw !== tok.posix) refuse('cmd:quoted')
  if (/[\\/]/.test(tok.raw)) refuse('cmd:path')
  let name = tok.raw.toLowerCase()
  if (name.endsWith('.exe')) name = name.slice(0, -4)
  if (REFUSED_NAMES.has(name) || REFUSED_PREFIXES.some((p) => name.startsWith(p))) {
    refuse(`cmd:refused ${name}`)
  }
  const cmd = Object.prototype.hasOwnProperty.call(COMMANDS, name) ? COMMANDS[name] : undefined
  if (!cmd) refuse(`cmd:unknown ${name}`)
  return cmd
}

/**
 * Windows PowerShell 5.1 passes native arguments the legacy way: it wraps an
 * argument containing a space in quotes WITHOUT escaping embedded quotes or a
 * trailing backslash, and drops empty arguments. So `rg 'a b\' ' --pre=calc'`
 * reaches rg as a separate `--pre=calc`, and `""` shifts every later argument
 * left. None of these is needed by a plain read.
 */
function checkNativeArg(t: Tok): void {
  if (t.win.includes('"')) refuse('token:embedded-quote')
  if (/\s/.test(t.win) && t.win.endsWith('\\')) refuse('token:trailing-backslash')
  if (t.win === '') refuse('token:empty-arg')
}

// ── Top level ─────────────────────────────────────────────────────────────────

function summarize(command: string): string {
  const s = normalizeWs(command)
  return s.length <= READ_ONLY_SUMMARY_MAX ? s : `${s.slice(0, READ_ONLY_SUMMARY_MAX - 1)}…`
}

function effectiveCwd(input: Record<string, unknown>, base: Omit<Ctx, 'effCwd'>): string {
  const session = base.roots[0]
  // A directory override we do not model means we do not know where it runs.
  if (input.cwd !== undefined || input.directory !== undefined) refuse('input:cwd')
  const workdir = input.workdir
  if (workdir === undefined || workdir === null || workdir === '') return session
  if (typeof workdir !== 'string') refuse('input:workdir')
  if (badCodePoint(workdir) !== undefined) refuse('input:workdir char')
  // opencode resolves `workdir` against the session directory, unparsed by any shell.
  const probe: Ctx = { ...base, effCwd: session }
  const tok: Tok = {
    raw: workdir,
    posix: workdir,
    win: workdir,
    quoted: false,
    uglob: false,
    ucomma: false
  }
  try {
    checkPath(tok, probe, { single: true })
  } catch (err) {
    if (err instanceof Refusal) refuse(`workdir ${err.reason}`)
    throw err
  }
  return resolveTarget(session, workdir, base.platform).full
}

function check(
  action: { toolName: string; input: Record<string, unknown> },
  scope: ReadOnlyScope
): ReadOnlyVerdict {
  if (!isShellToolName(action.toolName)) return { ok: false, reason: 'not-shell' }
  const input = action.input ?? {}
  const command = input.command
  if (typeof command !== 'string' || command.trim().length === 0) refuse('input:command')

  // 1. Text hygiene.
  if (command.length > READ_ONLY_MAX_LENGTH) refuse('text:too-long')
  textHygiene(command)

  const base = buildCtx(scope)
  const ctx: Ctx = { ...base, effCwd: effectiveCwd(input, base) }

  // 2. Lex.
  const segments = lex(command)

  // The user's Bash deny/ask rules, over the whole command: every segment,
  // every spelling of the program, any word order (ADR-085 §1).
  const hit = denyAskHit(command, { deny: scope.rules?.deny ?? [], ask: scope.rules?.ask ?? [] })
  if (hit) refuse(`rule:Bash ${hit.rule}`)

  // 3. Per segment.
  let pipeline: Command[] = []
  let needsGitCheck = false
  for (const seg of segments) {
    if (seg.tokens.length === 0) refuse('segment:empty')
    if (seg.op !== '|') pipeline = []
    const [head, ...args] = seg.tokens
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(head.raw)) refuse('segment:assignment')
    const cmd = resolveCommand(head)
    if (cmd.canonical !== 'git') {
      for (const t of args) if (t.raw.includes('~')) refuse('token:~')
    }
    // bash would glob-expand an unquoted `*`/`?` into arbitrary words.
    if (cmd.dialect !== 'cmdlet') {
      for (const t of args) if (t.uglob) refuse('token:unquoted-glob')
    }
    // Only native programs get PowerShell's legacy argv re-quoting; cmdlets and
    // aliases receive their arguments as .NET strings, never a command line.
    if (cmd.dialect === 'native') for (const t of args) checkNativeArg(t)
    checkPipePosition(cmd, pipeline, args)
    cmd.check(args, ctx)
    if (cmd.canonical === 'git') needsGitCheck = true
    pipeline.push(cmd)
  }

  return { ok: true, summary: summarize(command), needsGitCheck }
}
