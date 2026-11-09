/**
 * A typed `/name args` for a shared Claude skill, expanded host-side the way cli.js 2.1.317
 * expands it, for engines that do not run Claude skills themselves (opencode, pi).
 * Rules: docs/architecture/skill-catalog.md › Invocation.
 *
 * CONTRACT MODULE: the exported types and signatures are fixed by the arc spec
 * (`.work/skill-catalog/spec.md` §A).
 */

import type { ClaudeSkillCatalog, ClaudeSkillEntry } from './claude-skill-catalog'

export interface SkillInvocation {
  entry: ClaudeSkillEntry
  /** The text after the name, trimmed ('' when none). */
  args: string
}

export interface SkillExpansionContext {
  /** The session's cwd: fills `${CLAUDE_PROJECT_DIR}`. */
  cwd: string
  /** Fills `${CLAUDE_SESSION_ID}`; left as written when absent. */
  sessionId?: string
}

/**
 * `/name args` (name = an entry's `name` or alias, user-invocable only) → the invocation;
 * anything else → null. Only a leading `/name` followed by whitespace or the end matches.
 */
export function parseSkillInvocation(
  text: string,
  catalog: ClaudeSkillCatalog
): SkillInvocation | null {
  const m = /^\/(\S+)(?:\s([\s\S]*))?$/.exec(text)
  if (!m) return null
  const entry = catalog.entries.find(
    (e) => e.userInvocable && (e.name === m[1] || e.aliases?.includes(m[1]))
  )
  return entry ? { entry, args: (m[2] ?? '').trim() } : null
}

/**
 * The text the engine receives: an envelope the cold-history mappers recognise as the typed
 * command (`<command-message>`, `<command-name>`, `<command-args>`, as cli.js writes them),
 * then cli.js's expansion of the body (base-directory header, variables, arguments).
 * `!` shell commands are not run: each becomes a note naming the command.
 */
export function expandClaudeSkillInvocation(
  invocation: SkillInvocation,
  context: SkillExpansionContext
): string {
  const { entry, args } = invocation
  const header = entry.baseDir ? `Base directory for this skill: ${entry.baseDir}\n\n` : ''
  const withVars = fillVariables(header + entry.body, entry, context)
  const expanded = noteShellCommands(substituteArguments(withVars, entry.argumentNames, args))
  return (
    `<command-message>${entry.name}</command-message>\n` +
    `<command-name>/${entry.name}</command-name>\n` +
    (args ? `<command-args>${args}</command-args>\n` : '') +
    `\n${expanded}`
  )
}

/** The typed `/name args` back out of an expanded invocation; null when `text` is not one. */
export function parseSkillInvocationEnvelope(
  text: string
): { commandName: string; commandArgs?: string } | null {
  const m =
    /^<command-message>[^\n]*<\/command-message>\n<command-name>(\/[^\n<]+)<\/command-name>(?:\n<command-args>([\s\S]*?)<\/command-args>)?\n\n/.exec(
      text
    )
  if (!m) return null
  const args = m[2]?.trim()
  return { commandName: m[1], ...(args ? { commandArgs: args } : {}) }
}

export function fillVariables(
  text: string,
  entry: ClaudeSkillEntry,
  { cwd, sessionId }: SkillExpansionContext
): string {
  let out = text
  const set = (name: string, value: string | undefined): void => {
    if (value === undefined) return
    out = out.replaceAll('${' + name + '}', () => value)
  }
  set('CLAUDE_SKILL_DIR', entry.baseDir)
  set('CLAUDE_PROJECT_DIR', cwd)
  set('CLAUDE_SESSION_ID', sessionId)
  // Plugin variables are already filled into `body` at catalog time; this covers a hand-built entry.
  set('CLAUDE_PLUGIN_ROOT', entry.pluginRoot?.replace(/\\/g, '/'))
  return out
}

/** cli.js's `c0`: a substituted value must not be able to form a `!` shell marker. */
function escapeValue(v: string): string {
  const out = v.replaceAll('`!', '` !').replaceAll('!`', '! `')
  return out.startsWith('!') ? '\\' + out : out
}

/** Bash-style split (quotes, backslash escapes); whitespace split when a quote is left open. */
function splitArgs(args: string): string[] {
  const out: string[] = []
  let cur = ''
  let has = false
  let quote: '"' | "'" | null = null
  for (let i = 0; i < args.length; i++) {
    const ch = args[i]
    if (quote === "'") {
      if (ch === "'") quote = null
      else cur += ch
    } else if (quote === '"') {
      if (ch === '"') quote = null
      else if (ch === '\\' && i + 1 < args.length && '"\\$`'.includes(args[i + 1])) cur += args[++i]
      else cur += ch
    } else if (ch === '"' || ch === "'") {
      quote = ch
      has = true
    } else if (ch === '\\' && i + 1 < args.length) {
      cur += args[++i]
      has = true
    } else if (/\s/.test(ch)) {
      if (has || cur) out.push(cur)
      cur = ''
      has = false
    } else {
      cur += ch
      has = true
    }
  }
  if (quote) return args.split(/\s+/).filter(Boolean)
  if (has || cur) out.push(cur)
  return out
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * `\$` makes a placeholder literal; `$name`, `$ARGUMENTS[n]`, `$n` (zero-based) and `$ARGUMENTS`
 * take the arguments; with no placeholder matched, a non-empty `args` is appended. One pass, so a
 * substituted value is never rescanned.
 */
function substituteArguments(text: string, names: string[], args: string): string {
  const parsed = splitArgs(args)
  const named = names
    .map((name, i) => ({ name, i }))
    .filter((n) => n.name !== '')
    .sort((a, b) => b.name.length - a.name.length)
  const alt = [
    ...named.map((n) => `(?<n${n.i}>${escapeRe(n.name)})(?![\\[\\w])`),
    'ARGUMENTS\\[(?<idx>\\d+)\\]',
    '(?<all>ARGUMENTS)',
    '(?<num>\\d+)(?!\\w)'
  ].join('|')
  const re = new RegExp(`(?<esc>\\\\)?\\$(?:${alt})`, 'g')
  let matched = false
  const out = text.replace(re, (...a: unknown[]) => {
    const groups = a[a.length - 1] as Record<string, string | undefined>
    const m = a[0] as string
    const offset = a[a.length - 3] as number
    const whole = a[a.length - 2] as string
    const escaped = groups.esc !== undefined
    // `\$`: literal unless that backslash is itself escaped.
    if (escaped && whole[offset - 1] !== '\\') return m.slice(1)
    const prefix = escaped ? '\\' : ''
    const take = (v: string | undefined, keep: string): string => {
      if (v === undefined) return keep
      matched = true
      return prefix + escapeValue(v)
    }
    const nameKey = Object.keys(groups).find((k) => /^n\d+$/.test(k) && groups[k] !== undefined)
    if (nameKey) return take(parsed[Number(nameKey.slice(1))] ?? '', m)
    if (groups.idx !== undefined) return take(parsed[Number(groups.idx)], m)
    if (groups.num !== undefined) return take(parsed[Number(groups.num)], m)
    if (groups.all !== undefined) return take(args, m)
    return m
  })
  return !matched && args ? `${out}\n\nARGUMENTS: ${escapeValue(args)}` : out
}

/** R4: shell commands are not run; each becomes a note naming the command. */
function noteShellCommands(text: string): string {
  const note = (cmd: string): string =>
    `[ClaudeUI did not run this skill command; run it yourself if you need its output: \`${cmd}\`]`
  return text
    .replace(/```!\s*\n?([\s\S]*?)\n?```/g, (_m, cmd: string) => note(cmd.trim()))
    .replace(/(?<=^|\s)!`([^`]+)`/gm, (_m, cmd: string) => note(cmd))
}
