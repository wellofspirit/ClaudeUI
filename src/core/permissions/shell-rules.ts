/**
 * ADR-085 §1 — the user's `Bash(...)` rules, matched against a shell command.
 *
 * Three questions, three stances:
 *
 * - **Does a deny/ask rule hit?** ({@link denyAskHit}) Over-approximate. A
 *   false hit costs one prompt or one clear refusal; a miss lets a command the
 *   user said "never" (or "always ask me") run unasked. So the matcher looks
 *   everywhere a program can hide — every segment, every substitution body,
 *   behind wrappers and shell keywords, inside quoted text, inside encoded
 *   PowerShell — and lets rule words match in any order, spelled any common way.
 * - **Does an allow rule cover the command?** ({@link allowCovers})
 *   Under-approximate. Every segment must be covered, word-boundary prefix or
 *   exact, and every substitution body must be covered too (the command then
 *   asks, or goes to the judge, when it is not).
 * - **Is an allow rule usable at all?** ({@link isClassifierBypassingRule},
 *   {@link isCarvedOut}, {@link canLaunchOtherPrograms},
 *   {@link isLauncherShapedSegment}) — the predicates the auto-mode allow-skip
 *   (S5) and the Codex rule compiler use to refuse a rule that is broader than
 *   it looks.
 *
 * **This module is pure** and **never throws**: the command text and the rule
 * strings are the whole input, and an internal failure is answered with the
 * conservative result (a deny/ask check asks, coverage is refused, a predicate
 * says "unsafe").
 *
 * ## Two dialects, one answer
 *
 * The shell that runs a command is not always knowable from here (opencode on
 * Windows defaults to pwsh, pi always runs Git Bash, Codex wraps with the user's
 * shell). The deny/ask matcher therefore tokenizes every command TWICE — bash
 * quoting and PowerShell quoting — and a hit in either reading counts. The
 * lenient allow coverage requires BOTH readings to be covered (a reading
 * PowerShell cannot even parse runs nothing); the strict one uses ADR-084's
 * lexer, which refuses every construct the two dialects split differently.
 *
 * ## Cost
 *
 * Linear in the command: one pass per token list per rule word (see
 * {@link compiledRuleHits}), a bounded nesting depth, a token budget and a
 * length cap past which the command is scanned flat — still over-approximate,
 * never skipped. `denyAskHit` runs synchronously on the main process.
 *
 * ## Known residuals (ADR-085 §5)
 *
 * Found, named, not worth code — each is a deny/ask MISS unless noted:
 *
 * - text that becomes a command only at run time: `while read l; do $l;
 *   done <<EOF` and `… | while read l; do $l; done` (no executor reads the
 *   pipe: the loop body runs the text), `echo <b64> | base64 -d | sh`, `rg --pre <prog>` (runs
 *   `<prog> <file>`, no shell string to read), `make -f - <<EOF` (a makefile's
 *   recipes are code the matcher does not parse);
 * - cmd.exe's `^` escapes (`g^it push`);
 * - past the length cap or the token budget the flat scan reads every piece as
 *   a program, raw and PowerShell-folded, and decodes `-EncodedCommand`, but it
 *   does not decode `$'…'`, split `git-push`, join `("gi" + "t …")`, remove a
 *   `\` escape (`pu\sh`), honour `--%`, or expand a git alias value — and past
 *   64 KB nothing else is analysed;
 * - the SCRIPT RUNNERS, by cli.js parity (see {@link isLauncherShapedSegment}):
 *   `make`, `npm test`, `bun file.ts`, `bash x.sh`, `tar --to-command`,
 *   `rsync -e`, `tmux`, `go run`, `gh alias set --shell` are not
 *   launcher-shaped, although each runs code its words do not show. (Adding
 *   `tar` / `rsync` / `tmux` / `go` / `gh` would make the Codex compiler
 *   withhold every allow for them whenever a Bash deny/ask exists.)
 *
 * ## Layout
 *
 * 1. the permissive tokenizer (never refuses; both dialects; heredocs);
 * 2. analysis — program positions, substitution bodies, the quoted-content
 *    rescan and its data exemptions;
 * 3. rule parsing and word matching (synonyms, clusters, abbreviations, globs);
 * 4. the public questions.
 */

import { lexShellStrict, parseRuleText } from '../automode/shell-strict-lexer'

type Dialect = 'posix' | 'pwsh'

const DIALECTS: readonly Dialect[] = ['posix', 'pwsh']

/** The rule a {@link denyAskHit} reports when the command could not be analysed: it asks. */
export const UNANALYSABLE_COMMAND = '(unanalysable command)'

// ── 1. Permissive tokenizer ───────────────────────────────────────────────────

/** One shell word: quotes and escapes removed. */
interface PWord {
  value: string
  /** Any quoting, escaping or substitution contributed to it — a candidate for the rescan. */
  quoted: boolean
  /** The file operand of a redirection (`> out`, `<<EOF`): never a program or an argument. */
  target: boolean
  /** A target an OUTPUT redirection writes (`>`, `>>`, `&>`, `>|`), not `<` / `<<`. */
  sink?: boolean
}

/** A bash heredoc attached to the segment whose `<<` introduced it. */
interface Heredoc {
  body: string
  /** The delimiter was quoted (`<<'EOF'`): bash expands nothing inside the body. */
  quoted: boolean
}

/** One simple command, split at every operator either dialect treats as a boundary. */
interface PSegment {
  /** The operator BEFORE this segment (`null` for the first). */
  op: string | null
  words: PWord[]
  heredocs: Heredoc[]
  /** A `>( … )` body appears in this segment: what the segment writes there runs. */
  procOut?: boolean
}

interface PLex {
  segments: PSegment[]
  /** `$( … )`, backtick, `<( … )`, `>( … )`, `@( … )` bodies — each is a command of its own. */
  bodies: string[]
  /**
   * PowerShell reading only: an unquoted `<` at the start of a token (`< f`,
   * `<<EOF`, `<<<`, `<(`), which PowerShell's parser rejects ("reserved for
   * future use") — the whole script fails to parse, so nothing in this reading
   * runs. A `<` inside a token (`a<b`) is literal to PowerShell, and one inside
   * a comment (`# <`, `<# … #>`) is no token at all: neither is a parse error.
   */
  parseError: boolean
}

/** Horizontal whitespace, including the Unicode spaces PowerShell also splits on. */
const SPACE_RE = /[ \t\f\v\u00a0\u1680\u2000-\u200a\u202f\u205f\u3000\ufeff]/

/** Line terminators: a new command in both dialects (a lone CR is one in PowerShell). */
const NEWLINE_RE = /[\n\r\u0085\u2028\u2029]/

/**
 * PowerShell reads curly quotes as quotes, so they are folded to ASCII before
 * that dialect is tokenized. En/em dashes are folded too, but that is an
 * over-approximation, not PowerShell's reading of every token: PowerShell
 * folds a dash only in a PARAMETER token of a cmdlet (`Remove-Item –Recurse`);
 * a native command receives it unfolded (`git push –-force` passes
 * `["push","–-force"]` in pwsh 7 and Windows PowerShell 5.1). Folding lets one
 * tokenizer serve the cmdlet case, and on the deny side a false hit on the
 * native spelling only asks.
 */
function foldPwshTypography(s: string): string {
  return s
    .replace(/[\u2018\u2019\u201a\u201b]/g, "'")
    .replace(/[\u201c\u201d\u201e]/g, '"')
    .replace(/[\u2013\u2014\u2015]/g, '-')
}

/**
 * A heredoc operator starting at `i` (`<<`, `<<-`, not `<<<`): its delimiter
 * word (quotes removed), whether it was quoted, whether tabs are stripped, and
 * the index after it. `undefined` when `i` is not one.
 */
function readHeredocOperator(
  s: string,
  i: number
): { delim: string; quoted: boolean; strip: boolean; end: number } | undefined {
  if (!s.startsWith('<<', i) || s[i + 2] === '<') return undefined
  let k = i + 2
  const strip = s[k] === '-'
  if (strip) k++
  while (s[k] === ' ' || s[k] === '\t') k++
  let delim = ''
  let quoted = false
  while (k < s.length && !/[\s;|&<>()]/.test(s[k])) {
    const c = s[k]
    if (c === "'" || c === '"') {
      quoted = true
      const close = s.indexOf(c, k + 1)
      const stop = close < 0 ? s.length : close
      delim += s.slice(k + 1, stop)
      k = stop + 1
      continue
    }
    if (c === '\\' && k + 1 < s.length) {
      quoted = true
      delim += s[k + 1]
      k += 2
      continue
    }
    delim += c
    k++
  }
  return delim === '' ? undefined : { delim, quoted, strip, end: k }
}

/**
 * Consume heredoc bodies starting at the line after a newline (`i` is the
 * first character of that line), one per queued delimiter, in order. Returns
 * the bodies and the index after the last delimiter line.
 */
function readHeredocBodies(
  s: string,
  i: number,
  queue: ReadonlyArray<{ delim: string; strip: boolean }>
): { bodies: string[]; end: number } {
  const bodies: string[] = []
  for (const { delim, strip } of queue) {
    const lines: string[] = []
    while (i < s.length) {
      const nl = s.indexOf('\n', i)
      const stop = nl < 0 ? s.length : nl
      const line = s.slice(i, stop).replace(/\r$/, '')
      i = nl < 0 ? s.length : nl + 1
      if ((strip ? line.replace(/^\t+/, '') : line) === delim) break
      lines.push(line)
    }
    bodies.push(lines.join('\n'))
  }
  return { bodies, end: i }
}

/**
 * The body of a `(`-opened construct starting at `open`, balanced, quote- and
 * heredoc-aware (a heredoc inside `$( … )` may hold an unbalanced `)` or a
 * lone apostrophe: `$(cat <<'EOF'` … `don't` … `EOF` `)`). Unterminated → the rest.
 */
function readParenBody(s: string, open: number): { text: string; end: number } {
  let depth = 1
  let j = open + 1
  const pending: Array<{ delim: string; strip: boolean }> = []
  while (j < s.length) {
    const c = s[j]
    if (c === '\\') {
      j += 2
      continue
    }
    if (c === '\n' && pending.length > 0) {
      j = readHeredocBodies(s, j + 1, pending).end
      pending.length = 0
      continue
    }
    if (c === '<') {
      const h = readHeredocOperator(s, j)
      if (h) {
        pending.push(h)
        j = h.end
        continue
      }
    }
    if (c === "'") {
      const close = s.indexOf("'", j + 1)
      j = close < 0 ? s.length : close + 1
      continue
    }
    if (c === '"') {
      j++
      while (j < s.length && s[j] !== '"') j += s[j] === '\\' ? 2 : 1
      j++
      continue
    }
    if (c === '(') depth++
    else if (c === ')') {
      depth--
      if (depth === 0) return { text: s.slice(open + 1, j), end: j + 1 }
    }
    j++
  }
  return { text: s.slice(open + 1), end: s.length }
}

/** A bash backtick substitution starting at `open`; `` \` `` inside is a literal backtick. */
function readBacktickBody(s: string, open: number): { text: string; end: number } {
  let text = ''
  let j = open + 1
  while (j < s.length && s[j] !== '`') {
    if (s[j] === '\\' && j + 1 < s.length && '`\\$'.includes(s[j + 1])) {
      text += s[j + 1]
      j += 2
      continue
    }
    text += s[j]
    j++
  }
  return { text, end: j + 1 }
}

/**
 * `${…}` starting at `i` (`s[i] === '$'`): the literal text, and any `$( … )` /
 * backtick bodies inside it (`${x:-$(cmd)}` runs `cmd`).
 */
function readBraceParam(
  s: string,
  i: number,
  dialect: Dialect
): { text: string; end: number; bodies: string[] } {
  const bodies: string[] = []
  let depth = 1
  let j = i + 2
  while (j < s.length) {
    const c = s[j]
    if (c === '$' && s[j + 1] === '(') {
      const body = readParenBody(s, j + 1)
      bodies.push(body.text)
      j = body.end
      continue
    }
    if (dialect === 'posix' && c === '`') {
      const body = readBacktickBody(s, j)
      bodies.push(body.text)
      j = body.end
      continue
    }
    if (c === '\\') {
      j += 2
      continue
    }
    if (c === '{') depth++
    else if (c === '}') {
      depth--
      if (depth === 0) return { text: s.slice(i, j + 1), end: j + 1, bodies }
    }
    j++
  }
  return { text: s.slice(i), end: s.length, bodies }
}

const ANSI_C_SIMPLE: Record<string, string> = {
  n: '\n',
  t: '\t',
  r: '\r',
  a: '\x07',
  b: '\b',
  e: '\x1b',
  E: '\x1b',
  f: '\f',
  v: '\v',
  '\\': '\\',
  "'": "'",
  '"': '"',
  '?': '?'
}

/** bash `$'…'` — decode the escapes so `$'\x67it'` reads as `git`. Returns the value and the index after the closing quote. */
function readAnsiC(s: string, start: number): { value: string; end: number } {
  let value = ''
  let j = start
  while (j < s.length && s[j] !== "'") {
    if (s[j] !== '\\' || j + 1 >= s.length) {
      value += s[j]
      j++
      continue
    }
    const e = s[j + 1]
    if (ANSI_C_SIMPLE[e] !== undefined) {
      value += ANSI_C_SIMPLE[e]
      j += 2
      continue
    }
    const hex =
      /^(?:x([0-9a-fA-F]{1,2})|u([0-9a-fA-F]{1,4})|U([0-9a-fA-F]{1,8})|([0-7]{1,3}))/.exec(
        s.slice(j + 1, j + 10)
      )
    if (hex) {
      const code = parseInt(hex[1] ?? hex[2] ?? hex[3] ?? hex[4], hex[4] !== undefined ? 8 : 16)
      value += code <= 0x10ffff ? String.fromCodePoint(code) : ''
      j += 1 + hex[0].length
      continue
    }
    if (e === 'c' && j + 2 < s.length) {
      value += String.fromCharCode(s.charCodeAt(j + 2) & 0x1f)
      j += 3
      continue
    }
    value += e
    j += 2
  }
  return { value, end: j + 1 }
}

/**
 * Split a command the way `dialect` would, never refusing: an unterminated
 * quote runs to the end, an unknown construct is a literal. Boundaries are the
 * UNION of what either shell splits on — `&& || ; | & |&`, line terminators,
 * `( )`, a standalone `{`/`}` (bash's group; any `{`/`}` in PowerShell, whose
 * script blocks are code — but `{}` is an empty one), `<<<` — because
 * over-splitting only creates more places a deny rule is looked for. A glued
 * `{}` (`xargs -I{}`, `find -exec … {}`) stays in its word. The bash reading
 * does NOT strip comments: cmd.exe has none, and a `#` that one reader skips is
 * a command another runs. The PowerShell reading does skip PowerShell's own
 * comments — a token-initial `#` to the end of the line and a token-initial
 * `<#` … `#>` — because a `<` inside one would otherwise read as the parse
 * error that drops the reading (review r2 B5; verified in pwsh 7 and Windows
 * PowerShell 5.1: `a <#c#> b` → `a b`, `a#b` and `a<#c#>b` are one word,
 * `"q"#r` → `q`). Also PowerShell's: a `<` inside a token is literal (`a<b`),
 * and a token that STARTS with a quote ends at its closing quote (`"push"x` is
 * two arguments). A substitution body is kept as a body AND its text stays in
 * the word, so the word's rescan sees it too.
 */
function lexPermissive(input: string, dialect: Dialect): PLex {
  const s = dialect === 'pwsh' ? foldPwshTypography(input) : input
  const n = s.length
  const segments: PSegment[] = []
  const bodies: string[] = []
  let parseError = false
  let seg: PSegment = { op: null, words: [], heredocs: [] }
  let word: PWord | null = null
  let nextIsTarget = false
  let nextIsSink = false
  let verbatim = false
  let i = 0
  /** A `<<` whose delimiter word is being read, and heredocs waiting for the next newline. */
  let heredocOp: { strip: boolean } | null = null
  const heredocQueue: Array<{ delim: string; strip: boolean; quoted: boolean; seg: PSegment }> = []

  const cur = (): PWord => {
    if (!word) word = { value: '', quoted: false, target: nextIsTarget, sink: nextIsSink }
    return word
  }
  const endWord = (): void => {
    if (!word) return
    const w = word
    seg.words.push(w)
    if (w.target) {
      nextIsTarget = false
      nextIsSink = false
      if (heredocOp) {
        heredocQueue.push({ delim: w.value, strip: heredocOp.strip, quoted: w.quoted, seg })
        heredocOp = null
      }
    }
    // PowerShell's stop-parsing token: the rest of the line is verbatim argv.
    if (dialect === 'pwsh' && !w.quoted && w.value === '--%') verbatim = true
    word = null
  }
  const endSegment = (op: string): void => {
    endWord()
    nextIsTarget = false
    nextIsSink = false
    heredocOp = null
    verbatim = false
    segments.push(seg)
    seg = { op, words: [], heredocs: [] }
  }
  const addBody = (text: string): void => {
    bodies.push(text)
    const t = cur()
    t.value += text
    t.quoted = true
  }

  /** `>`, `>>`, `<`, `2>&1`, `&>`, `<<EOF` …: the operand is a file (or a descriptor), not a word. */
  const redirect = (): void => {
    if (dialect === 'pwsh' && s[i] === '<') parseError = true
    // A bare descriptor glued to the operator (`2>`, PowerShell `*>`) is not an argument.
    const w = word as PWord | null
    if (w && !w.quoted && /^(?:\d+|\*)$/.test(w.value)) word = null
    else endWord()
    if (dialect === 'posix' && s.startsWith('<<', i)) heredocOp = { strip: s[i + 2] === '-' }
    let j = i
    if (s[j] === '&') j++ // `&>`
    while (j < n && (s[j] === '<' || s[j] === '>')) j++
    const writes = s.slice(i, j).includes('>')
    if (heredocOp?.strip && s[j] === '-') j++
    if (s[j] === '&' || s[j] === '|') {
      j++
      // `>&2`, `2>&1`, `>&-`: duplicating a descriptor names no file.
      if (/[\d-]/.test(s[j] ?? '')) {
        while (j < n && /[\d-]/.test(s[j])) j++
        i = j
        return
      }
    }
    i = j
    nextIsTarget = true
    nextIsSink = writes
  }

  while (i < n) {
    if (verbatim) {
      // `--%`: everything up to the end of the line (or a pipe) is split on blanks only.
      verbatim = false
      let j = i
      while (j < n && !NEWLINE_RE.test(s[j]) && s[j] !== '|') j++
      for (const piece of s.slice(i, j).split(/[ \t]+/)) {
        if (piece) seg.words.push({ value: piece, quoted: true, target: false })
      }
      i = j
      continue
    }
    const ch = s[i]

    // Escapes and line continuations: `\` in bash, the backtick in PowerShell.
    if ((dialect === 'posix' && ch === '\\') || (dialect === 'pwsh' && ch === '`')) {
      const nx = s[i + 1]
      if (nx === undefined) {
        i++
        continue
      }
      if (nx === '\n' || (nx === '\r' && s[i + 2] === '\n')) {
        // bash deletes `\`-newline outright; PowerShell's backtick-newline is a blank.
        if (dialect === 'pwsh') endWord()
        i += nx === '\r' ? 3 : 2
        continue
      }
      const t = cur()
      t.value += nx
      t.quoted = true
      i += 2
      continue
    }

    // PowerShell: a token that starts with a quote ends at the closing one (`'push'x` → `push`, `x`).
    const quoteStartsToken = dialect === 'pwsh' && !word
    if (ch === "'") {
      const t = cur()
      t.quoted = true
      let j = i + 1
      if (dialect === 'posix') {
        const close = s.indexOf("'", j)
        const end = close < 0 ? n : close
        t.value += s.slice(j, end)
        i = end + 1
        continue
      }
      while (j < n) {
        if (s[j] === "'") {
          if (s[j + 1] === "'") {
            t.value += "'"
            j += 2
            continue
          }
          break
        }
        t.value += s[j]
        j++
      }
      i = j + 1
      if (quoteStartsToken) endWord()
      continue
    }

    if (dialect === 'posix' && ch === '$' && s[i + 1] === "'") {
      const t = cur()
      t.quoted = true
      const { value, end } = readAnsiC(s, i + 2)
      t.value += value
      i = end
      continue
    }
    // bash `$"…"` (locale translation) is a double-quoted string.
    if (dialect === 'posix' && ch === '$' && s[i + 1] === '"') {
      i++
      continue
    }

    if (ch === '"') {
      cur().quoted = true
      let j = i + 1
      while (j < n) {
        const c = s[j]
        if (c === '"') {
          if (dialect === 'pwsh' && s[j + 1] === '"') {
            cur().value += '"'
            j += 2
            continue
          }
          break
        }
        if (dialect === 'posix' && c === '\\' && j + 1 < n) {
          const nx = s[j + 1]
          if (nx === '\n') {
            j += 2
            continue
          }
          if ('$`"\\'.includes(nx)) {
            cur().value += nx
            j += 2
            continue
          }
        }
        if (dialect === 'pwsh' && c === '`' && j + 1 < n) {
          cur().value += s[j + 1]
          j += 2
          continue
        }
        if (c === '$' && s[j + 1] === '(') {
          const body = readParenBody(s, j + 1)
          addBody(body.text)
          j = body.end
          continue
        }
        if (dialect === 'posix' && c === '`') {
          const body = readBacktickBody(s, j)
          addBody(body.text)
          j = body.end
          continue
        }
        cur().value += c
        j++
      }
      i = j + 1
      if (quoteStartsToken) endWord()
      continue
    }

    if (dialect === 'pwsh') {
      if (!word && ch === '#') {
        // A line comment: nothing in it is a token.
        while (i < n && !NEWLINE_RE.test(s[i])) i++
        continue
      }
      if (!word && ch === '<' && s[i + 1] === '#') {
        // A block comment, up to `#>` (unterminated: the rest).
        const close = s.indexOf('#>', i + 2)
        i = close < 0 ? n : close + 2
        continue
      }
      if (word && ch === '<') {
        // Inside a token PowerShell reads `<` as a literal character.
        cur().value += ch
        i++
        continue
      }
    }

    // Substitutions, anywhere outside single quotes: bodies are commands of their own.
    if (
      (ch === '$' && s[i + 1] === '(') ||
      (dialect === 'pwsh' && ch === '@' && s[i + 1] === '(') ||
      ((ch === '<' || ch === '>') && s[i + 1] === '(')
    ) {
      if (dialect === 'pwsh' && ch === '<') parseError = true
      // `>( … )` receives what the segment writes: that output runs.
      if (ch === '>') seg.procOut = true
      const body = readParenBody(s, i + 1)
      addBody(body.text)
      i = body.end
      continue
    }
    if (dialect === 'posix' && ch === '`') {
      const body = readBacktickBody(s, i)
      addBody(body.text)
      i = body.end
      continue
    }
    // `${VAR}` / `${env:X}` is part of the word, not a brace group — but a
    // substitution inside it (`${x:-$(cmd)}`) still runs.
    if (ch === '$' && s[i + 1] === '{') {
      const param = readBraceParam(s, i, dialect)
      cur().value += param.text
      for (const body of param.bodies) addBody(body)
      i = param.end
      continue
    }

    if (SPACE_RE.test(ch)) {
      endWord()
      i++
      continue
    }
    if (NEWLINE_RE.test(ch)) {
      endSegment('nl')
      i += ch === '\r' && s[i + 1] === '\n' ? 2 : 1
      if (heredocQueue.length > 0) {
        const read = readHeredocBodies(s, i, heredocQueue)
        heredocQueue.forEach((h, k) =>
          h.seg.heredocs.push({ body: read.bodies[k], quoted: h.quoted })
        )
        heredocQueue.length = 0
        i = read.end
      }
      continue
    }
    if (ch === ';') {
      endSegment(';')
      i++
      continue
    }
    if (ch === '(' || ch === ')') {
      endSegment(ch)
      i++
      continue
    }
    if (ch === '{' || ch === '}') {
      const next = s[i + 1]
      const standalone =
        !word &&
        (next === undefined || SPACE_RE.test(next) || NEWLINE_RE.test(next) || /[;|&)]/.test(next))
      if (dialect === 'pwsh' && ch === '{' && next === '}') {
        // An empty script block runs nothing: `find -exec … {} \;`, `xargs -I {}`.
        cur().value += '{}'
        i += 2
        continue
      }
      if (dialect === 'pwsh' || standalone) {
        endSegment(ch)
        i++
        continue
      }
      cur().value += ch
      i++
      continue
    }
    if (ch === '|') {
      const op = s[i + 1] === '|' ? '||' : s[i + 1] === '&' ? '|&' : '|'
      endSegment(op)
      i += op.length
      continue
    }
    if (ch === '&') {
      if (s[i + 1] === '&') {
        endSegment('&&')
        i += 2
        continue
      }
      if (s[i + 1] === '>') {
        redirect()
        continue
      }
      // Background in bash, the call operator in PowerShell: either way a new command starts.
      endSegment('&')
      i++
      continue
    }
    if (ch === '<' && s.startsWith('<<<', i)) {
      if (dialect === 'pwsh') parseError = true
      endSegment('<<<')
      i += 3
      continue
    }
    if (ch === '<' || ch === '>') {
      redirect()
      continue
    }
    // An unquoted comma makes a PowerShell array: separate native arguments.
    if (dialect === 'pwsh' && ch === ',') {
      endWord()
      i++
      continue
    }
    cur().value += ch
    i++
  }
  endWord()
  segments.push(seg)
  return { segments, bodies, parseError }
}

/** The `$( … )` / backtick bodies bash expands inside an unquoted-delimiter heredoc. */
function heredocSubstitutions(body: string): string[] {
  const out: string[] = []
  let j = 0
  while (j < body.length) {
    const c = body[j]
    if (c === '\\') {
      j += 2
      continue
    }
    if (c === '$' && body[j + 1] === '(') {
      const b = readParenBody(body, j + 1)
      out.push(b.text)
      j = b.end
      continue
    }
    if (c === '`') {
      const b = readBacktickBody(body, j)
      out.push(b.text)
      j = b.end
      continue
    }
    j++
  }
  return out
}

// ── 2. Analysis ───────────────────────────────────────────────────────────────

/** One run of tokens to look for rule programs in. */
interface TokenList {
  values: string[]
  /** `values` normalised as program names (see {@link normalizeProgram}). */
  progs: string[]
  /** Indices where a program may sit; `undefined` = every index (the rescan). */
  candidates?: number[]
  /** `values` lower-cased, computed on first use. */
  lower?: string[]
  /** First program-position index of each program name, computed on first use. */
  firstAt?: Map<string, number>
}

interface Analysis {
  lists: TokenList[]
  /** The whole command, whitespace-collapsed, for the text-semantics union. */
  text: string
}

/**
 * Nesting cap for re-analysing bodies and quoted text as commands. Past it,
 * the text is still scanned flat (every piece a program position), so a
 * deeper nest is over-approximated, never skipped.
 */
const MAX_DEPTH = 3

/** Longer commands are scanned flat, once — over-approximate and linear. */
export const SHELL_RULES_MAX_ANALYSED_LENGTH = 64 * 1024

/** Total tokens the full analysis may produce before it falls back to the flat scan. */
const TOKEN_BUDGET = 400_000

/**
 * Programs that run their operand as another program. After one of these, the
 * first token that is not one of its flags, `K=V` assignments or numbers is a
 * program position too (`sudo -u root git …`, `nice -n 5 git …`,
 * `timeout 5 git …`), and its later arguments are re-read as ONE command with
 * that operand as the program (`Start-Process git -ArgumentList "push
 * --force"`). Shells are here for their unquoted form (`sh -c git push
 * --force`); the quoted form is the rescan's.
 */
const WRAPPERS: ReadonlySet<string> = new Set([
  'sudo',
  'doas',
  'pkexec',
  'xargs',
  'env',
  'nohup',
  'time',
  'nice',
  'command',
  'builtin',
  'exec',
  'timeout',
  'stdbuf',
  'unbuffer',
  'busybox',
  'setsid',
  'ionice',
  'taskset',
  'chrt',
  'nsenter',
  'unshare',
  'strace',
  'ltrace',
  'watch',
  'wsl',
  '.',
  'sh',
  'bash',
  'zsh',
  'dash',
  'ksh',
  'fish',
  'pwsh',
  'powershell',
  'cmd',
  'start-process',
  'saps',
  'start'
])

/**
 * Programs whose operand is a host, a directory, a file or a user BEFORE the
 * command (`ssh host cmd`, `chroot dir cmd`, `flock file cmd`, `su user -c
 * cmd`, `script -c cmd log`, `runas /user:x cmd`): every later token is a
 * program position — the tail is scanned as quoted text.
 */
const OPERAND_WRAPPERS: ReadonlySet<string> = new Set([
  'ssh',
  'chroot',
  'flock',
  'su',
  'script',
  'runas'
])

/** Container / cluster executors: after their `exec` / `run` subcommand, the tail is a command. */
const EXEC_SUBCOMMAND_PROGRAMS: ReadonlySet<string> = new Set(['docker', 'podman', 'kubectl'])

/**
 * Shell keywords and reserved words: transparent at a program position, so
 * the command after `do`, `then`, `else`, `elif`, `!`, `coproc`, `while`,
 * `until`, `if` is itself a program position (`for b in …; do git push
 * --force; done`). `case … in p)` and `{ …; }` are covered by the `)` and
 * standalone-brace boundaries.
 */
const KEYWORDS: ReadonlySet<string> = new Set([
  'if',
  'then',
  'else',
  'elif',
  'fi',
  'do',
  'done',
  'while',
  'until',
  '!',
  'coproc',
  'function',
  'select',
  'case',
  'esac',
  '{',
  '}'
])

/** Keywords that open a header of data words, not a command (`for NAME in WORDS`). */
const HEADER_KEYWORDS: ReadonlySet<string> = new Set(['for', 'select', 'case', 'function'])

/** `find` actions whose operands are a command line. */
const FIND_EXEC: ReadonlySet<string> = new Set(['-exec', '-execdir', '-ok', '-okdir'])

/** `find` actions that write a file. */
const FIND_WRITES: ReadonlySet<string> = new Set(['-fprint', '-fprint0', '-fprintf', '-fls'])

/** Programs that execute text read from stdin: `echo "…" | sh` runs whatever the left side prints. */
const STDIN_SHELLS: ReadonlySet<string> = new Set([
  'sh',
  'bash',
  'zsh',
  'dash',
  'ksh',
  'fish',
  'pwsh',
  'powershell',
  'cmd',
  'iex',
  'invoke-expression',
  'at',
  'batch'
])

/**
 * Programs that run their input — a heredoc, a here-string, or a pipe from the
 * left (`… | python`, `… | source /dev/stdin`, `… | eval "$(cat)"`): that text
 * is code, not data. With {@link runsInput}'s other tests (operand-wrapper and
 * container tails, `sudo -s`), the one executor test of the deny and allow sides.
 */
const INPUT_EXECUTORS: ReadonlySet<string> = new Set([
  ...STDIN_SHELLS,
  'source',
  '.',
  'eval',
  'parallel',
  'py',
  'node',
  'nodejs',
  'deno',
  'bun',
  'tsx',
  'perl',
  'ruby',
  'php',
  'lua',
  'ssh',
  'xargs',
  'docker',
  'podman',
  'kubectl',
  'su',
  'script'
])

function isPythonProgram(p: string): boolean {
  return /^python[\d.]*$/.test(p)
}

/**
 * Where quoted text is re-split for the rescan: whitespace plus the
 * punctuation code puts between words (`["git","push"]`, `a;b`, `x(y)`,
 * `C:\x\git.exe`, `a|b`). `/`, `.`, `-`, `=` and `+` stay inside a piece so
 * paths, flags, `--x=y` and `+ref` survive intact.
 */
const RESCAN_SPLIT = /[\s[\](),;:"'{}|&<>`\\]+/

/** `/usr/bin/git`, `C:\Git\bin\git.exe`, `GIT` → `git`. */
function normalizeProgram(token: string): string {
  const base = token.slice(Math.max(token.lastIndexOf('/'), token.lastIndexOf('\\')) + 1)
  return base.toLowerCase().replace(/\.(?:exe|cmd|bat)$/, '')
}

const ASSIGNMENT_RE = /^[A-Za-z_][A-Za-z0-9_]*=/

/** A wrapper's own option (`-n`, `--user=x`, cmd's `/c`) — never the program it runs. */
function isWrapperFlag(v: string): boolean {
  return (v.length > 1 && v.startsWith('-')) || /^\/[A-Za-z?]$/.test(v)
}

/** A duration or count operand (`timeout 5`, `nice -n 10`, `timeout 1.5m`). */
const NUMBER_RE = /^[+-]?\d+(?:\.\d+)?[smhd]?$/i

interface Candidates {
  /** Program positions, ascending. */
  positions: number[]
  /** The positions reached as a wrapper's operand. */
  viaWrapper: number[]
  /** Indices from which the rest of the segment is a command (operand wrappers, `docker exec`). */
  tails: number[]
}

/** The first index of the ascending `sorted` whose value is greater than `x`. */
function upperBound(sorted: readonly number[], x: number): number {
  let lo = 0
  let hi = sorted.length
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    if (sorted[mid] <= x) lo = mid + 1
    else hi = mid
  }
  return lo
}

/**
 * Program positions in one segment: token 0 (past `K=V` and shell keywords),
 * after wrappers, after `find -exec`; plus the tails of operand wrappers and
 * container executors. Iterative — a chain of thousands of wrappers is a
 * loop, not a recursion. The segment is scanned ONCE for `find` actions and
 * `exec`/`run` subcommands, shared by every candidate (review r2 S25: a
 * per-candidate scan was candidates × tokens).
 */
function programCandidates(values: readonly string[], progs: readonly string[]): Candidates {
  const n = values.length
  const positions = new Set<number>()
  const viaWrapper = new Set<number>()
  const tails: number[] = []
  const work: Array<[number, boolean]> = [[0, false]]
  /** Ascending indices of `-exec` & co.; those at `findExec[findPushedFrom..]` are queued already. */
  let findExec: number[] | undefined
  let findPushedFrom = 0
  /** `nextExecRun[j]`: the first `exec`/`run` at or after `j`, or -1. */
  let nextExecRun: Int32Array | undefined
  while (work.length > 0) {
    const [start, fromWrapper] = work.pop() as [number, boolean]
    let k = start
    while (k < n && (ASSIGNMENT_RE.test(values[k]) || KEYWORDS.has(values[k]))) k++
    if (k >= n || positions.has(k)) continue
    positions.add(k)
    if (fromWrapper) viaWrapper.add(k)
    const p = progs[k]
    if (OPERAND_WRAPPERS.has(p)) tails.push(k + 1)
    if (EXEC_SUBCOMMAND_PROGRAMS.has(p)) {
      if (!nextExecRun) {
        nextExecRun = new Int32Array(n + 1)
        nextExecRun[n] = -1
        for (let j = n - 1; j >= 0; j--) {
          nextExecRun[j] = values[j] === 'exec' || values[j] === 'run' ? j : nextExecRun[j + 1]
        }
      }
      const j = nextExecRun[k + 1]
      if (j >= 0) tails.push(j + 1)
    }
    if (p === 'find') {
      if (!findExec) {
        findExec = []
        for (let j = 0; j < n; j++) if (FIND_EXEC.has(values[j])) findExec.push(j)
        findPushedFrom = findExec.length
      }
      // Every action after `k` starts a command; the queued ones form a suffix of `findExec`.
      const from = upperBound(findExec, k)
      for (let q = from; q < findPushedFrom; q++) work.push([findExec[q] + 1, true])
      if (from < findPushedFrom) findPushedFrom = from
    }
    if (WRAPPERS.has(p)) {
      // A flag may take a separate value (`-u root`), so after a flag the next
      // bare word is a candidate AND so is the one after it.
      let prevFlag = false
      for (let j = k + 1; j < n; j++) {
        const v = values[j]
        if (isWrapperFlag(v)) {
          prevFlag = !v.includes('=')
          continue
        }
        if (ASSIGNMENT_RE.test(v) || NUMBER_RE.test(v)) {
          prevFlag = false
          continue
        }
        work.push([j, true])
        if (!prevFlag) break
        prevFlag = false
      }
    }
  }
  return {
    positions: [...positions].sort((a, b) => a - b),
    viaWrapper: [...viaWrapper].sort((a, b) => a - b),
    tails
  }
}

/** Wrappers whose `-s` / `-i` (no operand needed) run a shell that reads stdin: `sudo -s <<EOF`. */
const SHELL_FLAG_WRAPPERS: ReadonlySet<string> = new Set(['sudo', 'doas'])

/** Options a wrapper's shell-flag scan reads before answering "yes" — real option lists are short. */
const WRAPPER_OPTION_SCAN = 32

/** `sudo -s`, `sudo -u root -i`, `doas -s`: a shell flag among the wrapper's own options. */
function wrapperRunsShell(values: readonly string[], k: number): boolean {
  for (let j = k + 1; j < values.length; j++) {
    // Bounded, so a chain of `sudo -u sudo -u …` stays linear; past the bound, assume a shell.
    if (j - k > WRAPPER_OPTION_SCAN) return true
    const v = values[j]
    if (v === '--shell' || v === '--login') return true
    if (/^-[A-Za-z]+$/.test(v)) {
      if (/[si]/.test(v.slice(1))) return true
      continue
    }
    if (v.startsWith('-')) continue
    // A single-letter flag's value (`-u root`), else the operand: the options end here.
    if (/^-[A-Za-z]$/.test(values[j - 1])) continue
    return false
  }
  return false
}

/**
 * Does this segment run its input — a heredoc, here-string or pipe fed to it?
 * An executor at any program position ({@link INPUT_EXECUTORS}, `python*`), a
 * wrapper's shell flag (`sudo -s`), or any tail (`ssh host …`, `docker exec
 * c …`, `su`, `chroot`, `flock`, `script`: what they run reads that input).
 * The one executor test of the deny side (pipes, heredocs) and the allow side
 * (heredocs, here-strings).
 */
function runsInput(
  values: readonly string[],
  progs: readonly string[],
  cand: Candidates = programCandidates(values, progs)
): boolean {
  if (cand.tails.length > 0) return true
  return cand.positions.some(
    (k) =>
      INPUT_EXECUTORS.has(progs[k]) ||
      isPythonProgram(progs[k]) ||
      (SHELL_FLAG_WRAPPERS.has(progs[k]) && wrapperRunsShell(values, k))
  )
}

/** Worth re-splitting: quoting was involved, or the value carries blanks/punctuation. */
function needsRescan(w: PWord): boolean {
  return w.quoted || RESCAN_SPLIT.test(w.value)
}

function splitPieces(text: string): string[] {
  return text.split(RESCAN_SPLIT).filter(Boolean)
}

/** Programs whose quoted arguments are DATA — a pattern, a message, text to print. */
const DATA_ARG_PROGRAMS: ReadonlySet<string> = new Set([
  'grep',
  'egrep',
  'fgrep',
  'rg',
  'ag',
  'ack',
  'findstr',
  'select-string',
  'sls',
  'echo',
  'printf',
  'write-output',
  'write-host'
])

/** Options whose VALUE is data, per program (and git subcommand). */
const DATA_OPTIONS: Record<string, readonly string[]> = {
  'git log': ['--grep', '-S', '-G'],
  'git commit': ['-m', '--message'],
  'git tag': ['-m', '--message'],
  gh: ['--title', '--body', '-t', '-b'],
  jira: ['--summary', '--body']
}

/** git options before the subcommand that take a separate value. */
const GIT_VALUE_OPTIONS: ReadonlySet<string> = new Set([
  '-C',
  '-c',
  '--git-dir',
  '--work-tree',
  '--namespace',
  '--super-prefix',
  '--config-env'
])

/**
 * Indices of the words that are DATA for their program (ADR-085 S15): the
 * quoted arguments of a text reader or printer, `git grep`'s arguments, and
 * the values of `git log --grep/-S/-G`, `git commit|tag -m/--message`,
 * `gh --title/--body`, `jira --summary/--body`. The any-position rescan skips
 * them — a commit message quoting a denied command is not the command. Bodies
 * (`$(…)`) and the pipe-to-executor rescan are unaffected, so `echo "…" | sh`
 * and `git commit -m "$(…)"` still hit, and the exemption is lifted when the
 * text leaves the segment for somewhere it can run (`Analyzer.lexed`). A
 * program missing from the list only over-refuses.
 */
function dataWords(
  values: readonly string[],
  progs: readonly string[],
  positions: number[]
): Set<number> {
  const out = new Set<number>()
  const k = positions.find((p) => !WRAPPERS.has(progs[p]))
  if (k === undefined) return out
  const program = progs[k]
  if (DATA_ARG_PROGRAMS.has(program)) {
    for (let j = k + 1; j < values.length; j++) out.add(j)
    return out
  }
  let key = program
  let from = k + 1
  if (program === 'git') {
    let j = k + 1
    while (j < values.length && values[j].startsWith('-'))
      j += GIT_VALUE_OPTIONS.has(values[j]) ? 2 : 1
    const sub = values[j]?.toLowerCase()
    if (sub === 'grep') {
      for (let m = j + 1; m < values.length; m++) out.add(m)
      return out
    }
    key = `git ${sub}`
    from = j + 1
  }
  const options = DATA_OPTIONS[key]
  if (!options) return out
  for (let j = from; j < values.length; j++) {
    const v = values[j]
    for (const o of options) {
      if (v === o) out.add(j + 1)
      else if (o.startsWith('--') ? v.startsWith(`${o}=`) : v.startsWith(o) && v.length > o.length)
        out.add(j)
    }
    // `git commit -am "msg"`: a short cluster ending in the option letter takes the next word.
    if (options.includes('-m') && /^-[A-Za-z]+m$/.test(v)) out.add(j + 1)
  }
  return out
}

/** Redirect targets that are no file: what is written there never runs. */
const NULL_SINKS: ReadonlySet<string> = new Set([
  '/dev/null',
  '/dev/stdout',
  '/dev/stderr',
  'nul',
  '$null'
])

/** Script extensions: a file written with one of these is there to be run. */
const SCRIPT_EXTENSION_RE = /\.(?:sh|bash|zsh|ps1|psm1|bat|cmd|py|js|mjs|cjs|ts|rb|pl|php)$/

/** Shell start-up files: what is written there runs in the next shell. */
const RC_FILES: ReadonlySet<string> = new Set([
  '.bashrc',
  '.bash_profile',
  '.profile',
  '.zshrc',
  '.zprofile',
  '.zshenv',
  'profile.ps1',
  'microsoft.powershell_profile.ps1'
])

/**
 * Paths whose contents a later program runs: anything under `.git/` (config
 * aliases and `core.fsmonitor`, hooks, attribute filter drivers — review r3
 * S28), any `hooks/` directory, and the agents' own control directories. A
 * small explicit list on purpose — this module stays a leaf (it does not
 * import ADR-084's agent-control paths), and a miss only keeps the text data.
 */
const RUN_LATER_PATH_RE = /(?:^|\/)(?:hooks\/|\.git\/|\.(?:claude|codex|pi)(?:\/|\.|$))/

/** Lower-cased basename, either separator. */
function baseNameLower(path: string): string {
  return path.slice(Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\')) + 1).toLowerCase()
}

/** A script, a shell start-up file, a hook or an agent-control path. */
function isRunLaterPath(target: string): boolean {
  const p = target.replace(/\\/g, '/').toLowerCase()
  const base = baseNameLower(p)
  return SCRIPT_EXTENSION_RE.test(base) || RC_FILES.has(base) || RUN_LATER_PATH_RE.test(p)
}

/** `-EncodedCommand` and its abbreviations. */
function isEncodedCommandFlag(v: string): boolean {
  const l = v.toLowerCase().split(':')[0]
  return l === '-ec' || (l.length >= 2 && '-encodedcommand'.startsWith(l))
}

/** A pwsh `-EncodedCommand` operand: base64 of UTF-16LE text. Bounded; `undefined` when it is not one. */
function decodeEncodedCommand(b64: string): string | undefined {
  const compact = b64.replace(/\s+/g, '')
  if (compact.length === 0 || compact.length > 65536 || !/^[A-Za-z0-9+/]+=*$/.test(compact)) {
    return undefined
  }
  try {
    const bin = atob(compact)
    let out = ''
    for (let k = 0; k + 1 < bin.length; k += 2) {
      out += String.fromCharCode(bin.charCodeAt(k) | (bin.charCodeAt(k + 1) << 8))
    }
    return out
  } catch {
    return undefined
  }
}

/** Operators that carry the output of the command before them into the one after. */
const PIPE_OPS: ReadonlySet<string> = new Set(['|', '|&'])

/** Operators that join a segment to the one before into one command: pipes, and `<<<` (a here-string is its command's input). */
const CONNECT_OPS: ReadonlySet<string> = new Set([...PIPE_OPS, '<<<'])

/** Words that close a compound command: its output is the whole construct's (see `Analyzer.lexed`). */
const CLOSING_KEYWORDS: ReadonlySet<string> = new Set(['done', 'fi', 'esac'])

/** Words that open a compound command: piped into, every command in it reads that pipe. */
const OPENING_KEYWORDS: ReadonlySet<string> = new Set([
  'while',
  'until',
  'if',
  'for',
  'case',
  'select'
])

/** One segment, tokenized and located — the facts `Analyzer.lexed` works from. */
interface SegmentFacts {
  seg: PSegment
  /** The words that are not redirect targets. */
  words: PWord[]
  values: string[]
  progs: string[]
  cand: Candidates
  /** {@link runsInput}. */
  runs: boolean
}

/** The files a segment writes: output-redirect targets other than `/dev/null` & co., and `tee`'s operands. */
function fileSinks({ seg, values, progs, cand }: SegmentFacts): string[] {
  const out = seg.words
    .filter((w) => w.target && w.sink && !NULL_SINKS.has(w.value.toLowerCase()))
    .map((w) => w.value)
  const k = cand.positions.find((p) => !WRAPPERS.has(progs[p]))
  if (k !== undefined && progs[k] === 'tee') {
    for (let j = k + 1; j < values.length; j++) if (!values[j].startsWith('-')) out.push(values[j])
  }
  return out
}

/** Does this segment run code it is handed: an executor, or any wrapper / operand wrapper? */
function runsCode({ progs, cand, runs }: SegmentFacts): boolean {
  return (
    runs || cand.positions.some((k) => WRAPPERS.has(progs[k]) || OPERAND_WRAPPERS.has(progs[k]))
  )
}

class BudgetExceeded extends Error {}

class Analyzer {
  readonly lists: TokenList[] = []
  private tokens = 0
  private readonly seenFull = new Set<string>()
  private readonly seenFlat = new Set<string>()

  push(list: TokenList): void {
    if (list.values.length === 0) return
    this.tokens += list.values.length
    if (this.tokens > TOKEN_BUDGET) throw new BudgetExceeded()
    this.lists.push(list)
  }

  /** Every piece of `text` a program position. */
  flat(text: string): void {
    if (this.seenFlat.has(text)) return
    this.seenFlat.add(text)
    const pieces = splitPieces(text)
    this.push({ values: pieces, progs: pieces.map(normalizeProgram) })
  }

  /** `text` as a command in its own right (depth-capped: past the cap, flat). */
  command(text: string, depth: number): void {
    if (depth > MAX_DEPTH) {
      this.flat(text)
      return
    }
    if (this.seenFull.has(text)) return
    this.seenFull.add(text)
    for (const dialect of DIALECTS) {
      const lexed = lexPermissive(text, dialect)
      // PowerShell rejects the whole script at parse time: this reading runs nothing.
      if (!lexed.parseError) this.lexed(lexed, depth)
    }
  }

  /**
   * Quoted text: scanned with the program allowed at ANY position — what
   * catches `sh -c "…"`, `bun -e '…["git","push","--force"]…'`,
   * `pwsh -Command "…"` and `cmd /c "…"` without a list of every
   * interpreter's flag — and re-analysed as a command, so nested quoting and
   * escapes inside it are decoded.
   */
  rescan(text: string, depth: number): void {
    this.flat(text)
    this.command(text, depth + 1)
  }

  /**
   * One lexed command: every segment's token list and special readings, the
   * pipe-to-executor rescan, heredocs, and the quoted-content rescan with its
   * data exemptions — and where they stop (review r2 B6–B9):
   *
   * - A segment that runs its input ({@link runsInput}) rescans EVERY segment
   *   feeding it — the whole run of `|` / `|&` / `<<<` before it, values,
   *   heredocs and here-strings: `echo "…" | tee log | sh`, `| python`,
   *   `| ssh host`, `| source /dev/stdin`. A compound command's closer
   *   (`)`, `}`, `done`, `fi`, `esac`) reaches back to the start of the text
   *   (over-approximate: `for …; do echo "…"; done | sh`).
   * - Empty segments are transparent to a pipe (review r3 B10): bash's
   *   trailing `|` before a newline (`echo … |⏎sh`) and PowerShell 7's leading
   *   `|` on the next line (`echo …⏎| iex`) both connect. A pipe INTO a
   *   compound command (`| (sh)`, `| { sh; }`, `| while …; do sh; done`,
   *   `| if …; then sh; fi`) gives its stdin to every later segment — to the
   *   end of the text, not to the matching closer (over-approximate, and no
   *   closer matching to get wrong): an executor there rescans that pipeline.
   * - The data exemption (a data program's quoted arguments, a heredoc not fed
   *   to an executor) is LIFTED when the text leaves the segment for somewhere
   *   it can run: always for a pipe out of the segment or a `>( … )` body in
   *   it; for a written FILE (an output redirect other than `/dev/null`, or
   *   `tee`'s operands) when its name reappears in a later segment
   *   (`> x.sh && sh x.sh`), it is a script / start-up / hook / agent-control
   *   path, or a later segment runs a shell, interpreter or wrapper. A lifted
   *   segment's quoted words are rescanned and its heredocs read as commands.
   *   Anything else stays data (`cat <<'EOF' > notes.md`).
   */
  private lexed(lexed: PLex, depth: number): void {
    const segs: SegmentFacts[] = lexed.segments.map((seg) => {
      const words = seg.words.filter((w) => !w.target)
      const values = words.map((w) => w.value)
      const progs = values.map(normalizeProgram)
      const cand = programCandidates(values, progs)
      return { seg, words, values, progs, cand, runs: runsInput(values, progs, cand) }
    })
    const m = segs.length
    const closer = (k: number): boolean => {
      const { seg, values } = segs[k]
      return (
        seg.op === ')' || seg.op === '}' || (values.length > 0 && CLOSING_KEYWORDS.has(values[0]))
      )
    }
    // `start[k]`: the first segment of the command (pipeline) that ends with segment `k`.
    // `feeder[k]`: for a segment a pipe feeds, the first segment of the pipeline
    // feeding it (it ends at `k - 1`), else -1. Empty segments are transparent:
    // the ops of every empty segment since the previous non-empty one count as
    // this segment's own — and a pipe with no command after it (`cat <<EOF |`
    // before its body) still carries its left side out.
    const start: number[] = []
    const feeder: number[] = new Array<number>(m).fill(-1)
    /** The segment (or an empty one just before it) opens a group: `(`, `{`. */
    const groupOpen: boolean[] = new Array<boolean>(m).fill(false)
    // Segments whose output a pipe carries on (difference array over the pipeline).
    const pipeDiff = new Int32Array(m + 1)
    let prev = -1
    let connects = false
    let pipes = false
    let closedBetween = false
    let opens = false
    for (let k = 0; k < m; k++) {
      const { seg, values } = segs[k]
      const op = seg.op
      if (op !== null && CONNECT_OPS.has(op)) connects = true
      if (op !== null && PIPE_OPS.has(op)) pipes = true
      if (op === '(' || op === '{') opens = true
      const from = prev >= 0 && connects ? (closedBetween ? 0 : start[prev]) : k
      if (values.length === 0) {
        if (prev >= 0 && op !== null && PIPE_OPS.has(op)) {
          pipeDiff[from]++
          pipeDiff[prev + 1]--
        }
        if (closer(k)) closedBetween = true
        start.push(closer(k) ? 0 : from)
        continue
      }
      if (prev >= 0 && pipes) {
        feeder[k] = from
        pipeDiff[from]++
        pipeDiff[k]--
      }
      groupOpen[k] = opens
      start.push(closer(k) ? 0 : from)
      prev = k
      connects = pipes = closedBetween = opens = false
    }
    const lifted: boolean[] = []
    for (let k = 0, open = 0; k < m; k++) {
      open += pipeDiff[k]
      lifted.push(open > 0 || segs[k].seg.procOut === true)
    }
    this.liftForFileSinks(segs, start, lifted)

    // What an executor reads, it runs: every segment feeding it, data words and
    // heredocs included (what `echo` prints, `sh` runs). Each segment is fed once;
    // `skip` jumps over fed ones (path-compressed), so feeding stays linear.
    const skip = Int32Array.from({ length: m + 1 }, (_, j) => j)
    const nextUnfed = (j: number): number => {
      let root = j
      while (skip[root] !== root) root = skip[root]
      while (skip[j] !== root) {
        const next = skip[j]
        skip[j] = root
        j = next
      }
      return root
    }
    const feed = (from: number, to: number): void => {
      for (let j = nextUnfed(from); j <= to; j = nextUnfed(j + 1)) {
        skip[j] = j + 1
        if (segs[j].values.length > 0) this.rescan(segs[j].values.join(' '), depth)
        for (const h of segs[j].seg.heredocs) this.command(h.body, depth + 1)
      }
    }
    // `… | xargs git`: the feeding side's words become arguments of the command.
    const xargsJoin = (values: string[], x: number, from: number, to: number): void => {
      const joined = values.slice(x + 1)
      for (let j = from; j <= to; j++) joined.push(...segs[j].values.flatMap(splitPieces))
      this.push({ values: joined, progs: joined.map(normalizeProgram) })
    }
    /** The pipeline piped into a compound command, which every later segment reads. */
    let inherited: { from: number; to: number } | undefined
    for (let k = 0; k < m; k++) {
      const { seg, words, values, progs, cand, runs } = segs[k]
      const liftedHere = lifted[k]
      if (values.length > 0) {
        this.push({ values, progs, candidates: cand.positions })
        this.special(values, progs, cand, depth)
      }
      const x = cand.positions.find((p) => progs[p] === 'xargs')
      if (feeder[k] >= 0) {
        if (runs) feed(feeder[k], k - 1)
        if (x !== undefined) xargsJoin(values, x, feeder[k], k - 1)
        if (groupOpen[k] || OPENING_KEYWORDS.has(values[0])) {
          inherited = {
            from: Math.min(inherited?.from ?? feeder[k], feeder[k]),
            to: Math.max(inherited?.to ?? k - 1, k - 1)
          }
        }
      } else if (inherited && values.length > 0) {
        if (runs) feed(inherited.from, inherited.to)
        if (x !== undefined) xargsJoin(values, x, inherited.from, inherited.to)
      }
      for (const h of seg.heredocs) {
        if (runs || liftedHere) this.command(h.body, depth + 1)
        else if (!h.quoted) {
          for (const sub of heredocSubstitutions(h.body)) this.command(sub, depth + 1)
        }
        // `xargs git <<EOF` … : the heredoc's words become arguments of the command.
        if (runs && x !== undefined) {
          const joined = [...values.slice(x + 1), ...splitPieces(h.body)]
          this.push({ values: joined, progs: joined.map(normalizeProgram) })
        }
      }
      if (values.length === 0) continue
      const data = liftedHere ? new Set<number>() : dataWords(values, progs, cand.positions)
      const quoted: string[] = []
      words.forEach((w, j) => {
        if (data.has(j)) return
        if (needsRescan(w)) this.rescan(w.value, depth)
        if (w.quoted) quoted.push(w.value)
      })
      // PowerShell string building (`"git push " + "--force"`): the quoted pieces, joined.
      if (quoted.length > 1) {
        this.rescan(quoted.join(' '), depth)
        this.rescan(quoted.join(''), depth)
      }
    }
    for (const body of lexed.bodies) this.command(body, depth + 1)
  }

  /**
   * B9 rule 2: a command that writes a FILE loses its data exemption when that
   * file can run — see {@link lexed}. The whole pipeline writing it is lifted,
   * and a compound command's closer (`done > x.sh`, `) > x.sh`) lifts every
   * segment before it.
   */
  private liftForFileSinks(
    segs: readonly SegmentFacts[],
    start: number[],
    lifted: boolean[]
  ): void {
    const m = segs.length
    const sinks = segs.map(fileSinks)
    if (!sinks.some((s) => s.length > 0)) return
    // The last segment each file name (basename) appears in, and "a later segment runs code".
    const lastMention = new Map<string, number>()
    segs.forEach(({ seg }, j) => {
      const texts = [...seg.words.map((w) => w.value), ...seg.heredocs.map((h) => h.body)]
      for (const text of texts) {
        for (const piece of splitPieces(text)) lastMention.set(baseNameLower(piece), j)
      }
    })
    const execAfter: boolean[] = new Array<boolean>(m).fill(false)
    for (let k = m - 2; k >= 0; k--) execAfter[k] = execAfter[k + 1] || runsCode(segs[k + 1])
    const diff = new Int32Array(m + 1)
    for (let k = 0; k < m; k++) {
      if (sinks[k].length === 0) continue
      const runnable =
        execAfter[k] ||
        sinks[k].some((t) => isRunLaterPath(t) || (lastMention.get(baseNameLower(t)) ?? -1) > k)
      if (!runnable) continue
      diff[start[k]]++
      diff[k + 1]--
    }
    for (let k = 0, open = 0; k < m; k++) {
      open += diff[k]
      if (open > 0) lifted[k] = true
    }
  }

  /** Wrapper operands, operand-wrapper tails, dashed git, inline git aliases, encoded PowerShell. */
  private special(values: string[], progs: string[], cand: Candidates, depth: number): void {
    const n = values.length
    // Each list below is ONE list for all its program positions, not one per
    // position (review r2 S19/S25: one per wrapper made `sudo ×900` exhaust the
    // token budget). That is equivalent: a rule hits at the first position
    // naming its program, which has every later token after it.
    //
    // A wrapper's operand re-read as a command with its arguments split
    // (`Start-Process git -ArgumentList "push --force"`). Only the END of a
    // wrapper chain is a position here — an intermediate wrapper could only
    // match a rule naming that wrapper, which the segment's own list does — and
    // a later operand also appears split, for the operands before it.
    const ends = cand.viaWrapper.filter((k) => !WRAPPERS.has(progs[k]))
    if (ends.length > 0) {
      const isEnd = new Set(ends)
      const argv: string[] = []
      const candidates: number[] = []
      for (let j = ends[0]; j < n; j++) {
        const pieces = splitPieces(values[j])
        if (isEnd.has(j)) {
          candidates.push(argv.length)
          argv.push(values[j])
          if (pieces.length === 1 && pieces[0] === values[j]) continue
        }
        argv.push(...pieces)
      }
      this.push({ values: argv, progs: argv.map(normalizeProgram), candidates })
    }
    // Every tail is a suffix of the earliest one, which therefore covers them all.
    if (cand.tails.length > 0) {
      let t = cand.tails[0]
      for (const x of cand.tails) if (x < t) t = x
      const tail = values.slice(t).flatMap(splitPieces)
      this.push({ values: tail, progs: tail.map(normalizeProgram) })
    }
    // `git-push --force`: the dashed binary is the subcommand.
    const dashed = cand.positions.filter((k) => /^git-[a-z]/.test(progs[k]))
    if (dashed.length > 0) {
      const isDashed = new Set(dashed)
      const argv: string[] = []
      const candidates: number[] = []
      for (let j = dashed[0]; j < n; j++) {
        if (isDashed.has(j)) {
          candidates.push(argv.length)
          argv.push('git', progs[j].slice(4))
        } else argv.push(values[j])
      }
      this.push({ values: argv, progs: argv.map(normalizeProgram), candidates })
    }
    const positions = cand.positions
    // An inline alias or an encoded command means the same whichever `git` /
    // `pwsh` precedes it: read each once, after the first (review r2 S25).
    const firstGit = positions.find((k) => progs[k] === 'git')
    if (firstGit !== undefined) {
      // `git -c alias.p='push --force' p`: the alias value is a git subcommand (or, `!…`, a shell command).
      for (let j = firstGit + 1; j < n; j++) {
        const v =
          values[j] === '-c' ? values[j + 1] : values[j].startsWith('-c') ? values[j].slice(2) : ''
        const m = /^alias\.[^=]+=(.*)$/is.exec(v ?? '')
        if (!m) continue
        if (m[1].startsWith('!')) this.rescan(m[1].slice(1), depth)
        else {
          const argv = ['git', ...splitPieces(m[1])]
          this.push({ values: argv, progs: argv.map(normalizeProgram), candidates: [0] })
        }
      }
    }
    const firstPwsh = positions.find((k) => progs[k] === 'pwsh' || progs[k] === 'powershell')
    if (firstPwsh !== undefined) {
      for (let j = firstPwsh + 1; j + 1 < n; j++) {
        if (!isEncodedCommandFlag(values[j])) continue
        const decoded = decodeEncodedCommand(values[j + 1])
        if (decoded !== undefined) this.rescan(decoded, depth)
      }
    }
  }
}

function normalizeWs(s: string): string {
  return s.trim().replace(/\s+/g, ' ')
}

/**
 * Every piece of the whole command a program position — the fallback for the
 * huge and the pathological. Over both the raw text and its PowerShell
 * typography fold (curly quotes, dashes), and through `pwsh -EncodedCommand`
 * (decoded, then scanned the same way; review r2 S19). The spellings only the
 * full analysis decodes are listed under "Known residuals".
 */
function flatAnalysis(command: string): TokenList[] {
  const lists: TokenList[] = []
  const scan = (text: string, depth: number): void => {
    const folded = foldPwshTypography(text)
    for (const t of folded === text ? [text] : [text, folded]) {
      const pieces = splitPieces(t)
      if (pieces.length === 0) continue
      const progs = pieces.map(normalizeProgram)
      lists.push({ values: pieces, progs })
      if (depth >= 2) continue
      let pwsh = false
      for (let j = 0; j + 1 < pieces.length; j++) {
        if (progs[j] === 'pwsh' || progs[j] === 'powershell') pwsh = true
        else if (pwsh && isEncodedCommandFlag(pieces[j])) {
          const decoded = decodeEncodedCommand(pieces[j + 1])
          if (decoded !== undefined) scan(decoded, depth + 1)
        }
      }
    }
  }
  scan(command, 0)
  return lists
}

/** The last analysed command — a gate asks about each rule of a tier in turn, on the same text. */
let memo: { command: string; analysis: Analysis } | undefined

function analyze(command: string): Analysis {
  if (memo?.command === command) return memo.analysis
  let lists: TokenList[]
  if (command.length > SHELL_RULES_MAX_ANALYSED_LENGTH) {
    lists = flatAnalysis(command)
  } else {
    try {
      const analyzer = new Analyzer()
      analyzer.command(command, 0)
      lists = analyzer.lists
    } catch (err) {
      if (!(err instanceof BudgetExceeded)) throw err
      lists = flatAnalysis(command)
    }
  }
  const analysis = { lists, text: normalizeWs(command) }
  memo = { command, analysis }
  return analysis
}

// ── 3. Rules and words ────────────────────────────────────────────────────────

export interface BashRuleWord {
  text: string
  /** Carries an unquoted `*` / `?`: matched as a shell glob whose wildcards do not cross `/`. */
  glob: boolean
}

export interface ParsedBashRule {
  /** Basename, lower-cased, `.exe` stripped — compared against the same normalisation of a token. */
  program: string
  words: BashRuleWord[]
  /** `x:*`, `x *` or a trailing `*`. Deny/ask treat an exact rule as a prefix too. */
  prefix: boolean
  /** The specifier as written. */
  raw: string
}

/** Quote-aware split of a rule specifier (bash quoting), flagging unquoted glob characters. */
function splitRuleWords(s: string): Array<{ value: string; glob: boolean }> {
  const out: Array<{ value: string; glob: boolean }> = []
  let value = ''
  let glob = false
  let started = false
  const end = (): void => {
    if (started) out.push({ value, glob })
    value = ''
    glob = false
    started = false
  }
  for (let i = 0; i < s.length; i++) {
    const c = s[i]
    if (/\s/.test(c)) {
      end()
      continue
    }
    started = true
    if (c === "'" || c === '"') {
      const close = s.indexOf(c, i + 1)
      const stop = close < 0 ? s.length : close
      value += s.slice(i + 1, stop)
      i = stop
      continue
    }
    if (c === '\\' && i + 1 < s.length) {
      value += s[i + 1]
      i++
      continue
    }
    if (c === '*' || c === '?') glob = true
    value += c
  }
  end()
  return out
}

function parseBashRuleUnsafe(specifier: string): ParsedBashRule | undefined {
  let s = specifier.trim()
  let prefix = false
  if (s.endsWith(':*')) {
    s = s.slice(0, -2)
    prefix = true
  } else if (/\s\*$/.test(s)) {
    s = s.replace(/\s+\*$/, '')
    prefix = true
  } else if (s.endsWith('*')) {
    prefix = true
  }
  const tokens = splitRuleWords(s)
  if (tokens.length === 0 || tokens[0].value === '') return undefined
  return {
    program: normalizeProgram(tokens[0].value),
    words: tokens.slice(1).map((t) => ({ text: t.value, glob: t.glob })),
    prefix,
    raw: specifier
  }
}

/**
 * Parse a `Bash(...)` specifier: `x:*`, a trailing ` *` and a trailing `*` make
 * it a prefix rule; the first word is the program (normalised like a token),
 * the rest are the words every hit must carry. `undefined` when there is no
 * program at all (`Bash(:*)`) — the text semantics then decide.
 */
export function parseBashRule(specifier: string): ParsedBashRule | undefined {
  try {
    return parseBashRuleUnsafe(specifier)
  } catch {
    return undefined
  }
}

/** One `/`-free segment of a glob against one of text: classic two-pointer wildcard match, no backtracking blow-up. */
function wildSegment(p: string, t: string): boolean {
  let i = 0
  let j = 0
  let star = -1
  let mark = 0
  while (j < t.length) {
    if (i < p.length && (p[i] === '?' || p[i] === t[j])) {
      i++
      j++
    } else if (i < p.length && p[i] === '*') {
      star = i
      mark = j
      i++
    } else if (star !== -1) {
      i = star + 1
      mark++
      j = mark
    } else return false
  }
  while (i < p.length && p[i] === '*') i++
  return i === p.length
}

/**
 * Shell-glob semantics: `*` and `?` never cross `/` — `rm -rf /*` covers `/`
 * (and Git Bash's `//`) and `/etc`, not `/d/work/dist`. Linear-time: a `/` in
 * the glob must line up with a `/` in the text, so both are split on `/` and
 * matched segment by segment. `prefix`: the glob need only match a prefix of
 * the text (the rest may contain `/`). Repeated `/` in the text collapse
 * first, then ONE trailing `/` is dropped from each side (not from `/` itself):
 * `rm -rf /etc/` is "directly under root" for `Bash(rm -rf /*)` (review r2
 * S20) — a bash pathname glob would not match it, but that is the rule's intent.
 */
function globMatch(
  glob: string,
  text: string,
  opts: { prefix?: boolean; ci?: boolean } = {}
): boolean {
  const fold = (x: string): string => (opts.ci ? x.toLowerCase() : x)
  const trim = (x: string): string => (x.length > 1 && x.endsWith('/') ? x.slice(0, -1) : x)
  const g = trim(fold(glob).replace(/\*+/g, '*')).split('/')
  const t = trim(fold(text).replace(/\/{2,}/g, '/')).split('/')
  if (opts.prefix) {
    if (t.length < g.length) return false
    const last = g.length - 1
    for (let k = 0; k < last; k++) if (!wildSegment(g[k], t[k])) return false
    return wildSegment(`${g[last]}*`, t[last])
  }
  return t.length === g.length && g.every((seg, k) => wildSegment(seg, t[k]))
}

/** `rm` and its spellings in PowerShell and cmd — one program for rule purposes. */
const RM_FAMILY: ReadonlySet<string> = new Set([
  'rm',
  'remove-item',
  'ri',
  'del',
  'erase',
  'rd',
  'rmdir'
])

/**
 * Program families: one program under its PowerShell cmdlet name, its aliases
 * and its bash/cmd namesakes. A rule naming any member names them all
 * (over-approximate: `Bash(Get-ChildItem:*)` also hits `ls`, and ADR-084's
 * read-only checker always matched an alias against its cmdlet's name).
 */
const PROGRAM_FAMILIES: ReadonlyArray<ReadonlySet<string>> = [
  RM_FAMILY,
  new Set(['get-childitem', 'gci', 'ls', 'dir']),
  new Set(['get-content', 'gc', 'cat', 'type']),
  new Set(['copy-item', 'cpi', 'cp', 'copy']),
  new Set(['move-item', 'mi', 'mv', 'move']),
  new Set(['select-string', 'sls']),
  new Set(['get-location', 'gl', 'pwd']),
  new Set(['get-command', 'gcm']),
  new Set(['select-object', 'select']),
  new Set(['measure-object', 'measure']),
  new Set(['format-table', 'ft']),
  new Set(['where-object', 'where']),
  new Set(['write-output', 'write', 'echo'])
]

/** Every program name a rule's program stands for (itself, or its whole family). */
function programNames(ruleProgram: string): readonly string[] {
  const family = PROGRAM_FAMILIES.find((f) => f.has(ruleProgram))
  return family ? [...family] : [ruleProgram]
}

function sameProgram(ruleProgram: string, tokenProgram: string): boolean {
  if (ruleProgram === tokenProgram) return true
  if (/[*?]/.test(ruleProgram)) return globMatch(ruleProgram, tokenProgram, { ci: true })
  return PROGRAM_FAMILIES.some((f) => f.has(ruleProgram) && f.has(tokenProgram))
}

/**
 * PowerShell parameter names whose letters are not an option cluster
 * (`-Path`, `-Force`, `-Filter`), compared case-insensitively.
 */
const PS_PARAMETER_NAMES: ReadonlySet<string> = new Set([
  'path',
  'name',
  'force',
  'filter',
  'include',
  'exclude',
  'recurse',
  'depth',
  'file',
  'hidden',
  'confirm',
  'whatif',
  'verbose',
  'debug',
  'value',
  'encoding',
  'raw',
  'tail',
  'first',
  'last',
  'property',
  'pattern',
  'context',
  'stream',
  'wait',
  'passthru',
  'append',
  'width'
])

/** A short-option cluster token (`-rf`, `-Rfvi`, `-la`): one dash and up to eight letters, not a PowerShell parameter name. */
function isClusterToken(t: string): boolean {
  return /^-[A-Za-z0-9]{1,8}$/.test(t) && !PS_PARAMETER_NAMES.has(t.slice(1).toLowerCase())
}

/** A rule word that reads as a letter set: one dash, one to three letters. */
function isClusterWord(w: string): boolean {
  return /^-[A-Za-z0-9]{1,3}$/.test(w)
}

/** One way a token can spell a concept (see {@link SYNONYMS}). */
type Member =
  | { letter: string }
  | { long: string }
  | { param: string }
  | { exact: string }
  | { refPrefix: string }

interface Concept {
  members: Member[]
  /** Alternatively satisfied when every one of these is (`-D` ≡ `--delete --force`). */
  allOf?: Concept[]
}

interface SynonymEntry {
  programs: ReadonlySet<string>
  /** Applies only to rules that name this subcommand. */
  sub?: string
  /** First match wins when a rule word maps to a concept. */
  concepts: Concept[]
}

function memberMatches(m: Member, t: string): boolean {
  if ('letter' in m) return isClusterToken(t) && t.slice(1).includes(m.letter)
  if ('long' in m) {
    const name = `--${m.long}`
    const tn = t.split('=')[0].toLowerCase()
    return tn === name || (tn.startsWith('--') && tn.length >= 4 && name.startsWith(tn))
  }
  if ('param' in m) {
    if (!t.startsWith('-') || t.startsWith('--')) return false
    const tl = t.slice(1).split(':')[0].toLowerCase()
    return tl.length >= 2 && m.param.startsWith(tl)
  }
  if ('exact' in m) return t.toLowerCase() === m.exact
  return t.length > 1 && t.startsWith(m.refPrefix)
}

const GIT_PUSH_FORCE: Concept = {
  members: [
    { letter: 'f' },
    { long: 'force' },
    { long: 'force-with-lease' },
    { long: 'force-if-includes' },
    // `git push origin +main` force-pushes that one ref.
    { refPrefix: '+' }
  ]
}
const GIT_PUSH_DELETE: Concept = {
  // `git push origin :feat` deletes the remote ref.
  members: [{ letter: 'd' }, { long: 'delete' }, { refPrefix: ':' }]
}
const GIT_BRANCH_DELETE_ONLY: Concept = { members: [{ letter: 'd' }, { long: 'delete' }] }
const GIT_BRANCH_FORCE_ONLY: Concept = { members: [{ letter: 'f' }, { long: 'force' }] }
const GIT_FORCE: Concept = { members: [{ letter: 'f' }, { long: 'force' }] }
const GIT_SWITCH_FORCE: Concept = {
  members: [{ letter: 'f' }, { long: 'force' }, { long: 'discard-changes' }]
}
const RM_RECURSIVE: Concept = {
  members: [
    { letter: 'r' },
    { letter: 'R' },
    { long: 'recursive' },
    { param: 'recurse' },
    { exact: '/s' }
  ]
}
const RM_FORCE: Concept = {
  members: [
    { letter: 'f' },
    { long: 'force' },
    { param: 'force' },
    { exact: '/q' },
    { exact: '/f' }
  ]
}
const GIT: ReadonlySet<string> = new Set(['git'])

/**
 * The synonym table — small and program-scoped on purpose: a flag means
 * something only for the program (and subcommand) that defines it. A rule word
 * that maps to a concept here is satisfied by ANY spelling of that concept.
 */
const SYNONYMS: readonly SynonymEntry[] = [
  { programs: GIT, sub: 'push', concepts: [GIT_PUSH_FORCE, GIT_PUSH_DELETE] },
  {
    programs: GIT,
    sub: 'branch',
    concepts: [
      {
        members: [{ letter: 'D' }],
        allOf: [GIT_BRANCH_DELETE_ONLY, GIT_BRANCH_FORCE_ONLY]
      },
      { members: [{ letter: 'd' }, { letter: 'D' }, { long: 'delete' }] },
      { members: [{ letter: 'f' }, { letter: 'D' }, { long: 'force' }] }
    ]
  },
  { programs: GIT, sub: 'clean', concepts: [GIT_FORCE] },
  { programs: GIT, sub: 'checkout', concepts: [GIT_FORCE] },
  { programs: GIT, sub: 'switch', concepts: [GIT_SWITCH_FORCE] },
  { programs: RM_FAMILY, concepts: [RM_RECURSIVE, RM_FORCE] }
]

function conceptsFor(rule: ParsedBashRule): Concept[] {
  return SYNONYMS.filter(
    (e) =>
      e.programs.has(rule.program) &&
      (e.sub === undefined || rule.words.some((w) => w.text.toLowerCase() === e.sub))
  ).flatMap((e) => e.concepts)
}

/**
 * The literal ways a token can match a rule word:
 * - a positional (non-`-`) word, case-insensitively — PowerShell's names are,
 *   and a case-sensitive program (`git`, `docker`) would reject the variant
 *   anyway; a `-` word of three or more characters case-insensitively too (the
 *   PowerShell parameter case); a two-character flag exactly (`-D` ≠ `-d`);
 * - `--long` ↔ `--long=…`, and an abbreviation `--lo…` (at least `--` + 2) the
 *   word starts with, as getopt accepts;
 * - the LAST word of a prefix rule, when it begins with `-`, as a prefix
 *   (`--force` → `--force-with-lease`); any other word must be whole
 *   (`docker run:*` never hits `docker build -t runtime`);
 * - a glob word as a shell glob.
 */
function plainMatch(w: BashRuleWord, t: string, tl: string, lastOfPrefix: boolean): boolean {
  const word = w.text
  if (w.glob) return globMatch(word, t, { ci: true })
  if (t === word) return true
  if (!word.startsWith('-')) return tl === word.toLowerCase()
  if (word.length > 2 && tl === word.toLowerCase()) return true
  if (word.startsWith('--')) {
    if (t.startsWith(`${word}=`)) return true
    const tn = t.split('=')[0]
    if (tn.startsWith('--') && tn.length >= 4 && word.startsWith(tn)) return true
  }
  return lastOfPrefix && t.startsWith(word)
}

/**
 * A rule word's test over one token list, as a THRESHOLD: the word is
 * satisfied for a program at index `k` iff `k < threshold` (i.e. a matching
 * token lies after `k`). "Some token matches" is the last matching index; OR
 * is the max of thresholds, AND the min. That makes a rule O(list) per word,
 * whatever the number of program positions.
 */
type Atom = (list: TokenList) => number

function lowerOf(list: TokenList): string[] {
  if (!list.lower) list.lower = list.values.map((v) => v.toLowerCase())
  return list.lower
}

function lastIndex(list: TokenList, pred: (t: string, tl: string) => boolean): number {
  const lower = lowerOf(list)
  for (let i = list.values.length - 1; i >= 0; i--) if (pred(list.values[i], lower[i])) return i
  return -1
}

function conceptAtom(c: Concept): Atom {
  const subs = c.allOf?.map(conceptAtom)
  return (list) => {
    const direct = lastIndex(list, (t) => c.members.some((m) => memberMatches(m, t)))
    if (!subs) return direct
    return Math.max(direct, Math.min(...subs.map((a) => a(list))))
  }
}

/**
 * One rule word → its {@link Atom}. The alternatives are OR'ed: the literal
 * match, the word's synonym concept, the letters of a short cluster (each
 * letter by its concept when it has one — `-rf` is "recursive AND force" — or
 * as a cluster letter or the PowerShell parameter it abbreviates), and a
 * PowerShell parameter abbreviation of the word itself.
 */
function wordAtom(w: BashRuleWord, lastOfPrefix: boolean, concepts: readonly Concept[]): Atom {
  const alternatives: Atom[] = [
    (list) => lastIndex(list, (t, tl) => plainMatch(w, t, tl, lastOfPrefix))
  ]
  if (!w.glob) {
    if (isClusterWord(w.text)) {
      const letters = [...w.text.slice(1)].map((ch): Atom => {
        const c = concepts.find((k) => k.members.some((m) => 'letter' in m && m.letter === ch))
        if (c) return conceptAtom(c)
        const lc = ch.toLowerCase()
        return (list) =>
          lastIndex(
            list,
            (t) =>
              (isClusterToken(t) && t.slice(1).includes(ch)) ||
              (/^-[A-Za-z]{2,}$/.test(t) && t[1].toLowerCase() === lc)
          )
      })
      alternatives.push((list) => Math.min(...letters.map((a) => a(list))))
    } else {
      const c = concepts.find((k) => k.members.some((m) => memberMatches(m, w.text)))
      if (c) alternatives.push(conceptAtom(c))
    }
    if (w.text.length > 2 && w.text.startsWith('-') && !w.text.startsWith('--')) {
      const name = w.text.slice(1).toLowerCase()
      alternatives.push((list) =>
        lastIndex(list, (t, tl) => {
          if (!t.startsWith('-') || t.startsWith('--')) return false
          const p = tl.slice(1).split(':')[0]
          return p.length >= 2 && name.startsWith(p)
        })
      )
    }
  }
  return (list) => Math.max(...alternatives.map((a) => a(list)))
}

interface CompiledRule {
  program: string
  /** {@link programNames}, or `undefined` for a glob program. */
  names?: readonly string[]
  atoms: Atom[]
  text: (text: string) => boolean
}

/**
 * Today's text semantics, kept as a UNION so nothing that hit before stops
 * hitting: whole-command `startsWith` for a prefix rule, equality for an exact
 * one, and — for a specifier with `*` — the glob over the whole command (with
 * `*` not crossing `/`, the same convergence as the token globs).
 * Whitespace-collapsed and case-SENSITIVE, as pi compared: a case-folded
 * program is the token matcher's job, and folding the whole text would make
 * `Bash(git branch -D:*)` hit the safe `git branch -d`.
 */
function textMatcher(specifier: string): (text: string) => boolean {
  let base = normalizeWs(specifier)
  let prefix = false
  if (base.endsWith(':*')) {
    base = base.slice(0, -2)
    prefix = true
  } else if (base.endsWith(' *')) {
    base = base.slice(0, -2)
    prefix = true
  }
  if (/[*?]/.test(base)) return (text) => globMatch(base, text, { prefix })
  return prefix ? (text) => text.startsWith(base) : (text) => text === base
}

function compileRule(specifier: string): CompiledRule {
  const text = textMatcher(specifier)
  const parsed = parseBashRuleUnsafe(specifier)
  if (!parsed) return { program: '', atoms: [], text }
  const concepts = conceptsFor(parsed)
  // An exact deny/ask rule is treated as a prefix: `Bash(git push --force)` still means `--force-with-lease`.
  const atoms = parsed.words.map((w, k) => wordAtom(w, k === parsed.words.length - 1, concepts))
  const names = /[*?]/.test(parsed.program) ? undefined : programNames(parsed.program)
  return { program: parsed.program, names, atoms, text }
}

/**
 * Does the rule hit anywhere in the analysis? Per token list: the FIRST
 * program position `k0` (the best one — every word then has the most tokens
 * after it), and a hit iff `k0` is below every word's threshold. Linear.
 */
function firstProgramIndex(list: TokenList, rule: CompiledRule): number {
  const positions = (): readonly number[] => list.candidates ?? list.progs.map((_, k) => k)
  if (rule.names === undefined) {
    // A glob program: test each position (rare — a user-written `Bash(*x …)`).
    return positions().find((k) => sameProgram(rule.program, list.progs[k])) ?? -1
  }
  if (!list.firstAt) {
    const firstAt = new Map<string, number>()
    for (const k of positions()) if (!firstAt.has(list.progs[k])) firstAt.set(list.progs[k], k)
    list.firstAt = firstAt
  }
  let first = -1
  for (const name of rule.names) {
    const k = list.firstAt.get(name)
    if (k !== undefined && (first < 0 || k < first)) first = k
  }
  return first
}

function compiledRuleHits(rule: CompiledRule, analysis: Analysis): boolean {
  if (rule.program !== '') {
    for (const list of analysis.lists) {
      const first = firstProgramIndex(list, rule)
      if (first < 0) continue
      if (rule.atoms.every((a) => a(list) > first)) return true
    }
  }
  return rule.text(analysis.text)
}

/** A `Bash` rule's specifier (`undefined` = the whole tool), or `null` when the rule is not a Bash rule. */
function bashSpecifier(rule: string): string | undefined | null {
  const parsed = parseRuleText(rule)
  if (!parsed || parsed.tool !== 'Bash') return null
  return parsed.specifier
}

/**
 * Is any of these rules a `Bash` rule (by the same parser every question here
 * uses)? The Codex compiler's "any Bash deny/ask?" gate (review r2 S24). Never
 * throws (an internal failure answers `true`, which withholds more).
 */
export function hasBashRule(rules: readonly string[]): boolean {
  try {
    return rules.some((rule) => bashSpecifier(rule) !== null)
  } catch {
    return true
  }
}

function firstHit(command: string, rules: readonly string[]): string | undefined {
  for (const rule of rules) {
    const spec = bashSpecifier(rule)
    if (spec === null) continue
    // A bare `Bash` (or `Bash(*)`) deny/ask covers every command.
    if (spec === undefined) return rule
    if (compiledRuleHits(compileRule(spec), analyze(command))) return rule
  }
  return undefined
}

// ── 4. Public questions ───────────────────────────────────────────────────────

export interface DenyAskHit {
  tier: 'deny' | 'ask'
  rule: string
}

/**
 * Does one of the user's `Bash(...)` deny or ask rules hit this command? Deny
 * first. Every other tool's rules are ignored.
 *
 * A rule `prog w1 … wn` hits when, at some program position, `prog` is the
 * program and every `wi` matches some later token of that segment — in any
 * order, with any gap (`git -C . push origin main --force`). Program
 * positions: token 0 of every segment and substitution body, past shell
 * keywords (`do`, `then`, `!`, …), past wrappers (`sudo`, `env A=1`,
 * `nice -n 5`, `xargs`, PowerShell `&`), path-qualified or quoted
 * (`/usr/bin/git`, `git.exe`, `"git"`); anywhere in the tail of `ssh host`,
 * `docker exec c`, `chroot dir`; and ANY position inside quoted text that is
 * not data for its program ({@link dataWords}). Words match by the literal
 * rules of {@link plainMatch}, the synonym table, short-cluster letter sets
 * (`-rf` ↔ `-fr`, `-r -f`, `-Rf`, `-Recurse -Force`) and PowerShell parameter
 * abbreviation. Plus the text union ({@link textMatcher}).
 *
 * Deliberately NOT any position in a plain segment: `echo rm -rf`, `git rm -rf`
 * and `ls -la rm` do not hit `Bash(rm -rf:*)`.
 *
 * Never throws: an internal failure answers `ask` with
 * {@link UNANALYSABLE_COMMAND} — fail toward asking.
 */
export function denyAskHit(
  command: string,
  rules: { deny?: readonly string[]; ask?: readonly string[] }
): DenyAskHit | undefined {
  try {
    const deny = firstHit(command, rules.deny ?? [])
    if (deny !== undefined) return { tier: 'deny', rule: deny }
    const ask = firstHit(command, rules.ask ?? [])
    if (ask !== undefined) return { tier: 'ask', rule: ask }
    return undefined
  } catch {
    return { tier: 'ask', rule: UNANALYSABLE_COMMAND }
  }
}

export interface AllowCoverage {
  /** Every segment (bash reading), with the allow rule that covers it. */
  segments: Array<{ segment: string; rule: string }>
}

interface AllowEntry {
  rule: string
  /** A bare `Bash` / `Bash(*)`: every segment. */
  all: boolean
  prefix: boolean
  words: string[]
  /** Whitespace-collapsed specifier, for the exact whole-command shortcut. */
  exactText: string
}

function allowEntries(rules: readonly string[]): AllowEntry[] {
  const out: AllowEntry[] = []
  for (const rule of rules) {
    const spec = bashSpecifier(rule)
    if (spec === null) continue
    if (spec === undefined) {
      out.push({ rule, all: true, prefix: false, words: [], exactText: '' })
      continue
    }
    let s = spec.trim()
    let prefix = false
    if (s.endsWith(':*')) {
      s = s.slice(0, -2)
      prefix = true
    } else if (/\s\*$/.test(s)) {
      s = s.replace(/\s+\*$/, '')
      prefix = true
    }
    const words = splitRuleWords(s)
    // A glob in an allow rule is not a word-boundary prefix of anything: unusable here.
    if (words.length === 0 || words.some((w) => w.glob)) continue
    out.push({
      rule,
      all: false,
      prefix,
      words: words.map((w) => w.value),
      exactText: normalizeWs(s)
    })
  }
  return out
}

/** `x:*` covers `x` and `x …`, never `xy`; an exact rule covers exactly its words. */
function entryCovers(e: AllowEntry, tokens: readonly string[]): boolean {
  if (e.all) return true
  if (e.prefix ? tokens.length < e.words.length : tokens.length !== e.words.length) return false
  return e.words.every((w, k) => tokens[k] === w)
}

function coveringRule(
  entries: readonly AllowEntry[],
  tokens: readonly string[]
): string | undefined {
  return entries.find((e) => entryCovers(e, tokens))?.rule
}

/**
 * Lenient coverage of one command text (recursive into substitution bodies):
 * the bash-reading segments with their rules, or `undefined` when anything is
 * uncovered.
 */
function lenientSegments(
  text: string,
  entries: readonly AllowEntry[],
  depth: number
): AllowCoverage['segments'] | undefined {
  if (depth > MAX_DEPTH) return undefined
  let result: AllowCoverage['segments'] = []
  for (const dialect of DIALECTS) {
    const lexed = lexPermissive(text, dialect)
    // PowerShell cannot parse this reading at all, so nothing of it runs.
    if (lexed.parseError) continue
    const segments: AllowCoverage['segments'] = []
    let prev: { values: string[]; progs: string[] } | undefined
    for (const seg of lexed.segments) {
      const tokens = seg.words.filter((w) => !w.target).map((w) => w.value)
      if (tokens.length === 0) continue
      const progs = tokens.map(normalizeProgram)
      if (seg.op === '<<<') {
        // A here-string is data for the previous command, unless that command runs its input.
        if (prev && runsInput(prev.values, prev.progs)) return undefined
        continue
      }
      // Shell keywords are not commands: `do X`, `then X`, `! X` cover as `X`; a
      // `for`/`select`/`case`/`function` header is data (its substitutions are bodies).
      let start = 0
      while (start < tokens.length && KEYWORDS.has(tokens[start])) start++
      const command = HEADER_KEYWORDS.has(tokens[0]) ? [] : tokens.slice(start)
      // A "command" named `-x` runs nothing in either shell — e.g. the PowerShell
      // reading of a bash `\`-continued `--flag` line.
      if (command.length > 0 && !command[0].startsWith('-')) {
        const rule = coveringRule(entries, command)
        if (rule === undefined) return undefined
        segments.push({ segment: command.join(' '), rule })
      }
      for (const h of seg.heredocs) {
        // A heredoc is data — unless the command runs it, or bash expands a substitution inside it.
        if (runsInput(tokens, progs)) return undefined
        if (!h.quoted) {
          for (const sub of heredocSubstitutions(h.body)) {
            if (lenientSegments(sub, entries, depth + 1) === undefined) return undefined
          }
        }
      }
      prev = { values: tokens, progs }
    }
    // Every substitution body is a command of its own: covered only when it is covered too.
    for (const body of lexed.bodies) {
      if (lenientSegments(body, entries, depth + 1) === undefined) return undefined
    }
    if (dialect === 'posix') result = segments
  }
  return result
}

function lenientCoverage(
  command: string,
  entries: readonly AllowEntry[]
): AllowCoverage | undefined {
  // The user allowed this exact command string, operators and all — including
  // a prefix rule minted from it by "always allow" (the engines suggest
  // `Bash(<whole command>:*)`), which must keep matching the command it came from.
  const whole = normalizeWs(command)
  const exact = entries.find((e) => !e.all && e.exactText === whole)
  if (exact) return { segments: [{ segment: whole, rule: exact.rule }] }
  const segments = lenientSegments(command, entries, 0)
  return segments && segments.length > 0 ? { segments } : undefined
}

function strictCoverage(
  command: string,
  entries: readonly AllowEntry[]
): AllowCoverage | undefined {
  const lexed = lexShellStrict(command)
  if (!lexed.ok) return undefined
  const segments: AllowCoverage['segments'] = []
  for (const seg of lexed.segments) {
    if (seg.tokens.length === 0) continue
    const posix = seg.tokens.map((t) => t.posix)
    const rule = coveringRule(entries, posix)
    if (
      rule === undefined ||
      coveringRule(
        entries,
        seg.tokens.map((t) => t.win)
      ) === undefined
    ) {
      return undefined
    }
    segments.push({ segment: posix.join(' '), rule })
  }
  return segments.length > 0 ? { segments } : undefined
}

/**
 * Is every segment of this command covered by one of these `Bash(...)` allow
 * rules? `undefined` = not covered.
 *
 * Coverage is word-boundary prefix (`x:*` covers `x` and `x …`, not `xy` — the
 * same test cli.js makes, so `Bash(bun run test:*)` does not cover
 * `bun run test:unit` and `Bash(git:*)` does not cover `git-lfs`) or exact.
 * Programs are NOT normalised and words are compared case-sensitively:
 * `/tmp/x/git` is not `git`. (cli.js lower-cases both sides and normalises the
 * first word; this is stricter, which is the safe direction for an allow.)
 *
 * - `lenient` (the non-auto allow tier): split at the operators of both
 *   dialects (quote-aware; a newline inside quotes is not a split), every
 *   segment of both readings covered; every `$( … )` / backtick / `<( … )` /
 *   `>( … )` / `@( … )` body covered recursively (a `$(` inside single quotes
 *   or escaped is literal); a heredoc is data unless its command runs it
 *   (`sh <<EOF`, `python -`, …) or bash expands a substitution in it;
 *   redirections allowed. A rule whose text (less any `:*`) is the whole
 *   command covers it as written. So Claude's commit shape
 *   `git commit -m "$(cat <<'EOF' … EOF)"` is covered when `git` and `cat`
 *   are.
 * - `strict` (the auto-mode judge skip): ADR-084's two-dialect lexer, which
 *   refuses redirections, newlines, `$` and every construct the dialects split
 *   differently; both token views of every segment covered.
 *
 * A bare `Bash` allow rule covers every command in both modes — callers decide
 * whether it is usable. Never throws; over {@link SHELL_RULES_MAX_ANALYSED_LENGTH}
 * nothing but a bare `Bash` rule covers.
 */
export function allowCovers(
  command: string,
  allowRules: readonly string[],
  mode: 'lenient' | 'strict'
): AllowCoverage | undefined {
  try {
    const entries = allowEntries(allowRules)
    const all = entries.find((e) => e.all)
    if (all) return { segments: [{ segment: normalizeWs(command), rule: all.rule }] }
    if (entries.length === 0 || command.length > SHELL_RULES_MAX_ANALYSED_LENGTH) return undefined
    return mode === 'lenient' ? lenientCoverage(command, entries) : strictCoverage(command, entries)
  } catch {
    return undefined
  }
}

// ── Allow-rule predicates (S5, Codex rules-sync) ─────────────────────────────

/**
 * cli.js's interpreter/launcher prefixes (`SJt` + `Qmr` for Bash, `OOn`'s list
 * for PowerShell; `docs/protocol-cc/14-auto-mode-classifier.md` §3.0) — used
 * as ONE union for both tools, each also as `<name>.exe`.
 */
const LAUNCHERS: readonly string[] = [
  'python',
  'python3',
  'python2',
  'node',
  'deno',
  'tsx',
  'ruby',
  'perl',
  'php',
  'lua',
  'npx',
  'bunx',
  'npm run',
  'yarn run',
  'pnpm run',
  'bun run',
  'bash',
  'sh',
  'ssh',
  'zsh',
  'fish',
  'eval',
  'exec',
  'env',
  'xargs',
  'sudo',
  'pwsh',
  'powershell',
  'cmd',
  'wsl',
  'iex',
  'invoke-expression',
  'icm',
  'invoke-command',
  'start-process',
  'saps',
  'start',
  'start-job',
  'sajb',
  'start-threadjob',
  'invoke-wmimethod',
  'iwmi',
  'invoke-cimmethod',
  'icim',
  'wmic',
  'register-objectevent',
  'register-engineevent',
  'register-wmievent',
  'register-scheduledjob',
  'new-pssession',
  'nsn',
  'enter-pssession',
  'etsn',
  'add-type',
  'new-object'
]

/** Tools where ANY rule bypasses the classifier (cli.js `Mwo` / `Fn` / the Appifact REPL). */
const ALWAYS_BYPASSING_TOOLS: ReadonlySet<string> = new Set([
  'Agent',
  'Task',
  'Monitor',
  'AppifactRepl'
])

/** cli.js `wJt`'s launcher shapes over {@link LAUNCHERS}; `pythonException` is Bash's `-m dotted.module:*`. */
function launcherShape(specifier: string, pythonException: boolean): boolean {
  const n = specifier.trim().toLowerCase()
  if (n === '*') return true
  for (const g of LAUNCHERS) {
    const space = g.indexOf(' ')
    const exe = space < 0 ? `${g}.exe` : `${g.slice(0, space)}.exe${g.slice(space)}`
    for (const name of [g, exe]) {
      if (n === name || n === `${name}:*` || n === `${name} *` || n === `${name}*`) return true
      if (n.startsWith(`${name} -`) && n.endsWith('*')) {
        const rest = n.slice(name.length + 1, -1)
        if (
          pythonException &&
          /^python[\d.]*$/.test(g) &&
          /^-m\s+\w+\.[\w.]+(\s*:|\s+)$/.test(rest)
        ) {
          continue
        }
        return true
      }
    }
  }
  return false
}

/**
 * cli.js `ZIe` parity (§3.0 of the classifier doc): would this allow rule let
 * the agent bypass the auto-mode classifier wholesale? True for a bare / `*` /
 * whitespace-and-`*` Bash or PowerShell rule; a launcher shape (`g`, `g:*`,
 * `g *`, `g*`, `g -…*`) over the union launcher list, except Bash's
 * `python[digits.]* -m dotted.module:*`; and any `Agent`, `Task`, `Monitor` or
 * `AppifactRepl` rule. Pure over the rule string — `autoMode.classifyAllShell`
 * is the caller's input. `Bash(git:*)`, `Bash(npm:*)` and
 * `Bash(bun run test:*)` are NOT bypassing (parity: they survive in cli.js
 * too). Never throws (an internal failure answers `true`).
 */
export function isClassifierBypassingRule(rule: string): boolean {
  try {
    const parsed = parseRuleText(rule)
    if (!parsed) return false
    if (ALWAYS_BYPASSING_TOOLS.has(parsed.tool)) return true
    if (parsed.tool !== 'Bash' && parsed.tool !== 'PowerShell') return false
    const spec = parsed.specifier
    if (spec === undefined || /^[\s*]+$/.test(spec)) return true
    return launcherShape(spec, parsed.tool === 'Bash')
  } catch {
    return true
  }
}

function isPrefixOf(a: readonly string[], b: readonly string[]): boolean {
  return a.length <= b.length && a.every((w, k) => w === b[k])
}

/** The positional (non-flag) words of a rule — what selects a subcommand. */
function positional(rule: ParsedBashRule): string[] {
  return rule.words.filter((w) => !w.text.startsWith('-')).map((w) => w.text.toLowerCase())
}

/** The reason {@link isCarvedOut} gives when it cannot analyse a rule. */
const UNANALYSABLE_RULE = '(unanalysable rule)'

function carvedOutUnsafe(
  allowRule: string,
  denyAsk: { deny: readonly string[]; ask: readonly string[] },
  strength: 'positional' | 'program'
): string | undefined {
  const allowSpec = bashSpecifier(allowRule)
  if (allowSpec === null) return undefined
  const others = [...denyAsk.deny, ...denyAsk.ask].filter((r) => bashSpecifier(r) !== null)
  if (others.length === 0) return undefined
  if (allowSpec === undefined || isClassifierBypassingRule(allowRule)) return others[0]
  const allow = parseBashRuleUnsafe(allowSpec)
  // A wrapper (`sudo`, `env`, `xargs`, `timeout`, …) runs whatever follows it.
  if (!allow || WRAPPERS.has(allow.program) || OPERAND_WRAPPERS.has(allow.program)) return others[0]
  for (const other of others) {
    const spec = bashSpecifier(other)
    if (!spec) return other
    const narrower = parseBashRuleUnsafe(spec)
    if (!narrower) return other
    const same =
      sameProgram(narrower.program, allow.program) || sameProgram(allow.program, narrower.program)
    if (strength === 'program') {
      if (same) return other
      continue
    }
    if (!allow.prefix) {
      if (denyAskHit(allowSpec, { deny: [other] })) return other
      continue
    }
    if (!same) continue
    const a = positional(allow)
    const b = positional(narrower)
    if (isPrefixOf(a, b) || isPrefixOf(b, a)) return other
  }
  return undefined
}

/**
 * Is this allow rule broader than a deny/ask rule? Returns that deny/ask rule,
 * or `undefined`. Two strengths:
 *
 * - `'positional'` (the host, S5 — the default): same program, and one rule's
 *   positional words are a prefix of the other's (`git:*` ⊃
 *   `git push --force:*`, `git push:*` ⊃ it, `docker:*` ⊃ `docker run:*`;
 *   `git status:*` is not). Positional words only, because flags do not narrow
 *   what a prefix rule covers — `rm -f:*` covers `rm -f -r /` just as well as
 *   `rm:*` does. BOTH directions: an ask rule broader than the allow
 *   (`ask git:*`, `allow git status:*`) binds the whole allow. An exact allow
 *   is carved out only when its own command hits. The host consults the full
 *   matcher on every command anyway, so this only decides whether the rule may
 *   skip the judge.
 * - `'program'` (Codex rules-sync): ANY deny/ask rule for the same program
 *   family carves the allow out. An emitted execpolicy `allow` never reaches
 *   the matcher again, and the matcher hits words in any order
 *   (`docker compose run web` hits `Bash(docker run:*)`), so a positional
 *   prefix is not a safe enough test there.
 *
 * Both: a bare `Bash` allow, a launcher-shaped allow
 * ({@link isClassifierBypassingRule}) and one whose program is a wrapper
 * (`sudo git:*`) are carved out by any Bash deny/ask; a bare `Bash` deny/ask
 * carves out every Bash allow. Never throws (an internal failure answers
 * "carved out").
 */
export function isCarvedOut(
  allowRule: string,
  denyAsk: { deny: readonly string[]; ask: readonly string[] },
  opts: { strength?: 'positional' | 'program' } = {}
): string | undefined {
  try {
    return carvedOutUnsafe(allowRule, denyAsk, opts.strength ?? 'positional')
  } catch {
    return UNANALYSABLE_RULE
  }
}

const SHELL_PROGRAMS: ReadonlySet<string> = new Set([
  'sh',
  'bash',
  'zsh',
  'dash',
  'ksh',
  'fish',
  'pwsh',
  'powershell',
  'cmd'
])

/**
 * Wrappers and launchers that run their operand as another program, whatever
 * the operand. The shells are in {@link WRAPPERS} for program-position
 * purposes, but whether a shell invocation launches code depends on its flags
 * (see {@link isLauncherShapedSegment}), so they are left out here.
 */
const ALWAYS_LAUNCHING: ReadonlySet<string> = new Set([
  ...[...WRAPPERS].filter((w) => !SHELL_PROGRAMS.has(w)),
  ...OPERAND_WRAPPERS,
  'npx',
  'bunx',
  'pnpx',
  'uvx',
  'eval',
  'source',
  // They run their input (a heredoc, a pipe) as commands.
  'at',
  'batch',
  'parallel',
  '&',
  'iex',
  'invoke-expression',
  'icm',
  'invoke-command',
  'start-job',
  'sajb',
  'start-threadjob',
  'invoke-wmimethod',
  'iwmi',
  'invoke-cimmethod',
  'icim',
  'wmic',
  'register-objectevent',
  'register-engineevent',
  'register-wmievent',
  'register-scheduledjob',
  'new-pssession',
  'nsn',
  'enter-pssession',
  'etsn',
  'add-type',
  'new-object'
])

const POSIX_SHELL_NAMES: ReadonlySet<string> = new Set([
  'sh',
  'bash',
  'zsh',
  'dash',
  'ksh',
  'fish',
  'ash',
  'csh',
  'tcsh'
])

const AWK_PROGRAMS: ReadonlySet<string> = new Set(['awk', 'gawk', 'mawk', 'nawk'])

/**
 * Every program {@link isLauncherShapedSegment} can answer `true` for — the
 * programs an allow rule can reach ANY other program through, given the right
 * arguments.
 */
const LAUNCHER_CAPABLE: ReadonlySet<string> = new Set([
  ...ALWAYS_LAUNCHING,
  ...SHELL_PROGRAMS,
  ...POSIX_SHELL_NAMES,
  ...AWK_PROGRAMS,
  'py',
  'node',
  'nodejs',
  'perl',
  'ruby',
  'php',
  'lua',
  'tsx',
  'deno',
  'bun',
  'npm',
  'pnpm',
  'yarn',
  'uv',
  'pipx',
  'docker',
  'podman',
  'kubectl',
  'git',
  'find',
  'sed',
  'make'
])

/**
 * Could an allow rule for this command reach other programs — is its program
 * one {@link isLauncherShapedSegment} can call launcher-shaped (a shell, a
 * wrapper, an interpreter or package runner, `docker`/`kubectl`, `git`,
 * `find`, `sed`, `awk`, `make`)? Also true for a bare or launcher-shaped Bash
 * rule. The Codex compiler withholds such allows whenever the user has any
 * Bash deny/ask rule: an emitted execpolicy `allow` would skip every review
 * of `npm exec -- git push --force`. Never throws (answers `true`).
 */
export function canLaunchOtherPrograms(allowRule: string): boolean {
  try {
    const spec = bashSpecifier(allowRule)
    if (spec === null) return false
    if (spec === undefined || isClassifierBypassingRule(allowRule)) return true
    const parsed = parseBashRuleUnsafe(spec)
    if (!parsed) return true
    return LAUNCHER_CAPABLE.has(parsed.program) || isPythonProgram(parsed.program)
  } catch {
    return true
  }
}

/** `-e`, `--eval=…`: the flag, or the flag with an attached value. */
function hasFlag(args: readonly string[], flags: readonly string[]): boolean {
  return args.some((a) => flags.some((f) => a === f || a.startsWith(`${f}=`)))
}

/** A short cluster (`-lc`, `-Sc`) carrying `letter`. */
function hasClusterLetter(args: readonly string[], letter: RegExp): boolean {
  return args.some((a) => /^-[A-Za-z]+$/.test(a) && letter.test(a.slice(1)))
}

function firstPositional(args: readonly string[]): string | undefined {
  return args.find((a) => !a.startsWith('-'))
}

/** A POSIX shell runs code from `-c`, or from stdin when it has no script operand. */
function shellRunsCode(args: readonly string[]): boolean {
  if (firstPositional(args) === undefined) return true
  return hasClusterLetter(args, /[cs]/) || hasFlag(args, ['--command']) || args.includes('-')
}

/**
 * pwsh/powershell run code from `-Command` / `-CommandWithArgs` /
 * `-EncodedCommand` (any abbreviation, and `-cwa`), stdin, or — Windows
 * PowerShell — a bare positional.
 */
function pwshRunsCode(program: string, args: readonly string[]): boolean {
  if (firstPositional(args) === undefined) return true
  if (program === 'powershell') return true
  return args.some((a) => {
    const l = a.toLowerCase().split(':')[0]
    return (
      l === '-' ||
      l === '-ec' ||
      l === '-cwa' ||
      (l.length >= 2 && '-command'.startsWith(l)) ||
      (l.length >= 2 && '-commandwithargs'.startsWith(l)) ||
      (l.length >= 2 && '-encodedcommand'.startsWith(l))
    )
  })
}

/** git config keys whose value is code the NEXT git call runs. */
const GIT_CODE_CONFIG_KEY =
  /^(?:core\.(?:hookspath|fsmonitor|sshcommand|pager|editor|askpass)|alias\..+|.+\.command|.+\.textconv|.+\.cmd|diff\.external|sequence\.editor|credential\.helper|.+\.driver|.+\.clean|.+\.smudge|.+\.process)$/i

/**
 * The git subcommands that run a command string or a program they are given:
 * `config <code-bearing key>` (it arms the next git call), `rebase -x|--exec`,
 * `difftool -x|--extcmd`, `bisect run`, `submodule foreach`, and
 * `filter-branch --*-filter` (review r2 S21).
 */
function gitSubcommandRunsCode(sub: string, rest: readonly string[]): boolean {
  switch (sub) {
    case 'config':
      return rest.some((v) => GIT_CODE_CONFIG_KEY.test(v.split('=')[0]))
    case 'rebase':
      return hasClusterLetter(rest, /x/) || hasFlag(rest, ['--exec'])
    case 'difftool':
      return hasClusterLetter(rest, /x/) || hasFlag(rest, ['--extcmd'])
    case 'bisect':
      return firstPositional(rest) === 'run'
    case 'submodule':
      return rest.includes('foreach')
    case 'filter-branch':
      return rest.some((a) => /^--[a-z-]+-filter(?:=|$)/.test(a))
    default:
      return false
  }
}

/**
 * `git -c k=v …` (an alias or hook can be defined inline), `--config-env`,
 * `--exec-path=<dir>`, and the subcommands of {@link gitSubcommandRunsCode}.
 */
function gitRunsCode(args: readonly string[]): boolean {
  for (let k = 0; k < args.length; k++) {
    const a = args[k]
    if (a === '-c' || (a.startsWith('-c') && a.length > 2)) return true
    if (hasFlag([a], ['--config-env', '--exec-path'])) return true
    if (!a.startsWith('-')) return gitSubcommandRunsCode(a, args.slice(k + 1))
    if (GIT_VALUE_OPTIONS.has(a)) k++
  }
  return false
}

/** Skip one sed address (`12`, `$`, `/re/I`, `\cREc`, ranges with `,` / `~`). */
function skipSedAddress(s: string, i: number): number {
  const one = (k: number): number => {
    if (/\d/.test(s[k] ?? '')) {
      while (/\d/.test(s[k] ?? '')) k++
      if (s[k] === '~') {
        k++
        while (/\d/.test(s[k] ?? '')) k++
      }
      return k
    }
    if (s[k] === '$') return k + 1
    if (s[k] === '/' || (s[k] === '\\' && s[k + 1] !== undefined)) {
      const d = s[k] === '/' ? '/' : s[k + 1]
      k += s[k] === '/' ? 1 : 2
      while (k < s.length && s[k] !== d) k += s[k] === '\\' ? 2 : 1
      k++
      while (/[IM]/.test(s[k] ?? '')) k++
      return k
    }
    return k
  }
  let k = one(i)
  if (k !== i && s[k] === ',') {
    k++
    if (s[k] === '+' || s[k] === '~') {
      k++
      while (/\d/.test(s[k] ?? '')) k++
    } else k = one(k)
  }
  return k
}

/**
 * Does a sed script execute or write anything — an `e` command, a `w`/`W`
 * command, or an `s///` substitution with an `e` or `w` flag? (A write is
 * launcher-shaped for our purpose: it plants a file outside any path check.)
 */
function sedScriptExecutes(script: string): boolean {
  const n = script.length
  let i = 0
  while (i < n) {
    while (i < n && /[\s;{}!]/.test(script[i])) i++
    i = skipSedAddress(script, i)
    while (i < n && /[\s!]/.test(script[i])) i++
    const c = script[i]
    if (c === undefined) break
    if (c === 'e' || c === 'w' || c === 'W') return true
    if (c === 's' || c === 'y') {
      const d = script[i + 1]
      if (d === undefined) return false
      let j = i + 2
      let seen = 0
      while (j < n && seen < 2) {
        if (script[j] === '\\') {
          j += 2
          continue
        }
        if (script[j] === d) seen++
        j++
      }
      // Flags run to a blank, `;`, `}` or a newline.
      while (j < n && !/[\s;}]/.test(script[j])) {
        if (c === 's' && (script[j] === 'e' || script[j] === 'w')) return true
        j++
      }
      i = j
      continue
    }
    if ('aicrR'.includes(c)) {
      // Text / filename operands run to the end of the line.
      while (i < n && script[i] !== '\n') i++
      continue
    }
    if ('btT:'.includes(c)) {
      // A label ends at `;` or a newline.
      while (i < n && script[i] !== ';' && script[i] !== '\n') i++
      continue
    }
    i++
  }
  return false
}

/** sed: an executing or writing script, or a script FILE (contents unknown). */
function sedExecutes(args: readonly string[]): boolean {
  const scripts: string[] = []
  let explicit = false
  for (let k = 0; k < args.length; k++) {
    const a = args[k]
    if (a === '-e' || a === '--expression') {
      scripts.push(args[k + 1] ?? '')
      k++
      explicit = true
      continue
    }
    if (a.startsWith('--expression=')) {
      scripts.push(a.slice('--expression='.length))
      explicit = true
      continue
    }
    if (a === '--file' || a.startsWith('--file=') || /^-[A-Za-z]*f/.test(a)) return true
    if (/^-[A-Za-z]*e/.test(a)) {
      // `-ne 'script'` / `-es/x/y/`: the cluster's `e` takes the rest, or the next argument.
      const rest = a.slice(a.indexOf('e') + 1)
      if (rest) scripts.push(rest)
      else {
        scripts.push(args[k + 1] ?? '')
        k++
      }
      explicit = true
      continue
    }
    if (a.startsWith('-')) continue
    if (!explicit) {
      scripts.push(a)
      explicit = true
    }
  }
  return scripts.some(sedScriptExecutes)
}

/** An awk program that runs or writes: `system(…)`, a pipe to or from a command, `print >` / `printf >`. */
function awkProgramRuns(program: string): boolean {
  return /system\s*\(|\||\bprintf?\b[^;}]*>/.test(program)
}

/** awk: an executing or writing program, or a program file. */
function awkExecutes(args: readonly string[]): boolean {
  for (let k = 0; k < args.length; k++) {
    const a = args[k]
    if (a === '-f' || a === '--file' || a.startsWith('--file=') || /^-f./.test(a)) return true
    if (a === '-e' || a === '--source') {
      if (awkProgramRuns(args[k + 1] ?? '')) return true
      k++
      continue
    }
    if (a === '-F' || a === '-v' || a === '--field-separator' || a === '--assign') {
      k++
      continue
    }
    if (a.startsWith('-')) continue
    return awkProgramRuns(a)
  }
  return false
}

function launcherShapedUnsafe(tokens: readonly string[]): boolean {
  if (tokens.length === 0) return false
  const program = normalizeProgram(tokens[0])
  const args = tokens.slice(1)
  if (ALWAYS_LAUNCHING.has(program)) return true
  const sub = firstPositional(args)
  if (isPythonProgram(program) || program === 'py') {
    // `-c code`, `-` (stdin), `-i` (a REPL on stdin), or no script at all.
    return args.length === 0 || args.includes('-') || hasClusterLetter(args, /[ci]/)
  }
  if (POSIX_SHELL_NAMES.has(program)) return shellRunsCode(args)
  if (AWK_PROGRAMS.has(program)) return awkExecutes(args)
  switch (program) {
    case 'npm':
    case 'pnpm':
    case 'yarn':
      return sub === 'exec' || sub === 'x' || sub === 'dlx'
    case 'bun':
      return (
        sub === 'x' ||
        sub === 'run' ||
        sub === 'exec' ||
        hasFlag(args, ['-e', '--eval', '-p', '--print'])
      )
    case 'node':
    case 'nodejs':
      return (
        args.includes('-') ||
        hasFlag(args, ['-e', '--eval', '-p', '--print']) ||
        hasClusterLetter(args, /[ep]/)
      )
    case 'perl':
      return hasClusterLetter(args, /[eE]/)
    case 'ruby':
      return hasClusterLetter(args, /e/)
    case 'deno':
      return sub === 'eval' || sub === 'run'
    case 'uv':
      return sub === 'run' || (sub === 'tool' && args[args.indexOf('tool') + 1] === 'run')
    case 'pipx':
      return sub === 'run'
    case 'pwsh':
    case 'powershell':
      return pwshRunsCode(program, args)
    case 'cmd':
      return sub === undefined || args.some((a) => /^\/[ckr]$/i.test(a))
    case 'docker':
    case 'podman':
    case 'kubectl':
      return args.some((a) => a === 'exec' || a === 'run')
    case 'git':
      return gitRunsCode(args)
    case 'find':
      // `-exec` & co. run a command; `-fprint*` / `-fls` write a file (like `sed w`).
      return args.some((a) => FIND_EXEC.has(a) || FIND_WRITES.has(a))
    case 'sed':
      return sedExecutes(args)
    default:
      return false
  }
}

/**
 * Is this one segment (unquoted token values) launcher- or interpreter-shaped
 * — does it run code its own words do not show? ADR-085 §4 "Safety checks"
 * (review B4(a)): `npm exec|x`, `npx`, `bunx`, `bun x|-e|--eval|run`,
 * `node -e|--eval|-p|-`, `python -c|-` (or bare), `perl -e`, `ruby -e`,
 * `deno eval|run`, `uv run`, `uvx`, `pipx run`, a shell with `-c` / `-Command`
 * / `-CommandWithArgs` / `-EncodedCommand` / `/c` / `/r` (or reading stdin),
 * `eval`, `exec`, `env`, `xargs`, `sudo`, `ssh`, `su`, `chroot` and the other
 * wrappers, `at` / `batch` / `parallel`, the PowerShell launchers,
 * `docker|podman|kubectl exec|run`, `git -c`, `git config <code key>`,
 * `git rebase -x|--exec`, `git difftool -x|--extcmd`, `git bisect run`,
 * `git submodule foreach`, `git filter-branch --*-filter`, `python -i`,
 * `find … -exec*|-fprint*|-fls`, `sed` with an executing or writing script,
 * `awk` with `system(`, a pipe or `print >`. S5 never lets an allow rule skip
 * the judge for such a segment.
 *
 * ADR §5 residual, by cli.js parity: a SCRIPT RUNNER (`make`, `npm test`,
 * `bun file.ts`, `deno task`, `cargo run`, `pytest`, `tar --to-command`,
 * `rsync -e`, `tmux`, `go run`, `gh alias set --shell`) is not
 * launcher-shaped, although an allowed runner executes project files the agent
 * may have just written.
 *
 * Never throws (an internal failure answers `true`).
 */
export function isLauncherShapedSegment(tokens: readonly string[]): boolean {
  try {
    return launcherShapedUnsafe(tokens)
  } catch {
    return true
  }
}
