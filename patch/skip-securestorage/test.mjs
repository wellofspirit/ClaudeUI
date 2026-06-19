#!/usr/bin/env node
/**
 * Test: skip-securestorage
 *
 * Structural test (deterministic, offline). The credential store backend choice
 * produces NO message-stream signal, and a live session can't distinguish the
 * patch on a clean machine: with an empty Keychain, both the keychain-primary
 * facade (fallback) and the file-only path read the SAME `.credentials.json`.
 * The only real regression risk is the content-regex anchor breaking on a cli.js
 * version bump — so we assert the patched getter directly and tie the
 * SKIP_SECURESTORAGE branch to the `name:"plaintext"` backend definition.
 */
import { readFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { resolve } from 'node:path'
import { TestRunner, PROJECT_ROOT } from '../test-helpers.mjs'

// The patch modifies the cli.js SOURCE (the bun-claude binary embeds its
// patched form). Structural checks run against the source.
const CLI_JS_SRC = resolve(PROJECT_ROOT, 'vendor', 'claude-cli', 'cli.js')
const V = '[\\w$]+'

function main() {
  const t = new TestRunner('skip-securestorage')

  let src
  try {
    src = readFileSync(CLI_JS_SRC, 'utf-8')
  } catch {
    t.assert(`cli.js readable at ${CLI_JS_SRC} (run: bun run ensure-cli)`, false)
    process.exit(t.summarize() ? 0 : 1)
  }

  // 1. Marker present exactly once (applied + idempotent).
  const markerCount = src.split('/*PATCHED:skip-securestorage*/').length - 1
  t.assert('patch marker present exactly once', markerCount === 1)

  // 2. The patched getter short-circuits to the file backend when the env var
  //    is set, then falls through to the original body (which still references
  //    the COMPOSER(primary,file) facade). Shape:
  //    function P(){<marker>if(process.env.SKIP_SECURESTORAGE)return FILE;<body…COMPOSER(PRIMARY,FILE2)…>}
  //    The body is brace-free, so [^{}] keeps the match scoped to this getter.
  const getterRe = new RegExp(
    `function ${V}\\(\\)\\{/\\*PATCHED:skip-securestorage\\*/if\\(process\\.env\\.SKIP_SECURESTORAGE\\)return (${V});[^{}]*?(${V})\\((${V}),(${V})\\)[^{}]*?\\}`
  )
  const m = src.match(getterRe)
  t.assert('patched store getter matches expected shape', !!m)

  if (m) {
    const [, fileBranch, composer, primaryArg, fileArg] = m

    // 3. The SKIP branch returns the SECOND composer arg (the fallback/file),
    //    never the primary secure store. Guards against inverting the branches.
    t.assert(
      `SKIP branch returns the fallback backend (${fileBranch} === composer arg2 ${fileArg})`,
      fileBranch === fileArg
    )
    t.assert(
      `SKIP branch is NOT the primary secure-store backend ${primaryArg}`,
      fileBranch !== primaryArg
    )

    // 4. Tie the returned identifier to the plaintext backend definition, and
    //    the bypassed one to a real secure-store backend (keychain on macOS,
    //    windows-credman on Windows). Definitive correctness.
    t.assert(
      `returned backend "${fileBranch}" is the plaintext file backend`,
      src.includes(`${fileBranch}={name:"plaintext"`)
    )
    const primaryRe = new RegExp(
      `${primaryArg.replace(/[$]/g, '\\$&')}=\\{name:"(keychain|windows-credman)"`
    )
    t.assert(
      `bypassed backend "${primaryArg}" is a secure-store backend (keychain/windows-credman)`,
      primaryRe.test(src)
    )

    // 5. The composer is the secure-store-with-plaintext-fallback facade.
    const composerRe = new RegExp(
      `function ${composer.replace(/[$]/g, '\\$&')}\\(${V},${V}\\)\\{let ${V}=\\{name:\`\\$\\{${V}\\.name\\}-with-`
    )
    t.assert(`composer "${composer}" is the fallback-facade builder`, composerRe.test(src))
  }

  // 6. Patched cli.js still parses.
  try {
    execFileSync('node', ['--check', CLI_JS_SRC], { stdio: 'pipe' })
    t.assert('node --check passes on patched cli.js', true)
  } catch (err) {
    t.assert(`node --check failed: ${err?.message ?? err}`, false)
  }

  process.exit(t.summarize() ? 0 : 1)
}

main()
