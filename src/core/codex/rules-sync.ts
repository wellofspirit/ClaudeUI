/**
 * Compile the user's Claude Bash permission rules into a ClaudeUI-owned Codex
 * execpolicy file at `$CODEX_HOME/rules/claudeui.rules`.
 *
 * ## Why a rule file at all
 *
 * Under Auto, ClaudeUI's own evaluator never sees a Codex action — Codex's
 * native reviewer decides — so a Claude permission rule does not bind there.
 * Codex's execpolicy runs BEFORE that reviewer (`core/src/exec_policy.rs`, and
 * the `rules` probe in `src/integration/codex/codex-auto-review-probe.
 * integration.test.ts` pins it at runtime): a `forbidden` prefix rule blocks a
 * command in every approval policy with no round trip and no review, and an
 * `allow` rule skips the ask. This file is therefore the only place a user's
 * `Bash(...)` deny rule can reach a Codex turn.
 *
 * ## The trade-offs this accepts, deliberately
 *
 * - An `allow` rule runs UNSANDBOXED and unreviewed in every mode, Auto
 *   included (`exec_policy.rs` maps `Decision::Allow` to
 *   `ExecApprovalRequirement::Skip`). That is the user's own rule, but it is a
 *   wider grant than the same rule buys on the Claude engine.
 * - An EXACT deny (`Bash(git push)`) is emitted as a PREFIX, which over-matches
 *   — it also forbids longer commands starting with those tokens. Over-matching
 *   a deny only narrows, so it is accepted and stated in the file header. An
 *   exact ALLOW is skipped instead, because a prefix would WIDEN it.
 * - Anything that cannot be expressed as a plain argv prefix is skipped and
 *   listed in the header, never approximated.
 * - USER scope only. The file is global to the user config layer, so compiling
 *   project/local rules would leak one project's allows into every other.
 *
 * ## Known gap
 *
 * Codex only sees bare argv after it strips its own `/bin/zsh -lc` wrapper, and
 * it can only strip that wrapper for a simple command. A model command carrying
 * shell metacharacters (`echo x > f`) stays `["/bin/zsh", "-lc", …]` on the
 * wire, which no `["echo"]` prefix rule matches. Compiled rules gate simple
 * commands; they are not a shell-parsing sandbox.
 */

import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { ClaudePermissions } from '../../shared/types'
import { parseClaudeRule } from '../opencode/permission-compiler'
import { loadClaudePermissions } from '../services/claude-settings'
import { logger } from '../services/logger'
import { codexBinaryAvailable } from './codex-locate'
import { splitShellWords } from './command-text'

const LOG = 'CodexRulesSync'

/** Directory Codex scans per config layer (`RULES_DIR_NAME` in `exec_policy.rs`). */
const RULES_DIR = 'rules'
/** The one file this module owns. Nothing else under `$CODEX_HOME` is touched. */
const RULES_FILE = 'claudeui.rules'

/** A rule that could not be expressed as an argv prefix, with the reason. */
export interface SkippedClaudeRule {
  /** The rule string exactly as it appears in settings.json. */
  rule: string
  reason: string
}

/** One emitted `prefix_rule`. */
interface CompiledPrefixRule {
  decision: 'forbidden' | 'allow'
  tokens: string[]
  justification: string
}

export interface CompiledExecpolicy {
  /** Full file content, header comments included. */
  text: string
  /** sha256 over everything in `text` except the hash line itself. */
  hash: string
  skipped: SkippedClaudeRule[]
}

export interface CodexRulesSyncResult {
  wrote: boolean
  /** Where the file lives (or would), whether or not anything was written. */
  path: string
  skipped: SkippedClaudeRule[]
}

/** Glob metacharacters a Claude specifier may use that a prefix cannot express. */
const GLOB_META = /[*?[]/

/**
 * Starlark string literal. Backslash, quote and the C0 controls are escaped;
 * everything else (UTF-8 included) is emitted literally, which Starlark source
 * accepts. The control-character branch matters: a settings.json rule is
 * attacker-influenced text, and an unescaped newline inside a pattern token
 * would end the `prefix_rule` line and let the remainder parse as its own
 * statement.
 */
function starlarkString(value: string): string {
  let out = '"'
  for (const char of value) {
    if (char === '\\') out += '\\\\'
    else if (char === '"') out += '\\"'
    else if (char === '\n') out += '\\n'
    else if (char === '\r') out += '\\r'
    else if (char === '\t') out += '\\t'
    else {
      const code = char.codePointAt(0) ?? 0
      out += code < 0x20 || code === 0x7f ? `\\x${code.toString(16).padStart(2, '0')}` : char
    }
  }
  return `${out}"`
}

/**
 * Flatten a rule string onto ONE comment line. Same injection concern as
 * {@link starlarkString}: a rule containing a newline would otherwise end the
 * comment and let the rest of it parse as a `prefix_rule` the user never wrote.
 */
function commentText(value: string): string {
  // eslint-disable-next-line no-control-regex
  return value.replace(/[\u0000-\u001f\u007f]+/g, ' ').trim()
}

/**
 * Turn one tier of Claude rules into `prefix_rule`s, recording every rule that
 * cannot become one. `tier` decides both the emitted decision and whether an
 * EXACT specifier is usable (see the module header).
 */
function compileTier(
  rules: readonly string[],
  tier: 'deny' | 'allow',
  out: CompiledPrefixRule[],
  skipped: SkippedClaudeRule[]
): void {
  const decision = tier === 'deny' ? 'forbidden' : 'allow'
  for (const raw of rules) {
    const parsed = parseClaudeRule(raw)
    if (!parsed) continue // blank entry — nothing to report
    if (parsed.tool !== 'Bash') {
      skipped.push({ rule: raw, reason: `not a Bash rule (${parsed.tool})` })
      continue
    }
    if (!parsed.specifier) {
      skipped.push({ rule: raw, reason: 'whole-tool rule has no command prefix' })
      continue
    }
    const asPrefix = parsed.specifier.match(/^(.+):\*$/)
    const pattern = asPrefix ? asPrefix[1] : parsed.specifier
    if (!asPrefix && tier === 'allow') {
      skipped.push({ rule: raw, reason: 'exact allow cannot be a prefix' })
      continue
    }
    if (GLOB_META.test(pattern)) {
      skipped.push({ rule: raw, reason: 'glob metacharacters cannot be a prefix' })
      continue
    }
    const tokens = splitShellWords(pattern)
    if (!tokens || tokens.length === 0) {
      skipped.push({ rule: raw, reason: 'does not tokenize as shell words' })
      continue
    }
    out.push({
      decision,
      tokens,
      justification: `ClaudeUI ${tier} rule ${commentText(raw)}`
    })
  }
}

const HEADER_PREAMBLE = [
  '# Generated by ClaudeUI from ~/.claude/settings.json user-scope permissions. Do not edit; edits are overwritten.',
  '# Only `Bash` rules compile, and only user scope: this file is global to the Codex user',
  '# config layer, so a project rule compiled here would follow you into every other project.',
  '# `Bash(<prefix>:*)` becomes an argv prefix rule. An exact deny `Bash(<cmd>)` is also emitted',
  '# as a PREFIX, which over-matches — it forbids longer commands starting with those tokens too.',
  '# That only narrows, so it is accepted; an exact ALLOW is skipped instead, because widening it',
  '# would grant more than the rule says. Anything else unexpressible is skipped and listed below.'
]

/**
 * Compile a Claude permission set into execpolicy source. Pure: no I/O, no
 * clock, no environment — equal input yields byte-identical output, which is
 * what makes the hash a usable staleness check.
 *
 * Deny rules are emitted before allow rules. Ordering does not change the
 * outcome (execpolicy takes the STRICTEST decision across all matching rules,
 * per its README), but a fixed order keeps the bytes stable.
 */
export function compileClaudeRulesToExecpolicy(perms: ClaudePermissions): CompiledExecpolicy {
  const rules: CompiledPrefixRule[] = []
  const skipped: SkippedClaudeRule[] = []
  compileTier(perms.deny ?? [], 'deny', rules, skipped)
  compileTier(perms.allow ?? [], 'allow', rules, skipped)

  const body = rules.map(
    (rule) =>
      `prefix_rule(pattern=[${rule.tokens.map(starlarkString).join(', ')}], ` +
      `decision=${starlarkString(rule.decision)}, ` +
      `justification=${starlarkString(rule.justification)})`
  )
  const skippedLines =
    skipped.length === 0
      ? ['# skipped: 0']
      : [
          `# skipped: ${skipped.length} (listed below)`,
          ...skipped.map((entry) => `#   ${commentText(entry.rule)}  ${entry.reason}`)
        ]
  // The hash covers every line the file will carry EXCEPT its own hash line, so
  // "same hash" means "byte-identical file" — the skipped list included.
  const hashable = [...HEADER_PREAMBLE, ...skippedLines, ...body].join('\n')
  const hash = createHash('sha256').update(hashable).digest('hex')
  const text = `${[...HEADER_PREAMBLE, `# source-hash: ${hash}`, ...skippedLines, ...body].join('\n')}\n`
  return { text, hash, skipped }
}

/**
 * Whether the DEFAULT (user's own) Codex home may be written to yet.
 *
 * Writing `~/.codex/rules/claudeui.rules` is a change to the user's live
 * security policy, and three ordinary code paths now reach it: core boot, a
 * permission save, and a Codex spawn prep. Two of those are called directly by
 * unit tests of unrelated behaviour, which would otherwise rewrite the
 * developer's real policy file as a side effect of running the suite. So the
 * implicit-home path is armed once, by the application boot that establishes
 * there IS a user session to write for; an explicit `codexHome` (every test,
 * and any future embedder) never needs it.
 */
let defaultHomeArmed = false

/** Called once from core boot — see {@link defaultHomeArmed}. */
export function armCodexRulesSync(): void {
  defaultHomeArmed = true
}

/** `$CODEX_HOME` when set and non-empty, else `~/.codex` — Codex's own rule
 *  (`codex-rs/utils/home-dir/src/lib.rs` `find_codex_home`). */
export function resolveCodexHome(): string {
  const fromEnv = process.env.CODEX_HOME
  return fromEnv && fromEnv.length > 0 ? fromEnv : join(homedir(), '.codex')
}

/** The `# source-hash:` recorded in an existing file, or null. */
function recordedHash(path: string): string | null {
  try {
    const existing = readFileSync(path, 'utf8')
    return /^# source-hash: ([0-9a-f]{64})$/m.exec(existing)?.[1] ?? null
  } catch {
    return null // absent or unreadable — treat as stale
  }
}

/**
 * Regenerate `$CODEX_HOME/rules/claudeui.rules` when its content would change.
 *
 * Called from three places, all of which are "before the next Codex thread"
 * rather than per-turn: core boot, a rule edit made through ClaudeUI, and the
 * codex spawn prep. Codex loads rule files ONCE per thread (`thread/start` /
 * `thread/resume` in `core/src/session/mod.rs`), so nothing finer can matter.
 *
 * Never throws: a permission rule file that cannot be written must not take
 * down boot, a settings save, or a session spawn. The caller gets `wrote:
 * false` and a warn line.
 *
 * Does nothing when `$CODEX_HOME` itself does not exist (Codex is not set up —
 * creating the directory would make an un-installed Codex look installed), when
 * no Codex binary is available to read the file, or — for the implicit home
 * only — before {@link armCodexRulesSync} has run.
 */
export function syncCodexRulesFile(
  options: { codexHome?: string; perms?: ClaudePermissions } = {}
): CodexRulesSyncResult {
  const codexHome = options.codexHome ?? resolveCodexHome()
  const path = join(codexHome, RULES_DIR, RULES_FILE)
  try {
    if (options.codexHome === undefined && !defaultHomeArmed) {
      logger.debug(LOG, 'Rule sync not armed (no application boot) — skipping')
      return { wrote: false, path, skipped: [] }
    }
    if (!codexBinaryAvailable()) {
      logger.debug(LOG, 'Codex is not installed — skipping rule compilation')
      return { wrote: false, path, skipped: [] }
    }
    if (!existsSync(codexHome)) {
      logger.debug(LOG, `${codexHome} does not exist — skipping rule compilation`)
      return { wrote: false, path, skipped: [] }
    }
    const perms = options.perms ?? loadClaudePermissions('user')
    const compiled = compileClaudeRulesToExecpolicy(perms)
    if (recordedHash(path) === compiled.hash) {
      logger.debug(LOG, `${path} is up to date`)
      return { wrote: false, path, skipped: compiled.skipped }
    }
    const dir = join(codexHome, RULES_DIR)
    mkdirSync(dir, { recursive: true })
    // Atomic swap: a half-written `.rules` file is a PARSE ERROR for the whole
    // user layer, which would drop every rule in it (`load_exec_policy` falls
    // back to the requirements policy on `ParsePolicy`). The temp name stays
    // out of the `*.rules` glob so a concurrent Codex start cannot read it.
    const temp = join(dir, `.${RULES_FILE}.${process.pid}.tmp`)
    try {
      writeFileSync(temp, compiled.text, 'utf8')
      renameSync(temp, path)
    } catch (err) {
      rmSync(temp, { force: true })
      throw err
    }
    logger.info(
      LOG,
      `Wrote ${path} (${
        compiled.text
          .trimEnd()
          .split('\n')
          .filter((line) => !line.startsWith('#')).length
      } rules, ${compiled.skipped.length} skipped)`
    )
    return { wrote: true, path, skipped: compiled.skipped }
  } catch (err) {
    logger.warn(LOG, `Failed to sync ${path}`, err)
    return { wrote: false, path, skipped: [] }
  }
}
