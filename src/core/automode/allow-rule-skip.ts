/**
 * ADR-085 §4 — in auto mode, a narrow user allow rule skips the judge.
 *
 * ADR-083 §3 kept a deliberate deviation from cli.js: in auto mode EVERY user
 * allow rule was stripped, so an allowed action reached the judge (1.5–7 s)
 * instead of running unreviewed — because pattern matching could be evaded by
 * reordering (`git push origin main --force` past `Bash(git push --force:*)`).
 * ADR-085 S1–S4 closed that evasion: the robust deny/ask matcher runs
 * host-side on every call in every mode, and the strict coverage check is
 * word-boundary prefix over ADR-084's lexer. Owner ruling 1 therefore
 * re-adopts Claude Code parity — an allow rule cli.js would keep as a direct
 * allow in auto mode (`docs/protocol-cc/14-auto-mode-classifier.md` §3.0)
 * skips ClaudeUI's judge too — PLUS safety checks cli.js does not make:
 *
 * - an allow rule for a launcher never covers what the launcher runs unless
 *   the rule names it (`Bash(bun run test:*)` yes, `Bash(npm:*)` over
 *   `npm exec -- git push --force` no); likewise a destructive git subcommand
 *   (`reset --hard`, `clean -f`, a forced push, …) needs a rule that names it
 *   (`Bash(git reset --hard:*)` yes, `Bash(git:*)` no);
 * - write-class programs must target the workspace, never a secret-shaped or
 *   agent-control name (`rm -rf .git`, `rm -rf .*`, `tee .husky/pre-commit`
 *   go to the judge), and never delete a scope root (`rm -rf .`, `rm -rf *`,
 *   `find . -delete`, `mv . x` — a moved source leaves its place);
 * - the user's `Read(...)` deny rules bind Bash readers;
 * - a rule a deny/ask rule carves into (`Bash(git:*)` with
 *   `deny Bash(git push --force:*)`) is not usable, so the judge keeps seeing
 *   every git command.
 *
 * Ruling 2: MCP rules skip at tool and server level.
 *
 * The engine rulesets keep stripping every allow in auto mode
 * (`withoutAllowRules`), so every allowed call still reaches the HOST, which
 * decides here: skip the judge, or judge as before. Nothing here changes what
 * the judge environment lists (ADR-083 §3 keeps listing allow rules).
 *
 * **Pure** (no I/O; `realpath` is injected) and **never throws** — an
 * internal failure is a refusal (`internal`), and the call goes to the judge.
 * The engine glue is `allow-rule-gate.ts`.
 */
import { wildcardMatch } from '../opencode/wildcard'
import {
  allowCovers,
  allowRuleShape,
  denyAskHit,
  isCarvedOut,
  isClassifierBypassingRule,
  programName,
  programPositions,
  ruleNamesLaunchedProgram
} from '../permissions/shell-rules'
import {
  AGENT_CONTROL_DIRS,
  AGENT_CONTROL_FILES,
  isAgentControlPath,
  isAgentControlTarget
} from './agent-control-paths'
import {
  checkPathOperands,
  GLOB_ONLY_RE,
  isSensitiveComponent,
  matchesSecretSample,
  READ_ONLY_SUMMARY_MAX,
  type ReadOnlyScope
} from './read-only'
import { parseRuleText, type StrictToken } from './shell-strict-lexer'

// ── Public contract ───────────────────────────────────────────────────────────

export type AllowSkipAction =
  | { kind: 'shell'; command: string; workdir?: string }
  | { kind: 'webfetch'; url: string }
  /** cli.js's `WebSearch` takes no specifier: a bare rule only. */
  | { kind: 'websearch' }
  | { kind: 'skill'; name: string }
  /** `server` in its Claude form; `tool` in the ENGINE's key form (see `mcpToolKey`). */
  | { kind: 'mcp'; server: string; tool?: string }

export interface AllowSkipScope {
  cwd: string
  additionalDirectories: readonly string[]
  rules: { allow: readonly string[]; ask: readonly string[]; deny: readonly string[] }
  /** User settings `autoMode.classifyAllShell === true` (cli.js §3.0): every Bash/PowerShell rule is unusable. */
  classifyAllShell: boolean
  platform?: NodeJS.Platform
  /** As `ReadOnlyScope.realpath`. */
  realpath: (absPath: string) => string | undefined | null
  /** How a rule's MCP tool name compares to `action.tool`: identity (pi) or opencode's sanitiser. Default identity. */
  mcpToolKey?: (ruleTool: string) => string
}

export type AllowSkipVerdict =
  /** `rule` = the first segment's rule; `rules` = one per segment (deduped, in order). */
  { allow: true; rule: string; rules: string[]; summary: string } | { allow: false; reason: string }

/**
 * Reason tokens (stable; the debug log and the tests pin them):
 * `rule:none-usable`, `rule:carved-out <deny/ask rule>`, `rule:classifier-bypassing`,
 * `rule:classify-all-shell`, `rule:dispatch-tool`, `coverage:uncovered`,
 * `coverage:refused`, `hit:<deny|ask> <rule>`, `launcher:<program>`,
 * `launcher:unnamed <program>`, `git:unnamed <subcommand>`,
 * `write:<path reason>` (among them
 * `write:path:scope-root`, `write:path:scope-root-glob`,
 * `write:path:pattern-may-match-sensitive <part>`,
 * `write:path:pattern-may-match-agent-control <part>`,
 * `write:path:agent-control`), `write:find:<sensitive|agent-control|
 * pattern-may-match-sensitive|pattern-may-match-agent-control> <value>`,
 * `write:find:regex`, `read-deny:<rule>`, `read-deny:glob`,
 * `input:no-command`, `mcp:unknown-server`, `url:invalid`, `internal`.
 */
export function allowRuleSkip(action: AllowSkipAction, scope: AllowSkipScope): AllowSkipVerdict {
  try {
    switch (action.kind) {
      case 'shell':
        return shellSkip(action, scope)
      case 'webfetch':
        return webfetchSkip(action.url, scope)
      case 'websearch':
        return matched(
          usableOf(scope).find((r) => isBare(r, 'WebSearch')),
          'websearch'
        )
      case 'skill':
        return matched(
          usableOf(scope).find((r) => {
            const parsed = parseRuleText(r)
            return (
              parsed?.tool === 'Skill' &&
              (parsed.specifier === undefined || parsed.specifier === action.name)
            )
          }),
          summarize(`skill ${action.name}`)
        )
      case 'mcp':
        return mcpSkip(action, scope)
      default:
        return refused('internal')
    }
  } catch {
    return refused('internal')
  }
}

/**
 * Which of the user's allow rules may skip the judge at all. A rule is
 * unusable when it is one of cli.js's classifier-bypassing shapes
 * (`isClassifierBypassingRule`, `ZIe` parity: bare / `*` Bash|PowerShell, the
 * launcher shapes, `Agent`/`Task`/`Monitor`/`AppifactRepl`); a Bash or
 * PowerShell rule while `classifyAllShell` is set; a rule that would cover the
 * dispatch tool (`mcp__claude-ui-collab…`, and `mcp__claudeui…` — the
 * opencode hosted server's name, reserved by `claude-mcp-bridge.ts` but still
 * writable as a rule string); or a Bash rule a Bash deny/ask rule carves into
 * (`isCarvedOut`, positional). Non-Bash rules are never carved out.
 * Order-preserving; never throws (an internal failure: nothing usable).
 */
export function usableAllowRules(
  rules: { allow: readonly string[]; ask?: readonly string[]; deny?: readonly string[] },
  opts: { classifyAllShell: boolean }
): { usable: string[]; unusable: Array<{ rule: string; reason: string }> } {
  const usable: string[] = []
  const unusable: Array<{ rule: string; reason: string }> = []
  try {
    const denyAsk = { deny: rules.deny ?? [], ask: rules.ask ?? [] }
    for (const rule of rules.allow) {
      const why = unusableReason(rule, denyAsk, opts)
      if (why === undefined) usable.push(rule)
      else unusable.push({ rule, reason: why })
    }
    return { usable, unusable }
  } catch {
    // Not `rules.allow.map` unguarded: a malformed `rules` must not throw here either.
    const allow: unknown = rules?.allow
    return {
      usable: [],
      unusable: Array.isArray(allow)
        ? (allow as string[]).map((rule) => ({ rule, reason: 'internal' }))
        : []
    }
  }
}

// ── Plumbing ──────────────────────────────────────────────────────────────────

function refused(reason: string): AllowSkipVerdict {
  return { allow: false, reason }
}

function normalizeWs(s: string): string {
  return s.trim().replace(/\s+/g, ' ')
}

/** For the debug line only, capped like the read-only path's summary. */
function summarize(text: string): string {
  const s = normalizeWs(text)
  return s.length <= READ_ONLY_SUMMARY_MAX ? s : `${s.slice(0, READ_ONLY_SUMMARY_MAX - 1)}…`
}

function matched(rule: string | undefined, summary: string): AllowSkipVerdict {
  return rule === undefined
    ? refused('rule:none-usable')
    : { allow: true, rule, rules: [rule], summary }
}

function toolOf(rule: string): string | undefined {
  return parseRuleText(rule)?.tool
}

function isBare(rule: string, tool: string): boolean {
  const parsed = parseRuleText(rule)
  return parsed?.tool === tool && parsed.specifier === undefined
}

/** A rule for the dispatch tool's server: Claude/pi `claude-ui-collab`, opencode `claudeui`. */
function isDispatchServer(server: string): boolean {
  const s = server.toLowerCase()
  return s.startsWith('claude-ui-collab') || s.startsWith('claudeui')
}

function unusableReason(
  rule: string,
  denyAsk: { deny: readonly string[]; ask: readonly string[] },
  opts: { classifyAllShell: boolean }
): string | undefined {
  if (isClassifierBypassingRule(rule)) return 'rule:classifier-bypassing'
  const tool = toolOf(rule)
  if (opts.classifyAllShell && (tool === 'Bash' || tool === 'PowerShell')) {
    return 'rule:classify-all-shell'
  }
  if (tool?.startsWith('mcp__') && isDispatchServer(tool.slice('mcp__'.length))) {
    return 'rule:dispatch-tool'
  }
  if (tool === 'Bash') {
    const carvedBy = isCarvedOut(rule, denyAsk)
    if (carvedBy !== undefined) return `rule:carved-out ${carvedBy}`
  }
  return undefined
}

function usableOf(scope: AllowSkipScope): string[] {
  return usableAllowRules(scope.rules, { classifyAllShell: scope.classifyAllShell }).usable
}

// ── Shell ─────────────────────────────────────────────────────────────────────

/** Write programs that DELETE their path operands: a scope root is never one (`rm -rf .`). */
const DELETE_PROGRAMS: ReadonlySet<string> = new Set([
  'rm',
  'rmdir',
  'remove-item',
  'ri',
  'del',
  'erase',
  'rd'
])

/** Programs whose path operands are WRITE targets (S1's alias table + the PowerShell spellings). */
/** Write programs that MOVE their sources away: a source leaves its place, like a delete (`mv . x`). */
const MOVE_PROGRAMS: ReadonlySet<string> = new Set(['mv', 'move-item', 'mi', 'move'])

const WRITE_PROGRAMS: ReadonlySet<string> = new Set([
  ...DELETE_PROGRAMS,
  ...MOVE_PROGRAMS,
  'cp',
  'copy-item',
  'cpi',
  'copy',
  'touch',
  'mkdir',
  'md',
  'new-item',
  'ni',
  'tee'
])

/** Programs whose path operands are READ: the user's `Read(...)` deny rules bind them. */
const READER_PROGRAMS: ReadonlySet<string> = new Set([
  'cat',
  'head',
  'tail',
  'less',
  'more',
  'type',
  'get-content',
  'gc',
  'grep',
  'rg',
  'select-string',
  'sls'
])

/** One view of a segment: the tokens, and their values in that reading. */
interface View {
  tokens: readonly StrictToken[]
  values: readonly string[]
}

function shellSkip(
  action: { command: string; workdir?: string },
  scope: AllowSkipScope
): AllowSkipVerdict {
  const command = action.command
  if (typeof command !== 'string' || command.trim().length === 0) {
    return refused('input:no-command')
  }
  // Defensive: both hosts refused a deny hit and sent an ask hit to the human
  // before calling this; the module must not depend on that.
  const hit = denyAskHit(command, { deny: scope.rules.deny, ask: scope.rules.ask })
  if (hit) return refused(`hit:${hit.tier} ${hit.rule}`)

  const { usable, unusable } = usableAllowRules(scope.rules, {
    classifyAllShell: scope.classifyAllShell
  })
  // `PowerShell(...)` rules are cli.js's PowerShell tool — ClaudeUI has none.
  const bash = usable.filter((r) => toolOf(r) === 'Bash')
  // Why nothing usable covers: the first unusable Bash rule that WOULD have
  // (a debug line worth having — "why did my Bash(git:*) not skip?").
  const whyNot = (): string | undefined =>
    unusable.find((u) => toolOf(u.rule) === 'Bash' && allowCovers(command, [u.rule], 'strict'))
      ?.reason
  if (bash.length === 0) return refused(whyNot() ?? 'rule:none-usable')
  // Refuses whatever ADR-084's strict lexer refuses (`$`, redirections,
  // newlines, unbalanced quotes …) and anything past the S1 length cap.
  const coverage = allowCovers(command, bash, 'strict')
  if (!coverage) return refused(whyNot() ?? 'coverage:uncovered')

  const ro = readOnlyScope(scope)
  const chosen: string[] = []
  for (const seg of coverage.segments) {
    // Strict coverage always carries the tokens; no single rule covering both
    // readings leaves nothing the checks below can vouch for.
    if (!seg.tokens || !seg.rules || seg.rules.length === 0) return refused('coverage:refused')
    const posix = seg.tokens.map((t) => t.posix)
    const win = seg.tokens.map((t) => t.win)
    const views: View[] = [{ tokens: seg.tokens, values: posix }]
    if (win.some((w, k) => w !== posix[k])) views.push({ tokens: seg.tokens, values: win })

    // (a) Launcher-shaped, and destructive git subcommands: some covering rule
    // must name what the segment runs, in every view.
    const covering = seg.rules
    const names = (r: string, v: View): boolean =>
      ruleNames(r, v.values) && ruleNamesGit(r, v.values)
    const rule = covering.find((r) => views.every((v) => names(r, v)))
    if (rule === undefined) {
      if (!covering.some((r) => views.every((v) => ruleNames(r, v.values)))) {
        const view = views.find((v) => !covering.some((r) => ruleNames(r, v.values))) ?? views[0]
        const program = programName(view.values[0])
        return refused(
          ruleNamesLaunchedProgram(view.values, view.values.length)
            ? `launcher:unnamed ${program}`
            : `launcher:${program}`
        )
      }
      const view = views.find((v) => !covering.some((r) => names(r, v))) ?? views[0]
      return refused(`git:unnamed ${destructiveGit(view.values)[0]?.sub ?? 'git'}`)
    }
    if (!chosen.includes(rule)) chosen.push(rule)

    // (b) write targets in scope, clear of secret and agent-control names,
    // never a scope root to delete; (c) Read deny rules on reader paths.
    const ops: Operands = { deletes: [], writes: [], reads: [] }
    for (const view of views) {
      const why = collectOperands(view, ops)
      if (why !== undefined) return refused(why)
    }
    const workdir = action.workdir
    const d = checkPathOperands(ops.deletes, ro, {
      workdir,
      mode: 'write',
      delete: true,
      guard: agentControlGuard
    })
    if (!d.ok) return refused(`write:${d.reason}`)
    const w = checkPathOperands(ops.writes, ro, {
      workdir,
      mode: 'write',
      guard: agentControlGuard
    })
    if (!w.ok) return refused(`write:${w.reason}`)
    const r = checkPathOperands(ops.reads, ro, { workdir, mode: 'read-deny' })
    if (!r.ok) return refused(`read-deny:${r.reason}`)
  }
  return { allow: true, rule: chosen[0], rules: chosen, summary: summarize(command) }
}

/** Does this covering rule name every program the segment runs? An exact rule names its own command. */
function ruleNames(rule: string, values: readonly string[]): boolean {
  const shape = allowRuleShape(rule)
  if (!shape) return false
  return shape.exact || ruleNamesLaunchedProgram(values, shape.words)
}

/**
 * Does this covering rule name every DESTRUCTIVE git subcommand the segment
 * runs? Same principle as the launcher check: a prefix rule names a
 * subcommand when its words reach it (`Bash(git reset --hard:*)`,
 * `Bash(git -C . reset:*)` over `git -C . reset --hard`; `Bash(git:*)` never
 * does), counted from the segment start (past a wrapper too); an exact rule
 * names its own command.
 */
function ruleNamesGit(rule: string, values: readonly string[]): boolean {
  const shape = allowRuleShape(rule)
  if (!shape) return false
  return shape.exact || destructiveGit(values).every((d) => shape.words > d.index)
}

/** git global options that take a VALUE as the next token (when not given as `--opt=value`). */
const GIT_VALUE_OPTIONS: ReadonlySet<string> = new Set([
  '-C',
  '-c',
  '--git-dir',
  '--work-tree',
  '--namespace',
  '--config-env',
  '--exec-path',
  '--super-prefix'
])

/**
 * The destructive git subcommands of one segment view, at every git program
 * position (token 0 and past wrappers): what discards work, history or refs —
 * `reset --hard`, `clean -f`, `checkout -- …` / `checkout <rev> <path>`,
 * `restore`, forced `switch`, `branch -D|-M|-C`, `checkout -B`, `tag -d`,
 * `remote remove|rm`, `submodule deinit -f|--all`, `stash drop|clear`, forced or
 * deleting `push`, `rebase`, `filter-branch`, `update-ref -d`,
 * `reflog expire|delete`, `gc --prune=now|all`, `worktree remove -f`.
 * `index` = the subcommand's token index in the segment.
 */
function destructiveGit(values: readonly string[]): Array<{ sub: string; index: number }> {
  const out: Array<{ sub: string; index: number }> = []
  for (const p of programPositions(values)) {
    if (programName(values[p]) !== 'git') continue
    let k = p + 1
    while (k < values.length && values[k].startsWith('-')) {
      k += GIT_VALUE_OPTIONS.has(values[k]) ? 2 : 1
    }
    if (k >= values.length) continue
    const sub = values[k]
    if (gitSubcommandDestroys(sub, values.slice(k + 1))) out.push({ sub, index: k })
  }
  return out
}

/** A short-option cluster (`-fd`, `-D`) carrying this letter. Case-sensitive. */
function hasShort(args: readonly string[], letter: string): boolean {
  return args.some((a) => /^-[A-Za-z]+$/.test(a) && a.includes(letter))
}

function gitSubcommandDestroys(sub: string, args: readonly string[]): boolean {
  const has = (...flags: string[]): boolean => args.some((a) => flags.includes(a))
  const force = (): boolean => hasShort(args, 'f') || has('--force')
  const nextWord = args.find((a) => !a.startsWith('-'))
  switch (sub) {
    case 'reset':
      return has('--hard')
    case 'clean':
      return force()
    case 'checkout': {
      // `-B` force-creates or RESETS a branch, whatever else is given.
      if (has('--') || force() || has('--discard-changes') || hasShort(args, 'B')) return true
      // `git checkout <rev> <path>` overwrites the path; `-b <name> <start>`
      // names a new branch, not a path.
      let words = 0
      for (let k = 0; k < args.length; k++) {
        if (args[k] === '-b' || args[k] === '--orphan') k++
        else if (!args[k].startsWith('-')) words++
      }
      return words >= 2
    }
    case 'restore':
    case 'rebase':
    case 'filter-branch':
      return true
    case 'switch':
      return force() || has('--discard-changes')
    case 'branch':
      // `-M` / `-C`: forced rename / copy (overwrites the target); `-m` / `-c` are not.
      return (
        hasShort(args, 'D') ||
        hasShort(args, 'M') ||
        hasShort(args, 'C') ||
        ((hasShort(args, 'd') || has('--delete')) && force())
      )
    case 'tag':
      return hasShort(args, 'd') || has('--delete')
    case 'remote':
      return nextWord === 'remove' || nextWord === 'rm'
    case 'submodule':
      return nextWord === 'deinit' && (force() || has('--all'))
    case 'stash':
      return nextWord === 'drop' || nextWord === 'clear'
    case 'push':
      return args.some(
        (a) =>
          a === '--force' ||
          a.startsWith('--force-with-lease') ||
          a === '--force-if-includes' ||
          a === '--delete' ||
          a === '--mirror' ||
          a === '--prune' ||
          a.startsWith('+') ||
          a.startsWith(':') ||
          (/^-[A-Za-z]+$/.test(a) && /[fd]/.test(a))
      )
    case 'update-ref':
      return hasShort(args, 'd')
    case 'reflog':
      return nextWord === 'expire' || nextWord === 'delete'
    case 'gc':
      return args.some((a) => /^--prune=(now|all)$/i.test(a))
    case 'worktree':
      return nextWord === 'remove' && force()
    default:
      return false
  }
}

function readOnlyScope(scope: AllowSkipScope): ReadOnlyScope {
  return {
    cwd: scope.cwd,
    additionalDirectories: [...scope.additionalDirectories],
    platform: scope.platform ?? process.platform,
    rules: {
      allow: [...scope.rules.allow],
      ask: [...scope.rules.ask],
      deny: [...scope.rules.deny]
    },
    realpath: scope.realpath
  }
}

/** Path operands by what the program does with them. */
interface Operands {
  /** Deleted: every write rule, and never a scope root (`rm`, `find … -delete` without a narrowing name filter). */
  deletes: StrictToken[]
  /** Written, moved or created. */
  writes: StrictToken[]
  /** Read: only the user's Read deny rules bind. */
  reads: StrictToken[]
}

/**
 * The delete, write and read operands of one view, at EVERY program position
 * the deny/ask matcher finds (token 0, and past wrappers: `sudo rm …`,
 * `timeout 5 rm …`). Over-collecting is fine — a non-path token resolves
 * under the cwd and passes, or its refusal sends the call to the judge.
 * Returns a refusal when a `find … -delete` name filter could select a
 * secret-shaped or agent-control name.
 */
function collectOperands(view: View, ops: Operands): string | undefined {
  for (const p of programPositions(view.values)) {
    const program = programName(view.values[p])
    const args: View = { tokens: view.tokens.slice(p + 1), values: view.values.slice(p + 1) }
    if (DELETE_PROGRAMS.has(program)) ops.deletes.push(...plainOperands(args))
    else if (MOVE_PROGRAMS.has(program)) {
      const { sources, destination } = moveOperands(args)
      ops.deletes.push(...sources)
      ops.writes.push(...destination)
    } else if (WRITE_PROGRAMS.has(program)) ops.writes.push(...plainOperands(args))
    if (program === 'find' && args.values.includes('-delete')) {
      const why = findFilterRefusal(args.values)
      if (why !== undefined) return why
      const starts = findStarts(args)
      // No start point: find walks `.`.
      if (starts.length === 0) starts.push(CWD_TOKEN)
      ;(findNarrows(args.values) ? ops.writes : ops.deletes).push(...starts)
    }
    if (program === 'sed' && sedInPlace(args.values)) ops.writes.push(...sedFiles(args))
    if (READER_PROGRAMS.has(program)) {
      ops.reads.push(
        ...(program === 'grep' || program === 'rg' ? grepFiles(args) : plainOperands(args))
      )
    }
  }
  return undefined
}

/** `.` as a token: the start point of a `find` that names none. */
const CWD_TOKEN: StrictToken = {
  raw: '.',
  posix: '.',
  win: '.',
  quoted: false,
  uglob: false,
  ucomma: false
}

/** Every agent-control name, as a sample a write glob must not match (`.cl*`, `*.md`). */
const AGENT_CONTROL_SAMPLES: readonly string[] = [...AGENT_CONTROL_DIRS, ...AGENT_CONTROL_FILES]

const GLOB_CHAR_RE = /[*?[]/

/** Could this glob component (with a literal character) match an agent-control name? */
function globMayMatchAgentControl(component: string): boolean {
  return AGENT_CONTROL_SAMPLES.some((sample) => wildcardMatch(sample, component, 'win32'))
}

/**
 * ADR-085 §4 (d), `checkPathOperands`'s `guard` for every write-class operand
 * piece: not an agent-control target as written, against the EFFECTIVE cwd
 * (`isAgentControlTarget` matches a target inside it relative to it, so a
 * session in a `.claude/worktrees/<n>` worktree does not match on every
 * write), and no glob component with a literal character that could match an
 * agent-control name (`.cl*`, `CLAUDE*`, `*.md`) — the agent-control sibling
 * of read-only.ts's secret-sample check. A glob-only component is exempt, as
 * there.
 */
function agentControlGuard(piece: string, effCwd: string): string | undefined {
  if (isAgentControlTarget(piece, effCwd)) return 'path:agent-control'
  for (const part of piece.split(/[\\/]/)) {
    if (!GLOB_CHAR_RE.test(part) || GLOB_ONLY_RE.test(part)) continue
    if (globMayMatchAgentControl(part)) return `path:pattern-may-match-agent-control ${part}`
  }
  return undefined
}

/** `find` primaries whose value is a NAME pattern (a `-path`-style one: a path pattern). */
const FIND_NAME_FILTERS: ReadonlySet<string> = new Set([
  '-name',
  '-iname',
  '-path',
  '-ipath',
  '-wholename',
  '-iwholename',
  '-lname',
  '-ilname'
])

/** `find` operators that can widen a filter past what it names: `-o`, negation, grouping, `,`. */
const FIND_WIDENING_RE = /^(?:-o|-or|!|-not|,|\\?[()])$/

/**
 * ADR-085 §4 (c): the name filters of a `find … -delete`. A literal
 * component must be neither secret-shaped nor an agent-control name; a glob
 * component with a literal character must not match either sample list; the
 * LAST component glob-only (`-name '*'` — find's `*` matches dotfiles) refuses
 * too. `-regex`/`-iregex` is not a glob: the judge decides.
 */
function findFilterRefusal(values: readonly string[]): string | undefined {
  if (values.includes('-regex') || values.includes('-iregex')) return 'write:find:regex'
  for (let k = 0; k + 1 < values.length; k++) {
    if (!FIND_NAME_FILTERS.has(values[k])) continue
    const value = values[k + 1]
    const parts = value.split(/[\\/]/).filter((c) => c !== '' && c !== '.' && c !== '..')
    for (const part of parts) {
      if (GLOB_CHAR_RE.test(part)) {
        if (GLOB_ONLY_RE.test(part)) continue
        if (matchesSecretSample(part)) return `write:find:pattern-may-match-sensitive ${value}`
        if (globMayMatchAgentControl(part)) {
          return `write:find:pattern-may-match-agent-control ${value}`
        }
      } else if (isSensitiveComponent(part)) return `write:find:sensitive ${value}`
    }
    if (isAgentControlPath(value)) return `write:find:agent-control ${value}`
    const last = parts[parts.length - 1]
    if (last === undefined || GLOB_ONLY_RE.test(last)) {
      return `write:find:pattern-may-match-sensitive ${value}`
    }
  }
  return undefined
}

/**
 * Does a name filter narrow what `find … -delete` deletes? Only a filter
 * before the first `-delete` (find evaluates left to right: `-delete -name x`
 * deletes everything), and only with no operator that could widen it
 * (`! -name '*.pyc'`, `-name x -o -delete`). Otherwise the start points are
 * delete targets (`find . -delete` is `rm -rf .`).
 */
function findNarrows(values: readonly string[]): boolean {
  if (values.some((v) => FIND_WIDENING_RE.test(v))) return false
  const del = values.indexOf('-delete')
  return values.some((v, k) => k < del && FIND_NAME_FILTERS.has(v))
}

function isFlag(v: string): boolean {
  return v.length > 1 && v.startsWith('-')
}

/**
 * The value a flag token carries: `--name=value`, PowerShell `-Name:value`,
 * or a short option's attached path (`-t/etc`, `-i.bak`). Empty → none.
 */
function flagValueOf(s: string): string | undefined {
  const eq = s.indexOf('=')
  let value: string | undefined
  if (eq > 0) value = s.slice(eq + 1)
  else if (!s.startsWith('--')) {
    const colon = s.indexOf(':')
    if (colon > 0) value = s.slice(colon + 1)
    else if (/^-[A-Za-z]/.test(s) && /[/\\.]/.test(s.slice(2))) value = s.slice(2)
  }
  return value === '' ? undefined : value
}

/** A flag token's value as a token of its own (both readings), or `undefined`. */
function flagValueToken(tok: StrictToken): StrictToken | undefined {
  const posix = flagValueOf(tok.posix)
  const win = flagValueOf(tok.win)
  if (posix === undefined && win === undefined) return undefined
  const p = posix ?? (win as string)
  return { ...tok, raw: flagValueOf(tok.raw) ?? p, posix: p, win: win ?? p }
}

/** Every token after the program that is not a flag (after `--`: every token), plus flag values. */
function plainOperands(args: View): StrictToken[] {
  const out: StrictToken[] = []
  for (let k = 0; k < args.values.length; k++) {
    const v = args.values[k]
    if (v === '--') {
      out.push(...args.tokens.slice(k + 1))
      break
    }
    if (isFlag(v)) {
      const value = flagValueToken(args.tokens[k])
      if (value) out.push(value)
      continue
    }
    out.push(args.tokens[k])
  }
  return out
}

/**
 * A `mv` / `Move-Item` flag that names the DESTINATION, with its value in the
 * next token: `-t` (or a short cluster ending in `t`), `--target-directory`
 * (or an unambiguous GNU prefix of it, `--t…`), PowerShell `-Destination`
 * (case-insensitive, any prefix from `-Des` — `-D`/`-De` are ambiguous with
 * `-Debug`).
 */
function isMoveDestinationFlag(v: string): boolean {
  if (/^-[a-z]{0,4}t$/.test(v)) return true
  if (v.length >= 3 && '--target-directory'.startsWith(v)) return true
  return v.length >= 4 && '-destination'.startsWith(v.toLowerCase())
}

/** The same flag with its value attached (`--target-directory=d`, `-Destination:d`, `-td`): the value token. */
function attachedMoveDestination(tok: StrictToken, v: string): StrictToken | undefined {
  const sep = v.startsWith('--') ? v.indexOf('=') : v.indexOf(':')
  if (sep > 0 && isMoveDestinationFlag(v.slice(0, sep))) return flagValueToken(tok)
  if (/^-t./.test(v) && !v.startsWith('--')) return sliceToken(tok, 2)
  return undefined
}

/**
 * `mv` / `Move-Item`: the SOURCES (each leaves its place — delete targets) and
 * the DESTINATION (a write target). The destination is a destination flag's
 * value when one is given (then every plain operand is a source), else the
 * LAST plain operand. Other flags' values count as sources: over-checking a
 * non-path is harmless, and an operand of unknown role is checked as the
 * stricter kind.
 */
function moveOperands(args: View): { sources: StrictToken[]; destination: StrictToken[] } {
  const { tokens, values } = args
  const plain: StrictToken[] = []
  const flagValues: StrictToken[] = []
  const destination: StrictToken[] = []
  for (let k = 0; k < values.length; k++) {
    const v = values[k]
    if (v === '--') {
      plain.push(...tokens.slice(k + 1))
      break
    }
    if (!isFlag(v)) {
      plain.push(tokens[k])
      continue
    }
    if (isMoveDestinationFlag(v)) {
      if (k + 1 < tokens.length) destination.push(tokens[++k])
      continue
    }
    const attached = attachedMoveDestination(tokens[k], v)
    if (attached) {
      destination.push(attached)
      continue
    }
    const value = flagValueToken(tokens[k])
    if (value) flagValues.push(value)
  }
  if (destination.length === 0 && plain.length > 0) destination.push(plain.pop() as StrictToken)
  return { sources: [...plain, ...flagValues], destination }
}

/** `find`'s start points: past its leading options (`-H -L -P -O<n> -D <opts> --`), up to the first expression token. */
function findStarts(args: View): StrictToken[] {
  let k = 0
  while (k < args.values.length) {
    const v = args.values[k]
    if (v === '-H' || v === '-L' || v === '-P' || v === '--' || /^-O\d*$/.test(v)) k++
    else if (v === '-D') k += 2
    else break
  }
  const out: StrictToken[] = []
  for (; k < args.values.length; k++) {
    const v = args.values[k]
    if (v.startsWith('-') || v === '!') break
    out.push(args.tokens[k])
  }
  return out
}

/** `sed -i`, `-i.bak`, `-ni`, `-Ei` (a short cluster carrying `i`), `--in-place[=…]`. */
function sedInPlace(values: readonly string[]): boolean {
  return values.some(
    (v) => /^-[A-Za-z]*i/.test(v) || v === '--in-place' || v.startsWith('--in-place=')
  )
}

/**
 * The files `sed -i` rewrites: every non-flag token except the script — the
 * first one when no `-e` / `--expression` / `-f` / `--file` is present, else
 * the values of those flags.
 */
function sedFiles(args: View): StrictToken[] {
  const positional: number[] = []
  let scriptGiven = false
  for (let k = 0; k < args.values.length; k++) {
    const v = args.values[k]
    if (v === '--') {
      for (let j = k + 1; j < args.values.length; j++) positional.push(j)
      break
    }
    if (v === '-e' || v === '--expression' || v === '-f' || v === '--file') {
      scriptGiven = true
      k++
      continue
    }
    if (v.startsWith('--expression=') || v.startsWith('--file=')) {
      scriptGiven = true
      continue
    }
    if (/^-[A-Za-z]/.test(v)) {
      // A short cluster: letters are options until `i` (the rest is its
      // suffix); `e` / `f` take the rest, or the next token; `l` takes a number.
      for (let c = 1; c < v.length; c++) {
        const letter = v[c]
        if (letter === 'i') break
        if (letter === 'e' || letter === 'f' || letter === 'l') {
          if (letter !== 'l') scriptGiven = true
          if (c === v.length - 1) k++
          break
        }
      }
      continue
    }
    if (isFlag(v)) continue
    positional.push(k)
  }
  if (!scriptGiven) positional.shift()
  return positional.map((k) => args.tokens[k])
}

/**
 * The files `grep` / `rg` read: every non-flag token and flag value except the
 * PATTERN — the first positional when no `-e` / `--regexp` / `-f` / `--file`
 * is present, and the values of `-e` / `--regexp` (a `-f` value is a file it
 * reads, so it stays).
 */
function grepFiles(args: View): StrictToken[] {
  const { tokens, values } = args
  const files: StrictToken[] = []
  const positional: StrictToken[] = []
  let patternGiven = false
  for (let k = 0; k < values.length; k++) {
    const v = values[k]
    if (v === '--') {
      positional.push(...tokens.slice(k + 1))
      break
    }
    if (v === '-e' || v === '--regexp' || v.startsWith('--regexp=')) {
      patternGiven = true
      if (!v.includes('=')) k++
      continue
    }
    if (v === '-f' || v === '--file' || v.startsWith('--file=')) {
      patternGiven = true
      const value = v.includes('=') ? flagValueToken(tokens[k]) : tokens[++k]
      if (value) files.push(value)
      continue
    }
    if (/^-[A-Za-z]/.test(v)) {
      // A short cluster carrying `e` (a pattern) or `f` (a pattern FILE):
      // its value is the rest of the cluster, or the next token.
      const at = v.slice(1).search(/[ef]/)
      if (at >= 0) {
        patternGiven = true
        const offset = at + 2
        const attached = v.length > offset
        if (v[at + 1] === 'f') {
          const value = attached ? sliceToken(tokens[k], offset) : tokens[k + 1]
          if (value) files.push(value)
        }
        if (!attached) k++
        continue
      }
    }
    if (isFlag(v)) {
      const value = flagValueToken(tokens[k])
      if (value) files.push(value)
      continue
    }
    positional.push(tokens[k])
  }
  // Without -e / -f, the first positional is the pattern.
  return [...files, ...(patternGiven ? positional : positional.slice(1))]
}

/** A token from `offset` on, in every reading. */
function sliceToken(tok: StrictToken, offset: number): StrictToken {
  return {
    ...tok,
    raw: tok.raw.slice(offset),
    posix: tok.posix.slice(offset),
    win: tok.win.slice(offset)
  }
}

// ── Non-shell ─────────────────────────────────────────────────────────────────

/** `WebFetch` bare, or `WebFetch(domain:<d>)` — the only specifier cli.js supports. */
function webfetchSkip(url: string, scope: AllowSkipScope): AllowSkipVerdict {
  const rules = usableOf(scope).filter((r) => toolOf(r) === 'WebFetch')
  if (rules.length === 0) return refused('rule:none-usable')
  const summary = summarize(`webfetch ${url}`)
  const bare = rules.find((r) => isBare(r, 'WebFetch'))
  if (bare) return matched(bare, summary)
  let host: string
  try {
    host = new URL(url).hostname.toLowerCase()
  } catch {
    return refused('url:invalid')
  }
  const rule = rules.find((r) => {
    const m = /^domain:(.+)$/.exec(parseRuleText(r)?.specifier ?? '')
    if (!m) return false
    const d = m[1].trim().toLowerCase()
    return d !== '' && (host === d || host.endsWith(`.${d}`))
  })
  return matched(rule, summary)
}

/**
 * An MCP rule's tool name, as the pi ladder's `mcpRuleMatches` reads it:
 * `mcp__<server>` or `mcp__<server>__*` → server level, `mcp__<server>__<tool>`
 * → tool level (the server runs to the next `__`). `null` when not one.
 */
function parseMcpRuleTool(tool: string): { server: string; tool?: string } | null {
  if (!tool.startsWith('mcp__')) return null
  const rest = tool.slice('mcp__'.length)
  const sep = rest.indexOf('__')
  const server = sep < 0 ? rest : rest.slice(0, sep)
  if (!server) return null
  const name = sep < 0 ? '' : rest.slice(sep + 2)
  return name === '' || name === '*' ? { server } : { server, tool: name }
}

function mcpSkip(
  action: { server: string; tool?: string },
  scope: AllowSkipScope
): AllowSkipVerdict {
  if (!action.server) return refused('mcp:unknown-server')
  // The dispatch tool is never skipped (its rules are unusable anyway).
  if (isDispatchServer(action.server)) return refused('rule:dispatch-tool')
  const key = scope.mcpToolKey ?? ((t: string) => t)
  const rule = usableOf(scope).find((r) => {
    const parsed = parseRuleText(r)
    // A rule that still carries a specifier matches nothing (Claude's MCP syntax has none).
    if (!parsed || parsed.specifier !== undefined) return false
    const mcp = parseMcpRuleTool(parsed.tool)
    if (!mcp || mcp.server !== action.server) return false
    return mcp.tool === undefined || (action.tool !== undefined && key(mcp.tool) === action.tool)
  })
  return matched(
    rule,
    summarize(`mcp ${action.server}${action.tool !== undefined ? `__${action.tool}` : ''}`)
  )
}
