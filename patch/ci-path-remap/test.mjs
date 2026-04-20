#!/usr/bin/env node
/**
 * Patch test: ci-path-remap
 *
 * Two layers of verification:
 *
 *   1. Standalone shim probe (no API key required)
 *      Loads only the shim region from the head of cli.js, installs the
 *      monkey-patch, and asserts that every known CI-baked URL resolves
 *      to the expected path. Also checks a non-CI URL passes through.
 *      Verifies the ripgrep composition lands on the real binary.
 *
 *   2. End-to-end Grep session
 *      Spawns a real cli.js session and exercises the Grep tool, asserting
 *      no ENOENT / home/runner signatures appear in the message stream.
 */

import { readFileSync, writeFileSync, unlinkSync, existsSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'

import { createQuery, collectMessages, TestRunner, dumpMessages, CLI_JS_PATH } from '../test-helpers.mjs'

const __dirname = dirname(fileURLToPath(import.meta.url))
const CLI_DIR = dirname(CLI_JS_PATH)
const CI_ROOT = 'file:///home/runner/work/claude-cli-internal/claude-cli-internal/'
const archPlat = `${process.arch}-${process.platform}`
const SENTINEL = 'ci-path-remap-test-sentinel-93'

// ---------------------------------------------------------------------------
// Layer 1: standalone shim probe
// ---------------------------------------------------------------------------

function runProbe(t) {
  const src = readFileSync(CLI_JS_PATH, 'utf-8')
  const endMarker = '// ─── end CI path remap ─────────────────────────────────────────────────────'
  const endIdx = src.indexOf(endMarker)
  if (endIdx < 0) {
    t.assert('shim region marker present', false)
    return
  }
  t.assert('shim region marker present', true)

  const shimOnly = src.slice(0, endIdx + endMarker.length)

  // Probe: call fileURLToPath on each CI URL and assert the mapping.
  // We run it in a subprocess that loads the shim from a temp file co-located
  // with cli.js (so __dirname matches CLI_DIR inside the IIFE).
  const tmpPath = resolve(CLI_DIR, '_ci-path-remap-probe.js')
  const probe = `
const u = require('url')
const p = require('path')
const fs = require('fs')

const expected = [
  ['${CI_ROOT}src/utils/ripgrep.ts',                                 __dirname + '/ripgrep.ts'],
  ['${CI_ROOT}src/utils/claudeInChrome/setup.ts',                    __dirname + '/claudeInChrome-setup.ts'],
  ['${CI_ROOT}src/utils/computerUse/setup.ts',                       __dirname + '/computerUse-setup.ts'],
  ['${CI_ROOT}vendor/modifiers-napi-src/index.ts',                   __dirname + '/vendor/modifiers-napi-src/index.ts'],
  ['${CI_ROOT}node_modules/open/index.js',                           __dirname + '/node_modules/open/index.js'],
  ['${CI_ROOT}node_modules/@anthropic-ai/sandbox-runtime/dist/sandbox/generate-seccomp-filter.js',
    __dirname + '/node_modules/@anthropic-ai/sandbox-runtime/dist/sandbox/generate-seccomp-filter.js'],
  ['file:///tmp/something.js', '/tmp/something.js'],
]

const results = []
for (const [input, expect] of expected) {
  const got = u.fileURLToPath(input)
  results.push({ input, expect, got, ok: got === expect })
}

// Verify the ripgrep composition — the whole point of the override.
const ripgrepURL = '${CI_ROOT}src/utils/ripgrep.ts'
const P_1 = u.fileURLToPath(ripgrepURL)
const X_1 = p.join(P_1, '../')
const cmd = p.resolve(p.resolve(X_1, 'vendor', 'ripgrep'), '${archPlat}', 'rg')
const rgExists = fs.existsSync(cmd)

process.stdout.write(JSON.stringify({ results, ripgrep: { cmd, exists: rgExists } }))
`
  writeFileSync(tmpPath, shimOnly + '\n' + probe)
  let out
  try {
    out = execFileSync('node', [tmpPath], { stdio: ['ignore', 'pipe', 'inherit'], encoding: 'utf8' })
  } catch (err) {
    t.assert('probe subprocess ran', false)
    return
  } finally {
    try { unlinkSync(tmpPath) } catch {}
  }

  let parsed
  try { parsed = JSON.parse(out) } catch (err) {
    t.assert('probe produced valid JSON output', false)
    return
  }

  for (const r of parsed.results) {
    const label = `remap ${r.input.startsWith(CI_ROOT) ? '[CI]' : '[passthrough]'} ${r.input.slice(0, 80)}`
    t.assert(label, r.ok)
    if (!r.ok) {
      console.log(`    expected: ${r.expect}`)
      console.log(`    got:      ${r.got}`)
    }
  }

  t.assert(
    `ripgrep composition resolves to extant binary (${parsed.ripgrep.cmd})`,
    parsed.ripgrep.exists,
  )
}

// ---------------------------------------------------------------------------
// Layer 2: end-to-end Grep session
// ---------------------------------------------------------------------------

function contentToString(content) {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content
      .map((b) => {
        if (typeof b === 'string') return b
        return b?.text ?? b?.content ?? (typeof b === 'object' ? JSON.stringify(b) : '')
      })
      .join(' ')
  }
  return ''
}

function findRipgrepFailure(messages) {
  const patterns = [
    /home\/runner\/work\/claude-cli-internal/i,
    /spawn .* ENOENT/i,
    /RipgrepTimeoutError/i,
  ]
  for (const m of messages) {
    const bag = [m.message?.content, m.event?.delta?.text, m.result, m.error]
    for (const part of bag) {
      const s = contentToString(part)
      if (!s) continue
      for (const pat of patterns) {
        if (pat.test(s)) return s.match(pat)[0]
      }
    }
  }
  return null
}

async function runEndToEnd(t) {
  const PROMPT =
    `Use the Grep tool RIGHT NOW to search for the literal string ` +
    `"${SENTINEL}" in the directory "patch/ci-path-remap". You MUST call Grep.`

  const { q, cleanup } = createQuery(PROMPT, { maxTurns: 3 }, 120_000)
  const msgs = await collectMessages(q, { cleanup })
  dumpMessages(msgs)

  t.assertSome(
    'Grep tool was invoked',
    msgs,
    (m) =>
      m.type === 'assistant' &&
      Array.isArray(m.message?.content) &&
      m.message.content.some((b) => b.type === 'tool_use' && b.name === 'Grep'),
  )

  const failure = findRipgrepFailure(msgs)
  t.assert(
    `no ripgrep failure signatures (found: ${failure ?? 'none'})`,
    failure === null,
  )

  const sawSentinel = msgs.some(
    (m) => m.type === 'user' && contentToString(m.message?.content).includes(SENTINEL),
  )
  t.assert('tool_result contains sentinel (ripgrep actually ran)', sawSentinel)

  t.assertSome('session produced a result message', msgs, (m) => m.type === 'result')
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const t = new TestRunner('ci-path-remap')

  // Marker present
  const cliSrc = readFileSync(CLI_JS_PATH, 'utf-8')
  t.assert(
    'patch marker /*PATCHED:ci-path-remap*/ present',
    cliSrc.includes('/*PATCHED:ci-path-remap*/'),
  )
  t.assert(
    'injected IIFE body present',
    cliSrc.includes('url.fileURLToPath = function fileURLToPathShim'),
  )

  console.log('\n  --- Layer 1: standalone shim probe ---')
  runProbe(t)

  console.log('\n  --- Layer 2: end-to-end Grep session ---')
  await runEndToEnd(t)

  const ok = t.summarize()
  process.exit(ok ? 0 : 1)
}

main().catch((err) => {
  console.error('Unexpected error:', err)
  process.exit(1)
})
