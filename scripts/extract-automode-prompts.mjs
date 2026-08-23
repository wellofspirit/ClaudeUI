#!/usr/bin/env node
/**
 * Extract Claude Code's auto-mode classifier prompt + rules document from cli.js.
 *
 * Both live as template literals in the bundle, so the string indexer in
 * bundle-analyzer cannot see them. We locate each by a content landmark that
 * survives minification, walk to the enclosing template literal's boundaries,
 * and evaluate it.
 *
 * Reference for what comes out: docs/protocol-cc/14-auto-mode-classifier.md
 *
 * Usage:
 *   node scripts/extract-automode-prompts.mjs [cli.js] [outPrefix]
 *
 * Defaults to vendor/claude-cli/cli.js and out/automode, writing
 * <outPrefix>-rules.md and <outPrefix>-prompt-stage2.md.
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'

const CLI = process.argv[2] ?? 'vendor/claude-cli/cli.js'
const OUT = process.argv[3] ?? 'out/automode'

/**
 * Landmarks are interior text, so the opening backtick precedes them. Anything
 * matched here must be stable across cli.js releases — prefer prose the prompt
 * would not be rewritten without also changing meaning.
 */
const TARGETS = [
  {
    name: 'rules',
    // Section header of the injected <permissions_template> document.
    landmark: '## Environment\\r',
    expect: ['<user_hard_deny_rules_to_replace>', '<user_soft_deny_rules_to_replace>'],
  },
  {
    name: 'prompt-stage2',
    landmark: 'You are a security monitor for autonomous AI coding agents.',
    expect: ['## Classification Process', '<permissions_template>'],
  },
]

/** Walk from the opening backtick to its unescaped, non-nested closing backtick. */
function templateAround(src, landmark) {
  const at = src.indexOf(landmark)
  if (at === -1) throw new Error(`landmark not found: ${landmark}`)
  const open = src.lastIndexOf('`', at)
  if (open === -1) throw new Error('no opening backtick before landmark')

  // Escaped `\${...}` is literal text, not interpolation — the `\\` skip below
  // handles it, so only spans recorded here are real bundle references.
  const interpolations = []
  let i = open + 1
  let depth = 0
  let spanStart = -1
  while (i < src.length) {
    const c = src[i]
    if (c === '\\') { i += 2; continue }
    if (c === '$' && src[i + 1] === '{') {
      if (depth === 0) spanStart = i
      depth++
      i += 2
      continue
    }
    if (c === '}' && depth > 0) {
      depth--
      if (depth === 0) interpolations.push(src.slice(spanStart, i + 1))
      i++
      continue
    }
    if (c === '`' && depth === 0) {
      return { raw: src.slice(open, i + 1), open, close: i + 1, interpolations }
    }
    i++
  }
  throw new Error('unterminated template literal')
}

/**
 * Evaluate the literal to resolve escapes. Real `${...}` placeholders in these
 * two templates are empty-string markers for runtime injection; anything else
 * would reference bundle scope, so reject it rather than execute bundle code.
 */
function evalTemplate(raw, interpolations) {
  const unsafe = interpolations.filter((s) => !/^\$\{\s*(""|''|``)?\s*\}$/.test(s))
  if (unsafe.length > 0) {
    throw new Error(`refusing to eval non-literal interpolation: ${unsafe[0]}`)
  }
  return Function(`"use strict";return (${raw});`)()
}

mkdirSync(dirname(OUT) || '.', { recursive: true })
const src = readFileSync(CLI, 'utf8')
let failed = 0

for (const t of TARGETS) {
  try {
    const { raw, open, close, interpolations } = templateAround(src, t.landmark)
    const text = evalTemplate(raw, interpolations).replace(/\r\n/g, '\n')
    const missing = t.expect.filter((m) => !text.includes(m))
    if (missing.length > 0) {
      throw new Error(`extracted text missing expected markers: ${missing.join(', ')}`)
    }
    const path = `${OUT}-${t.name}.md`
    writeFileSync(path, text, 'utf8')
    console.log(`${t.name}: chars ${open}-${close} -> ${path} (${text.length} chars)`)
  } catch (e) {
    console.error(`${t.name}: FAILED - ${e.message}`)
    failed++
  }
}

if (failed > 0) {
  console.error(
    `\n${failed} target(s) failed. The landmark probably changed - re-locate with:\n` +
      `  bundle-analyzer find ${CLI} "security monitor" --compact`,
  )
  process.exit(1)
}
