/**
 * Language detection for a shell command and for what it printed.
 *
 * Two problems, one module, because they share the extension→language map and
 * the same posture: **structure or nothing**. Every function here either matches
 * a shape it can name with confidence or declines, because colour that implies
 * structure the text does not have is worse than no colour at all.
 *
 * 1. `splitHeredocs` — a command is bash, except where it is not. `python - <<'PY'`
 *    carries a Python program inside a bash line, and highlighting that body as
 *    shell is noise. The command is split into segments, each with its own
 *    language.
 * 2. `detectOutputFormat` — a tool's stdout is not a language, but it very often
 *    has a shape: `grep`/`rg` gutters, a unified diff, JSON, or the contents of
 *    one file a plain `cat`/`head`/`sed -n` printed.
 *
 * Nothing here renders; the bodies decide what to do with the answer.
 */

import { getLang } from './lang'

// ---------------------------------------------------------------------------
// 1. The command
// ---------------------------------------------------------------------------

/** One run of a command that shares a language. */
export interface CommandSegment {
  text: string
  /** A Prism language id; `bash` for the shell parts. */
  lang: string
}

/**
 * Interpreters whose heredoc body is a program, keyed by the word that invokes
 * them. Deliberately small and explicit: an unknown interpreter leaves the body
 * as bash rather than guessing, and `cat`/`tee` heredocs are DATA, so they are
 * absent here and stay plain.
 */
const INTERPRETER_LANG: Record<string, string> = {
  python: 'python',
  python3: 'python',
  py: 'python',
  node: 'javascript',
  bun: 'javascript',
  deno: 'javascript',
  ruby: 'ruby',
  perl: 'perl',
  psql: 'sql',
  sqlite3: 'sql',
  mysql: 'sql',
  jq: 'json'
}

/**
 * The heredoc opener: `<<TAG`, `<<-TAG`, `<<'TAG'`, `<<"TAG"`. The tag is what
 * closes the body — on its own line, optionally indented for the `<<-` form.
 */
const HEREDOC_OPEN = /<<-?\s*(['"]?)([A-Za-z_][A-Za-z0-9_]*)\1/

/**
 * The language a heredoc body should be highlighted as, from the words that
 * precede its opener on the same line.
 *
 * The interpreter is the last command word before the redirect, so a pipeline
 * (`cat x | python - <<'PY'`) resolves to `python`, not `cat`. A tag that names
 * a language on its own (`<<'SQL'`, `<<PY`) is honoured when the interpreter is
 * unknown, because that is the convention people actually write.
 */
function heredocLang(prefix: string, tag: string): string | null {
  const words = prefix.split(/[\s|;&(]+/).filter(Boolean)
  for (let i = words.length - 1; i >= 0; i--) {
    const word = words[i].split(/[\\/]/).pop() ?? ''
    const named = INTERPRETER_LANG[word.toLowerCase()]
    if (named) return named
    // Stop at the first real command word: anything before it fed this one.
    if (/^[a-z][\w.-]*$/i.test(word) && !word.startsWith('-')) break
  }
  const byTag = getLang(`x.${tag.toLowerCase()}`)
  return byTag === 'plaintext' ? null : byTag
}

/**
 * Split a command into segments so each is highlighted in its own language.
 *
 * A command with no heredoc — the overwhelming majority — comes back as a single
 * bash segment, so the caller has one code path. The closing tag line belongs to
 * the shell, not the body, so it is returned as bash: it is shell syntax.
 */
export function splitHeredocs(command: string): CommandSegment[] {
  const open = HEREDOC_OPEN.exec(command)
  if (!open) return [{ text: command, lang: 'bash' }]

  const tag = open[2]
  const openerEnd = command.indexOf('\n', open.index)
  // An opener with no following newline has no body yet (still streaming).
  if (openerEnd === -1) return [{ text: command, lang: 'bash' }]

  const lang = heredocLang(command.slice(0, open.index), tag)
  if (!lang) return [{ text: command, lang: 'bash' }]

  const rest = command.slice(openerEnd + 1)
  const closer = new RegExp(`^[ \\t]*${tag}[ \\t]*$`, 'm').exec(rest)
  const bodyEnd = closer ? closer.index : rest.length

  const segments: CommandSegment[] = [
    { text: command.slice(0, openerEnd + 1), lang: 'bash' },
    { text: rest.slice(0, bodyEnd), lang }
  ]
  if (closer) segments.push({ text: rest.slice(bodyEnd), lang: 'bash' })
  return segments.filter((s) => s.text.length > 0)
}

/** The short label for the chip that names what was detected, e.g. `sh + py`. */
export function commandLangLabel(segments: CommandSegment[]): string | null {
  const embedded = segments.find((s) => s.lang !== 'bash')
  if (!embedded) return null
  const short: Record<string, string> = {
    python: 'py',
    javascript: 'js',
    ruby: 'rb',
    perl: 'pl',
    sql: 'sql',
    json: 'json'
  }
  return `sh + ${short[embedded.lang] ?? embedded.lang}`
}

// ---------------------------------------------------------------------------
// 2. The output
// ---------------------------------------------------------------------------

/** Text above this size is never scanned or highlighted — a 5 MB log is not
 *  worth a frame, and the detectors only need the head to decide anyway. */
export const OUTPUT_HIGHLIGHT_MAX_CHARS = 100_000

/** How many leading lines a detector is allowed to look at. */
const SAMPLE_LINES = 40

/** A detector must explain at least this share of the sampled non-empty lines,
 *  otherwise it declines rather than colouring a fraction of the output. */
const MIN_MATCH_RATIO = 0.6

/** An ANSI SGR sequence — output that already carries its own colour. */
// eslint-disable-next-line no-control-regex
const ANSI = /\u001b\[[0-9;]*m/

export type OutputFormat =
  | { kind: 'plain' }
  /** `path:line:content` / `path-line-content`, or a bare `NNN:`/`NNN-` gutter. */
  | { kind: 'grep'; lang: string }
  | { kind: 'diff' }
  | { kind: 'json' }
  /** The whole output is one file's contents (a plain `cat`/`head`/`sed -n`). */
  | { kind: 'file'; lang: string }

/** `path:12:text` and `path:12-text` — a match line and a context line that name
 *  their file. The colon after the path is unambiguous, so the path may be
 *  anything without whitespace. */
const GREP_PATH_COLON = /^([^\s:]+?):(\d+)([:-])/
/** `path-12-text` — grep's context form with `-` as BOTH separators. A dash is
 *  also an ordinary filename character, so the path must look like one (it has
 *  to contain a `.` or a `/`); otherwise a dated log line like `2026-09-18 …`
 *  would read as a gutter. */
const GREP_PATH_DASH = /^([^\s:]*[./][^\s:]*?)-(\d+)-/
/** A single-file search prints only the gutter: `12:text` or `12-text`. */
const GREP_BARE = /^\s*(\d+)([:-])/

/** The `path` and gutter width of a grep line that names its file, in either
 *  separator form, or null when the line has neither shape. */
function grepPathMatch(line: string): { path: string; end: number } | null {
  const colon = GREP_PATH_COLON.exec(line)
  if (colon) return { path: colon[1], end: colon[0].length }
  const dash = GREP_PATH_DASH.exec(line)
  if (dash) return { path: dash[1], end: dash[0].length }
  return null
}

/**
 * The single path a plain read command printed, or null when the command is
 * anything more than that.
 *
 * Deliberately narrow: one command, no pipe, no redirect, no `&&`, one path
 * argument. `sed -n '1,60p' file.ts` qualifies; `grep x f | sed -n 1,5p` does
 * not, because its output is grep's, not the file's.
 */
export function singleFileRead(command: string): string | null {
  if (/[|&;><]/.test(command)) return null
  const words = command.trim().split(/\s+/)
  const verb = words[0]?.split(/[\\/]/).pop()
  if (!verb || !['cat', 'head', 'tail', 'bat', 'sed'].includes(verb)) return null
  // Flags and their values are skipped; what remains must be exactly one path.
  const paths = words.slice(1).filter((w) => !w.startsWith('-') && !/^'?\d+[,;]/.test(w))
  if (verb === 'sed') {
    // `sed -n '1,60p' file` — the script argument is quoted and is not a path.
    const script = paths.findIndex((w) => /^['"]?\d*[,;]?\d*[a-z]['"]?$/i.test(w))
    if (script !== -1) paths.splice(script, 1)
  }
  if (paths.length !== 1) return null
  const lang = getLang(paths[0])
  return lang === 'plaintext' ? null : paths[0]
}

/**
 * What shape this output has, if any.
 *
 * `command` is optional context: it is consulted only for the single-file-read
 * case, where the command is the only evidence of what the text is.
 */
export function detectOutputFormat(text: string, command?: string): OutputFormat {
  if (!text || text.length > OUTPUT_HIGHLIGHT_MAX_CHARS) return { kind: 'plain' }
  // Output that coloured itself is never re-coloured.
  if (ANSI.test(text)) return { kind: 'plain' }

  const sample = text.split('\n', SAMPLE_LINES).filter((l) => l.trim().length > 0)
  if (sample.length === 0) return { kind: 'plain' }

  // A diff announces itself in its header lines rather than by line share.
  if (sample.some((l) => l.startsWith('diff --git ')) || sample.some((l) => /^@@ .* @@/.test(l))) {
    return { kind: 'diff' }
  }

  const trimmed = text.trim()
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    try {
      JSON.parse(trimmed)
      return { kind: 'json' }
    } catch {
      // Not JSON after all — fall through to the line-shape detectors.
    }
  }

  const withPath = sample.filter((l) => grepPathMatch(l) !== null)
  if (withPath.length >= sample.length * MIN_MATCH_RATIO) {
    // Every row names its file; the language is the first one that has a known
    // extension, since a search can cross file types.
    for (const line of withPath) {
      const lang = getLang(grepPathMatch(line)?.path ?? '')
      if (lang !== 'plaintext') return { kind: 'grep', lang }
    }
    return { kind: 'grep', lang: 'plaintext' }
  }

  const bare = sample.filter((l) => GREP_BARE.test(l))
  if (bare.length >= sample.length * MIN_MATCH_RATIO) {
    // No path in the output, so the command is the only clue to the language.
    const path = command ? searchedPath(command) : null
    return { kind: 'grep', lang: path ? getLang(path) : 'plaintext' }
  }

  const readPath = command ? singleFileRead(command) : null
  if (readPath) return { kind: 'file', lang: getLang(readPath) }

  return { kind: 'plain' }
}

/**
 * The file a single-file search ran against, for the bare-gutter case: the last
 * argument that looks like a path with a known extension.
 */
function searchedPath(command: string): string | null {
  const words = command.trim().split(/\s+/)
  for (let i = words.length - 1; i >= 0; i--) {
    const word = words[i].replace(/^['"]|['"]$/g, '')
    if (word.startsWith('-')) continue
    if (getLang(word) !== 'plaintext') return word
  }
  return null
}

/**
 * Split a grep-shaped line into its gutter and its content, so the gutter can be
 * rendered muted and the content highlighted as code. Returns null for a line
 * that does not have the shape (a `--` separator, a summary tail).
 */
export function splitGrepLine(line: string): { gutter: string; content: string } | null {
  const withPath = grepPathMatch(line)
  if (withPath) {
    return { gutter: line.slice(0, withPath.end), content: line.slice(withPath.end) }
  }
  const bare = GREP_BARE.exec(line)
  if (bare) {
    const end = bare[0].length
    return { gutter: line.slice(0, end), content: line.slice(end) }
  }
  return null
}
