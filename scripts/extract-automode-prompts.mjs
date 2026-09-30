#!/usr/bin/env node
/**
 * Extract Claude Code's auto-mode classifier prompt (and render its rules) for reference.
 *
 * Reference for what comes out: docs/protocol-cc/14-auto-mode-classifier.md (§9.8).
 *
 * Two sources, because they no longer live in one place:
 *
 * - Stage-2 system prompt. Still a template literal in cli.js (`function …(){…;return\`You are a
 *   security monitor…\`}`), so the bundle-analyzer string indexer cannot see it. We locate it by a
 *   content landmark that survives minification, walk to the template's closing backtick, and
 *   decode it. `${…}` interpolations are resolved only when the expression is a string literal or
 *   an identifier bound to a plain string literal (`var X='…'`, `let X="…"`, `,X=\`…\``): first in
 *   the enclosing function's prelude, then chunk-wide (every declaration or reassignment in the
 *   chunk must be the same plain literal). Anything else is written as a visible `«${expr}»`
 *   placeholder and listed on stdout. Nothing from the bundle is ever evaluated: literals are
 *   parsed and their escapes decoded by hand. The runtime slots cli.js fills later
 *   (`<permissions_template>`, `<cross_session_messages_rule>`, …) are left in place.
 *
 * - Rules document (environment / hard_deny / soft_deny / allow). Not in cli.js as of 2.1.280: it
 *   ships as a zstd asset inside the binary (`permissions_external-*.txt.zst`). The supported
 *   source is the CLI's own dump, `claude auto-mode defaults`, which prints the four default lists
 *   as JSON; pass it with `--rules-json`. The JSON carries every rule verbatim but not the
 *   document scaffolding around the lists (the Definitions section, section intros, the
 *   `<settings_deny_rules>` slot). The rendered markdown ends with the category slugs derived from
 *   the BLOCK rule names, normalized the way cli.js normalizes a `<category>`.
 *
 * Usage:
 *   node scripts/extract-automode-prompts.mjs [cli.js] [outPrefix] [--rules-json <file|->]
 *
 *   vendor/claude-cli/bun-claude.exe auto-mode defaults > defaults.json
 *   node scripts/extract-automode-prompts.mjs vendor/claude-cli/cli.js out/automode \
 *     --rules-json defaults.json
 *
 * Defaults to vendor/claude-cli/cli.js and out/automode, writing <outPrefix>-prompt-stage2.md and,
 * with --rules-json, <outPrefix>-rules.md. `-` reads the JSON from stdin.
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { basename, dirname } from 'node:path'

const PROMPT_LANDMARK = 'You are a security monitor for autonomous AI coding agents.'
const PROMPT_EXPECT = ['## Classification Process', '<permissions_template>', '## Output Format']
const RULE_KEYS = ['environment', 'hard_deny', 'soft_deny', 'allow']
const CHUNK_MARKER = '// @bun-chunk '
/** How far back from the template the enclosing function's `let`/`var` prelude may start. */
const PRELUDE_MAX = 2000

function parseArgs(argv) {
  const positional = []
  let rulesJson
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--rules-json') {
      rulesJson = argv[++i]
      if (rulesJson === undefined) throw new Error('--rules-json needs a path (or - for stdin)')
    } else positional.push(argv[i])
  }
  return {
    cli: positional[0] ?? 'vendor/claude-cli/cli.js',
    out: positional[1] ?? 'out/automode',
    rulesJson
  }
}

// ---------------------------------------------------------------------------
// Literal scanning and decoding (no eval)
// ---------------------------------------------------------------------------

const SIMPLE_ESCAPES = { n: '\n', r: '\r', t: '\t', b: '\b', f: '\f', v: '\v' }

/**
 * Decode the escapes of a string/template literal body (the cooked value). Line continuations
 * vanish; unknown escapes yield the escaped character, as in JS.
 */
function decodeEscapes(body) {
  let out = ''
  for (let i = 0; i < body.length; i++) {
    const c = body[i]
    if (c !== '\\') {
      out += c
      continue
    }
    const d = body[++i]
    if (d in SIMPLE_ESCAPES) out += SIMPLE_ESCAPES[d]
    else if (d === '0' && !/[0-9]/.test(body[i + 1] ?? '')) out += '\0'
    else if (d === 'x') {
      out += String.fromCharCode(parseInt(hexAt(body, i + 1, 2), 16))
      i += 2
    } else if (d === 'u' && body[i + 1] === '{') {
      const end = body.indexOf('}', i)
      out += String.fromCodePoint(parseInt(hexAt(body, i + 2, end - i - 2), 16))
      i = end
    } else if (d === 'u') {
      out += String.fromCharCode(parseInt(hexAt(body, i + 1, 4), 16))
      i += 4
    } else if (d === '\r') {
      if (body[i + 1] === '\n') i++
    } else if (d === '\n' || d === '\u2028' || d === '\u2029') {
      // line continuation
    } else out += d
  }
  return out
}

function hexAt(s, at, len) {
  const h = s.slice(at, at + len)
  if (!/^[0-9a-fA-F]+$/.test(h)) throw new Error(`bad hex escape: \\${s.slice(at - 1, at + len)}`)
  return h
}

/** `src[i]` is a quote; returns the index just past the closing quote and the raw body. */
function scanQuoted(src, i) {
  const q = src[i]
  let j = i + 1
  while (j < src.length && src[j] !== q) {
    if (src[j] === '\\') j++
    else if (src[j] === '\n') throw new Error(`unterminated string literal at ${i}`)
    j++
  }
  if (j >= src.length) throw new Error(`unterminated string literal at ${i}`)
  return { end: j + 1, body: src.slice(i + 1, j) }
}

/**
 * `src[i]` is a backtick; returns the index just past the closing backtick and the template's
 * parts: `{ quasis: [rawText…], exprs: [sourceText…] }` with quasis.length === exprs.length + 1.
 */
function scanTemplate(src, i) {
  const quasis = []
  const exprs = []
  let j = i + 1
  let partStart = j
  while (j < src.length) {
    const c = src[j]
    if (c === '\\') {
      j += 2
      continue
    }
    if (c === '`') {
      quasis.push(src.slice(partStart, j))
      return { end: j + 1, quasis, exprs }
    }
    if (c === '$' && src[j + 1] === '{') {
      quasis.push(src.slice(partStart, j))
      const exprEnd = scanExpression(src, j + 2)
      exprs.push(src.slice(j + 2, exprEnd))
      j = exprEnd + 1
      partStart = j
      continue
    }
    j++
  }
  throw new Error(`unterminated template literal at ${i}`)
}

/** Scan an interpolation body starting at `i`; returns the index of its closing `}`. */
function scanExpression(src, i) {
  let depth = 0
  let j = i
  while (j < src.length) {
    const c = src[j]
    if (c === '"' || c === "'") j = scanQuoted(src, j).end
    else if (c === '`') j = scanTemplate(src, j).end
    else if (c === '{') {
      depth++
      j++
    } else if (c === '}') {
      if (depth === 0) return j
      depth--
      j++
    } else j++
  }
  throw new Error(`unterminated interpolation at ${i}`)
}

/**
 * If a complete literal (string, or template without interpolations) starts at `i` and is the
 * whole initializer — followed by `,` `;` `)` `}` or a newline — return its decoded value.
 * Anything else, including a malformed literal, yields undefined.
 */
function literalAt(src, i) {
  try {
    return plainLiteralAt(src, i)
  } catch {
    return undefined
  }
}

function plainLiteralAt(src, i) {
  let end
  let value
  if (src[i] === '"' || src[i] === "'") {
    const s = scanQuoted(src, i)
    end = s.end
    value = decodeEscapes(s.body)
  } else if (src[i] === '`') {
    const t = scanTemplate(src, i)
    if (t.exprs.length > 0) return undefined
    end = t.end
    value = decodeEscapes(t.quasis[0])
  } else return undefined
  return end >= src.length || /[,;)}\n]/.test(src[end]) ? value : undefined
}

// ---------------------------------------------------------------------------
// Interpolation resolution
// ---------------------------------------------------------------------------

const IDENT = /^[A-Za-z_$][\w$]*$/
const escapeRe = (s) => s.replace(/[$]/g, '\\$')

/**
 * Every declaration or assignment of `id` in `text` (`var|let|const X=`, or `X=` / `X+=` / `X??=`
 * after a statement or expression boundary), as absolute offsets of the right-hand side. A
 * compound assignment is returned as -1: it never counts as a plain literal binding.
 */
function bindingsOf(text, base, id) {
  const re = new RegExp(
    `(?:\\b(?:var|let|const)\\s+|[,;{}()\\n])${escapeRe(id)}(\\+|\\?\\?|\\|\\||&&)?=(?!=)`,
    'g'
  )
  const out = []
  for (let m; (m = re.exec(text));) out.push(m[1] ? -1 : base + m.index + m[0].length)
  return out
}

function chunkAround(src, at) {
  const start = src.lastIndexOf(CHUNK_MARKER, at)
  const next = src.indexOf(CHUNK_MARKER, at)
  return { start: Math.max(start, 0), end: next === -1 ? src.length : next }
}

/**
 * Resolve one interpolation. Returns `{ value, how }` or `{ value: undefined, why }`.
 * - a string literal expression: its value;
 * - an identifier bound in the enclosing function prelude: that binding, literal or not;
 * - otherwise an identifier whose chunk-wide bindings are all the same plain literal.
 */
function resolveInterpolation(src, open, expr) {
  const e = expr.trim()
  if (/^["'`]/.test(e)) {
    const v = literalAt(e, 0)
    return v !== undefined ? { value: v, how: 'literal' } : { why: 'not a plain literal' }
  }
  if (!IDENT.test(e)) return { why: 'not an identifier' }

  const fnStart = src.lastIndexOf('function ', open)
  if (fnStart !== -1 && open - fnStart <= PRELUDE_MAX) {
    const local = bindingsOf(src.slice(fnStart, open), fnStart, e)
    if (local.length > 0) {
      const at = local[local.length - 1]
      const v = at === -1 ? undefined : literalAt(src, at)
      return v !== undefined
        ? { value: v, how: 'local binding' }
        : { why: 'local binding is not a plain literal' }
    }
  }

  const { start, end } = chunkAround(src, open)
  const found = bindingsOf(src.slice(start, end), start, e)
  if (found.length === 0) return { why: 'no binding in chunk' }
  const values = new Set()
  for (const at of found) {
    const v = at === -1 ? undefined : literalAt(src, at)
    if (v === undefined) return { why: 'a chunk binding is not a plain literal' }
    values.add(v)
  }
  if (values.size > 1) return { why: 'chunk bindings disagree' }
  return { value: [...values][0], how: `chunk binding at ${found[0]}` }
}

// ---------------------------------------------------------------------------
// Targets
// ---------------------------------------------------------------------------

function extractPrompt(src) {
  const at = src.indexOf(PROMPT_LANDMARK)
  if (at === -1) throw new Error(`landmark not found: ${PROMPT_LANDMARK}`)
  const open = src.lastIndexOf('`', at)
  if (open === -1) throw new Error('no opening backtick before landmark')
  const { end, quasis, exprs } = scanTemplate(src, open)

  const report = []
  let text = decodeEscapes(quasis[0])
  exprs.forEach((expr, k) => {
    const r = resolveInterpolation(src, open, expr)
    const shown = expr.trim()
    if (r.value !== undefined) {
      report.push(`  resolved   \${${shown}} (${r.how}, ${r.value.length} chars)`)
      text += r.value
    } else {
      report.push(`  unresolved \${${shown}} (${r.why}) -> placeholder`)
      text += `«\${${shown}}»`
    }
    text += decodeEscapes(quasis[k + 1])
  })
  return { text: text.replace(/\r\n/g, '\n'), open, close: end, report }
}

function renderRules(json, sourceLabel) {
  for (const k of RULE_KEYS) {
    const v = json?.[k]
    if (!Array.isArray(v) || v.length === 0 || v.some((x) => typeof x !== 'string')) {
      throw new Error(`rules JSON: "${k}" must be a non-empty array of strings`)
    }
  }
  const norm = (s) => s.replace(/\r\n/g, '\n')
  const section = (title, list) =>
    `## ${title} (${list.length})\n\n${list.map((r) => `- ${norm(r)}`).join('\n\n')}\n`
  // Same normalization cli.js applies to a <category> before its allowlist check.
  const slug = (s) =>
    s
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '_')
      .replace(/^_+|_+$/g, '')
  // A rule's name is everything before its `[must name …]` slot or `:` (cf. cli.js `AVt`).
  const ruleName = (r) => r.split(/[:[]/, 1)[0].trim()
  const slugs = [...json.hard_deny, ...json.soft_deny].map((r) => slug(ruleName(r))).sort()
  return [
    `# Auto-mode default rules\n`,
    `Rendered from \`${sourceLabel}\` (output of \`claude auto-mode defaults\`). The four lists are`,
    `verbatim; the document around them (Definitions, section intros, slot markers) is not part of`,
    `that JSON. Section order follows the shipped rules document.\n`,
    section('Environment', json.environment),
    section('HARD BLOCK', json.hard_deny),
    section('SOFT BLOCK', json.soft_deny),
    section('ALLOW', json.allow),
    `## Category slugs derived from the BLOCK rule names (${slugs.length})\n`,
    '```',
    slugs.join('\n'),
    '```',
    ''
  ].join('\n')
}

// ---------------------------------------------------------------------------

let args
try {
  args = parseArgs(process.argv.slice(2))
} catch (e) {
  console.error(e.message)
  process.exit(2)
}
mkdirSync(dirname(args.out) || '.', { recursive: true })
let failed = 0

try {
  const src = readFileSync(args.cli, 'utf8')
  const { text, open, close, report } = extractPrompt(src)
  const missing = PROMPT_EXPECT.filter((m) => !text.includes(m))
  if (missing.length > 0) {
    throw new Error(`extracted text missing expected markers: ${missing.join(', ')}`)
  }
  const path = `${args.out}-prompt-stage2.md`
  writeFileSync(path, text, 'utf8')
  console.log(`prompt-stage2: chars ${open}-${close} -> ${path} (${text.length} chars)`)
  if (report.length > 0) console.log(report.join('\n'))
} catch (e) {
  console.error(`prompt-stage2: FAILED - ${e.message}`)
  console.error(
    `  The landmark probably changed - re-locate with:\n` +
      `  bundle-analyzer find ${args.cli} "security monitor" --compact`
  )
  failed++
}

if (args.rulesJson === undefined) {
  console.log(
    'rules: skipped - the rules document is not in cli.js (2.1.280 ships it as a zstd asset).\n' +
      '  Dump it with `<claude binary> auto-mode defaults > defaults.json` and pass --rules-json.'
  )
} else {
  try {
    const label = args.rulesJson === '-' ? 'stdin' : basename(args.rulesJson)
    const raw = readFileSync(args.rulesJson === '-' ? 0 : args.rulesJson, 'utf8')
    const json = JSON.parse(raw.replace(/^\uFEFF/, ''))
    const md = renderRules(json, label)
    const path = `${args.out}-rules.md`
    writeFileSync(path, md, 'utf8')
    const counts = RULE_KEYS.map((k) => `${k} ${json[k].length}`).join(', ')
    console.log(`rules: ${label} -> ${path} (${md.length} chars; ${counts})`)
  } catch (e) {
    console.error(`rules: FAILED - ${e.message}`)
    failed++
  }
}

if (failed > 0) process.exit(1)
