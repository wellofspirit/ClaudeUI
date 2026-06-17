#!/usr/bin/env node
/**
 * One-shot migration helper: rewrites every patch/apply.mjs to point at
 * vendor/claude-cli/cli.js instead of node_modules/@anthropic-ai/claude-agent-sdk/cli.js.
 *
 * Also strips references to the "@anthropic-ai/claude-agent-sdk installed?" error
 * hints and replaces them with vendor-aware messages.
 *
 * Safe to run multiple times (idempotent on substring match).
 */
import { readdirSync, readFileSync, writeFileSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const PATCH_DIR = resolve(__dirname, '..', 'patch')

const replacements = [
  {
    from: `'node_modules/@anthropic-ai/claude-agent-sdk/cli.js'`,
    to: `'vendor/claude-cli/cli.js'`
  },
  {
    from: `"node_modules/@anthropic-ai/claude-agent-sdk/cli.js"`,
    to: `"vendor/claude-cli/cli.js"`
  },
  {
    from: `'Is @anthropic-ai/claude-agent-sdk installed?'`,
    to: `'Did you run: node scripts/extract-cli.mjs ?'`
  }
]

let files = 0
let changes = 0
for (const entry of readdirSync(PATCH_DIR)) {
  const applyPath = join(PATCH_DIR, entry, 'apply.mjs')
  try {
    if (!statSync(applyPath).isFile()) continue
  } catch {
    continue
  }
  let text = readFileSync(applyPath, 'utf8')
  const before = text
  for (const { from, to } of replacements) {
    text = text.split(from).join(to)
  }
  if (text !== before) {
    writeFileSync(applyPath, text)
    const delta = text.length - before.length
    console.log(`updated ${entry}/apply.mjs (${delta >= 0 ? '+' : ''}${delta} bytes)`)
    files++
    changes += (before.match(/claude-agent-sdk\/cli\.js/g) || []).length
  }
}
console.log(`\n${files} file(s) updated, ${changes} cli.js path references rewritten.`)
