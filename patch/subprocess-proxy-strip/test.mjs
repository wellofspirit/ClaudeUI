#!/usr/bin/env node
/**
 * Behavioral test for the subprocess-proxy-strip patch.
 *
 * Verifies that proxy env vars are stripped from the env handed to cli.js
 * subprocesses (here: the Bash tool) by default, and preserved when the parent
 * opts in via CLAUDEUI_PROXY_SUBPROCESSES=1.
 *
 * Mechanism: set ALL_PROXY in the parent env, then have the model run a Bash
 * command that prints $ALL_PROXY. The Bash subprocess's env is built by the
 * patched env-builder, so the probe reveals whether the strip helper ran.
 *
 * Why ALL_PROXY (not HTTP_PROXY): cli.js's HTTP client (undici) honors
 * HTTP_PROXY/HTTPS_PROXY/NO_PROXY for its own API traffic but NOT ALL_PROXY, so
 * a sentinel ALL_PROXY exercises the strip list without breaking the API call.
 * ALL_PROXY is in the patch's strip set just like the others.
 *
 * Usage: node patch/subprocess-proxy-strip/test.mjs
 */

import { createQuery, collectMessages, TestRunner, dumpMessages } from '../test-helpers.mjs'

const SENTINEL = 'http://127.0.0.1:59999'

// printf in a real subprocess shell; ${ALL_PROXY:-MISSING} is shell expansion,
// kept literal in JS (single-quoted, so no template interpolation).
const PROBE_CMD = 'printf "PROXYPROBE=[%s]\\n" "${ALL_PROXY:-MISSING}"'
const PROMPT =
  `Run this exact bash command and nothing else:\n${PROBE_CMD}\n` +
  `Do NOT explain anything, just run the command.`

/** Pull probe values only from executed-output messages (never assistant text,
 *  which may echo the literal command with %s / ${...}). */
function extractProbes(messages) {
  const re = /PROXYPROBE=\[([^\]]*)\]/g
  const vals = []
  for (const m of messages) {
    if (m.type !== 'bash_output' && m.type !== 'user') continue
    const hay = JSON.stringify(m)
    let mm
    while ((mm = re.exec(hay)) !== null) {
      if (mm[1] !== '%s') vals.push(mm[1]) // skip the format-string echo, if any
    }
  }
  return vals
}

async function runPhase(label, optIn, timeoutMs = 90_000) {
  // Set the sentinel proxy var; toggle the opt-in gate per phase.
  process.env.ALL_PROXY = SENTINEL
  process.env.all_proxy = SENTINEL
  if (optIn) process.env.CLAUDEUI_PROXY_SUBPROCESSES = '1'
  else delete process.env.CLAUDEUI_PROXY_SUBPROCESSES

  console.log(`\n  [${label}] starting (optIn=${optIn})...`)
  const { q, cleanup } = createQuery(PROMPT, { effort: 'low' }, timeoutMs)
  const messages = await collectMessages(q, { cleanup })
  const probes = extractProbes(messages)
  const completed = messages.some((m) => m.type === 'result')
  console.log(`  [${label}] probes=${JSON.stringify(probes)} completed=${completed}`)
  return { messages, probes, completed }
}

async function main() {
  const t = new TestRunner('subprocess-proxy-strip')

  const savedAll = process.env.ALL_PROXY
  const savedAllLower = process.env.all_proxy
  const savedGate = process.env.CLAUDEUI_PROXY_SUBPROCESSES

  try {
    // --- Phase 1: default — proxy must be STRIPPED from the subprocess --------
    const def = await runPhase('default', false)
    dumpMessages(def.messages)
    t.assert('[default] session completed (API not broken by ALL_PROXY)', def.completed)
    t.assert('[default] subprocess produced a probe value', def.probes.length > 0)
    if (def.probes.length > 0) {
      t.assert(
        '[default] ALL_PROXY stripped from subprocess (probe = MISSING)',
        def.probes.every((v) => v === 'MISSING'),
      )
      t.assert(
        '[default] sentinel proxy value never leaked to subprocess',
        def.probes.every((v) => v !== SENTINEL),
      )
    }

    // --- Phase 2: opt-in — proxy must be PRESERVED in the subprocess ----------
    const opt = await runPhase('opt-in', true)
    dumpMessages(opt.messages)
    t.assert('[opt-in] session completed', opt.completed)
    t.assert('[opt-in] subprocess produced a probe value', opt.probes.length > 0)
    if (opt.probes.length > 0) {
      t.assert(
        '[opt-in] ALL_PROXY preserved in subprocess (probe = sentinel)',
        opt.probes.includes(SENTINEL),
      )
    }
  } finally {
    // Restore the parent env regardless of outcome.
    if (savedAll === undefined) delete process.env.ALL_PROXY
    else process.env.ALL_PROXY = savedAll
    if (savedAllLower === undefined) delete process.env.all_proxy
    else process.env.all_proxy = savedAllLower
    if (savedGate === undefined) delete process.env.CLAUDEUI_PROXY_SUBPROCESSES
    else process.env.CLAUDEUI_PROXY_SUBPROCESSES = savedGate
  }

  const ok = t.summarize()
  process.exit(ok ? 0 : 1)
}

main().catch((err) => {
  console.error('Unexpected error:', err)
  process.exit(1)
})
