/**
 * ADR-084 §1 sections 1–2, on their own: the read-only checker's text hygiene
 * and its two-dialect strict lexer, plus the Claude rule-text parser.
 *
 * A LEAF module — it imports nothing — shared by `read-only.ts` (the static
 * read-only bypass) and `../permissions/shell-rules.ts` (ADR-085's rule
 * matcher, whose strict allow coverage uses this lexer), so neither imports
 * the other. Pure: no `node:fs`, no child processes, no environment.
 *
 * Every rule here fails closed by throwing a {@link Refusal}; callers catch it
 * once (`readOnlyVerdict`, {@link lexShellStrict}).
 */

// ── Plumbing ──────────────────────────────────────────────────────────────────

/** Thrown by any rule; caught once at the top so every rule can fail closed in one line. */
export class Refusal {
  constructor(readonly reason: string) {}
}

export function refuse(reason: string): never {
  throw new Refusal(reason)
}

/** One shell word, in both readings. */
export interface Tok {
  /** As written, quotes included. */
  raw: string
  /** Bash reading: quotes removed, backslash escapes applied. */
  posix: string
  /** PowerShell reading: quotes removed (`''`/`""` escapes), backslashes literal. */
  win: string
  /** Any quote character in the raw token. */
  quoted: boolean
  /** An unquoted, unescaped `*` or `?` — bash would glob-expand it. */
  uglob: boolean
  /** An unquoted `,` — PowerShell would make an array (separate native args). */
  ucomma: boolean
}

export type Op = '|' | '||' | '&&' | ';'

export interface Segment {
  /** The operator BEFORE this segment (`null` for the first). */
  op: Op | null
  tokens: Tok[]
}

// ── 1. Text hygiene ───────────────────────────────────────────────────────────

/**
 * Code points refused anywhere. Beyond the ADR's list (C0 except TAB, DEL,
 * NEL, NBSP, U+2000–U+206F, U+3000, BOM, the fullwidth block) this also
 * refuses every other Unicode control, format, separator and lone-surrogate
 * character: PowerShell treats several of them as live syntax (smart quotes,
 * en-dash parameters, a lone CR as a statement separator) and none has a place
 * in a plain read.
 */
export function badCodePoint(command: string): number | undefined {
  for (const ch of command) {
    if (ch === ' ' || ch === '\t') continue
    const cp = ch.codePointAt(0) ?? 0
    if (
      cp < 0x20 ||
      cp === 0x7f ||
      cp === 0x85 ||
      cp === 0xa0 ||
      (cp >= 0x2000 && cp <= 0x206f) ||
      cp === 0x3000 ||
      cp === 0xfeff ||
      (cp >= 0xff00 && cp <= 0xffef) ||
      /[\p{Cc}\p{Cf}\p{Cs}\p{Z}]/u.test(ch)
    ) {
      return cp
    }
  }
  return undefined
}

/**
 * Forbidden anywhere, quoted or not: expansion (`$`, backtick), grouping and
 * substitution (`( ) { }`), PowerShell static-member syntax (`::`) and the
 * stop-parsing token (`--%`). `<`, `>`, `&`, `@`, `[`, `#` and `~` are
 * position-dependent and handled by the lexer / token checks.
 */
const FORBIDDEN_ANYWHERE = ['$', '`', '(', ')', '{', '}', '::', '--%'] as const

/** Section 1 in one call: refuse a bad code point or a forbidden construct anywhere in the text. */
export function textHygiene(command: string): void {
  const bad = badCodePoint(command)
  if (bad !== undefined) refuse(`text:char U+${bad.toString(16).toUpperCase().padStart(4, '0')}`)
  for (const f of FORBIDDEN_ANYWHERE) if (command.includes(f)) refuse(`token:${f}`)
}

// ── 2. Lexer ──────────────────────────────────────────────────────────────────

/**
 * Split into segments and tokens with bash's boundaries, computing both views
 * per token. Every construct where PowerShell would split differently from
 * bash is refused here, which is what makes one boundary set valid for both.
 */
export function lex(command: string): Segment[] {
  const segments: Segment[] = []
  let seg: Segment = { op: null, tokens: [] }
  let tok: Tok | null = null
  let state: 'out' | 'sq' | 'dq' = 'out'
  const s = command
  const n = s.length

  const cur = (): Tok => {
    if (!tok) tok = { raw: '', posix: '', win: '', quoted: false, uglob: false, ucomma: false }
    return tok
  }
  const endToken = (): void => {
    if (tok) seg.tokens.push(tok)
    tok = null
  }
  const endSegment = (op: Op): void => {
    endToken()
    segments.push(seg)
    seg = { op, tokens: [] }
  }

  let i = 0
  while (i < n) {
    const ch = s[i]
    if (state === 'out') {
      if (ch === ' ' || ch === '\t') {
        endToken()
        i++
        continue
      }
      // The one tolerated redirection: a standalone `2>&1` after the command word.
      if (!tok && s.startsWith('2>&1', i) && /^(?:$|[ \t|;&])/.test(s.slice(i + 4, i + 5))) {
        if (seg.tokens.length === 0) refuse('token:2>&1 position')
        i += 4
        continue
      }
      if (ch === '|') {
        const two = s[i + 1] === '|'
        endSegment(two ? '||' : '|')
        i += two ? 2 : 1
        continue
      }
      if (ch === ';') {
        endSegment(';')
        i++
        continue
      }
      if (ch === '&') {
        if (s[i + 1] !== '&') refuse('token:&')
        endSegment('&&')
        i += 2
        continue
      }
      if (ch === '>' || ch === '<') refuse(`token:${ch}`)
      // `@` splat / hashtable, `[` bash glob + PS type literal, `#` comment in both shells.
      if (ch === '@' || ch === '[' || ch === '#') refuse(`token:${ch}`)
      if (ch === "'") {
        const t = cur()
        t.raw += ch
        t.quoted = true
        state = 'sq'
        i++
        continue
      }
      if (ch === '"') {
        const t = cur()
        t.raw += ch
        t.quoted = true
        state = 'dq'
        i++
        continue
      }
      if (ch === '\\') {
        const next = s[i + 1]
        // bash escapes whatever follows; PowerShell keeps the backslash and reads
        // the next character LIVE (`a\>b` redirects, `a\,b` splits, `a\;b`
        // separates). So only a plain path/word character may follow.
        if (next === undefined || !/[A-Za-z0-9._\-\\/*?+=%^:]/.test(next)) {
          refuse('token:backslash')
        }
        const t = cur()
        t.raw += ch + next
        t.posix += next
        t.win += ch + next
        i += 2
        continue
      }
      const t = cur()
      if (ch === '*' || ch === '?') t.uglob = true
      if (ch === ',') t.ucomma = true
      t.raw += ch
      t.posix += ch
      t.win += ch
      i++
      continue
    }

    // Inside quotes a lone `&` is refused even here (the ADR's "anywhere"
    // rule). `<`/`>` are literal inside SINGLE quotes in both shells
    // (`'->'`, `--format='<%h>'`) but stay refused inside double quotes.
    if (state === 'dq' && (ch === '>' || ch === '<')) refuse(`token:${ch}`)
    if (ch === '&') {
      if (s[i + 1] !== '&') refuse('token:&')
      const t = cur()
      t.raw += '&&'
      t.posix += '&&'
      t.win += '&&'
      i += 2
      continue
    }
    const t = cur()
    const quote = state === 'sq' ? "'" : '"'
    if (ch === quote) {
      if (s[i + 1] === quote) {
        // PowerShell: an escaped quote, still inside. bash: close + reopen —
        // still inside, adds nothing. Same boundary either way.
        t.raw += quote + quote
        t.win += quote
        i += 2
        continue
      }
      t.raw += ch
      state = 'out'
      i++
      // PowerShell ends an argument at the closing quote when more text follows
      // it (`"src/a.ts"..\x` is TWO arguments there, one to bash). Only a
      // boundary, or the comma of a PowerShell array, may follow.
      if (i < n && !/[ \t|;&,]/.test(s[i])) refuse('token:text-after-quote')
      continue
    }
    if (state === 'dq' && ch === '\\') {
      const next = s[i + 1]
      if (next === '"' || next === "'") refuse('token:backslash')
      if (next === '\\') {
        t.raw += '\\\\'
        t.posix += '\\'
        t.win += '\\\\'
        i += 2
        continue
      }
    }
    t.raw += ch
    t.posix += ch
    t.win += ch
    i++
  }
  if (state !== 'out') refuse('token:unbalanced-quote')
  endToken()
  segments.push(seg)
  return segments
}

/** One token of {@link lexShellStrict}: as written, and in the bash and PowerShell readings. */
export type StrictToken = Readonly<Tok>

export interface StrictSegment {
  /** The operator before this segment (`null` for the first). */
  readonly op: Op | null
  readonly tokens: readonly StrictToken[]
}

/**
 * ADR-085 §4: sections 1 and 2 on their own — the text hygiene and this
 * two-dialect lexer, with no command tables and no path rules — for the
 * auto-mode allow-rule coverage check (`../permissions/shell-rules.ts`
 * `allowCovers(…, 'strict')`). Same refusals, same boundaries: a command this
 * refuses is never "covered". Never throws.
 */
export function lexShellStrict(
  command: string
): { ok: true; segments: StrictSegment[] } | { ok: false; reason: string } {
  try {
    textHygiene(command)
    return { ok: true, segments: lex(command) }
  } catch (err) {
    if (err instanceof Refusal) return { ok: false, reason: err.reason }
    return { ok: false, reason: 'internal' }
  }
}

/**
 * Claude-syntax `Tool(specifier)` parser — same semantics as
 * `permission-compiler.ts` `parseClaudeRule` (an empty or `*` specifier means
 * the whole tool). Re-implemented because that module is not pure (it imports
 * the settings loader and the Codex rules sync, i.e. `node:fs`). Shared by
 * `read-only.ts` (which re-exports it) and `../permissions/shell-rules.ts`.
 */
export function parseRuleText(rule: string): { tool: string; specifier?: string } | null {
  const trimmed = rule.trim()
  const open = trimmed.indexOf('(')
  if (open < 0) return trimmed ? { tool: trimmed } : null
  if (!trimmed.endsWith(')')) return { tool: trimmed }
  const tool = trimmed.slice(0, open).trim()
  if (!tool) return null
  const specifier = trimmed.slice(open + 1, -1).trim()
  return specifier === '' || specifier === '*' ? { tool } : { tool, specifier }
}
