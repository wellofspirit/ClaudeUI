#!/usr/bin/env node
/**
 * Behavioral test for the subprocess-proxy-strip patch.
 *
 * Verifies that proxy env vars are stripped from the env handed to cli.js
 * subprocesses (here: the Bash tool) by default, and preserved when the parent
 * opts in via CLAUDEUI_PROXY_SUBPROCESSES=1.
 *
 * Mechanism: set NO_PROXY to a non-matching sentinel in the parent env, then
 * have the model run a Bash command that prints $NO_PROXY. The Bash subprocess's env is built by the
 * patched env-builder, so the probe reveals whether the strip helper ran.
 *
 * A non-matching NO_PROXY hostname exercises the strip list without routing
 * the model's API traffic through an unreachable test proxy. Upstream now
 * honors ALL_PROXY for API traffic, so the old sentinel blocked inference.
 *
 * Usage: node patch/subprocess-proxy-strip/test.mjs
 */

import { createQuery, collectMessages, TestRunner, dumpMessages } from '../test-helpers.mjs'

const SENTINEL = 'claudeui-proxy-probe.invalid'

// printf in a real subprocess shell; ${NO_PROXY:-MISSING} is shell expansion,
// kept literal in JS (single-quoted, so no template interpolation).
const PROBE_CMD = 'printf "PROXYPROBE=[%s]\\n" "${NO_PROXY:-MISSING}"'
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
  process.env.NO_PROXY = SENTINEL
  process.env.no_proxy = SENTINEL
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

  const savedAll = process.env.NO_PROXY
  const savedAllLower = process.env.no_proxy
  const savedGate = process.env.CLAUDEUI_PROXY_SUBPROCESSES

  try {
    // --- Phase 1: default — proxy must be STRIPPED from the subprocess --------
    const def = await runPhase('default', false)
    dumpMessages(def.messages)
    t.assert('[default] session completed (API not broken by NO_PROXY)', def.completed)
    t.assert('[default] subprocess produced a probe value', def.probes.length > 0)
    if (def.probes.length > 0) {
      t.assert(
        '[default] NO_PROXY stripped from subprocess (probe = MISSING)',
        def.probes.every((v) => v === 'MISSING')
      )
      t.assert(
        '[default] sentinel value never leaked to subprocess',
        def.probes.every((v) => v !== SENTINEL)
      )
    }

    // --- Phase 2: opt-in — proxy must be PRESERVED in the subprocess ----------
    const opt = await runPhase('opt-in', true)
    dumpMessages(opt.messages)
    t.assert('[opt-in] session completed', opt.completed)
    t.assert('[opt-in] subprocess produced a probe value', opt.probes.length > 0)
    if (opt.probes.length > 0) {
      t.assert(
        '[opt-in] NO_PROXY preserved in subprocess (probe = sentinel)',
        opt.probes.includes(SENTINEL)
      )
    }
  } finally {
    // Restore the parent env regardless of outcome.
    if (savedAll === undefined) delete process.env.NO_PROXY
    else process.env.NO_PROXY = savedAll
    if (savedAllLower === undefined) delete process.env.no_proxy
    else process.env.no_proxy = savedAllLower
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
