#!/usr/bin/env node
/**
 * probe-opencode-caps.mjs
 *
 * Empirically re-verifies the opencode config→runtime capability contract that
 * ClaudeUI's config writer (src/main/opencode/opencode-config.ts) depends on.
 * Run this on every opencode version bump instead of re-reading opencode source.
 *
 * It declares a synthetic custom provider `capprobe` (pointed at an unreachable
 * baseURL — no network call is ever made) with five models exercising the
 * different ways a model can advertise capabilities, then reads them back from
 * GET /config/providers and asserts how opencode resolved each one:
 *
 *   bare              → attachment=false ∧ input.image=false   (defaults)
 *   attachment-true   → attachment=true                        (top-level attachment honored)
 *   modalities-image  → input.image=true                       (modalities.input honored)
 *   caps-v2           → attachment=false ∧ input.image=false   (a `capabilities` key is IGNORED —
 *                                                               it's the internal ConfigV2 shape, not
 *                                                               the user-facing config schema. If this
 *                                                               ever flips, opencode changed its config
 *                                                               schema and opencode-config.ts must be revisited.)
 *   both              → attachment=true ∧ input.image=true      (both channels honored together)
 *
 * Usage:
 *   node scripts/probe-opencode-caps.mjs
 *   node scripts/probe-opencode-caps.mjs --binary /path/to/opencode
 *
 * Exit 0 if every assertion passes, 1 otherwise.
 */

import { spawn } from 'node:child_process'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = join(__dirname, '..')

// ── Binary resolution ──────────────────────────────────────────────────────
function resolveBinary() {
  const idx = process.argv.indexOf('--binary')
  if (idx !== -1 && process.argv[idx + 1]) return process.argv[idx + 1]
  const name = process.platform === 'win32' ? 'opencode.exe' : 'opencode'
  return join(ROOT, 'vendor', 'opencode-cli', name)
}

const BINARY = resolveBinary()
const PASSWORD = 'cap-probe-secret'
const AUTH = 'Basic ' + Buffer.from('opencode:' + PASSWORD).toString('base64')

// ── Probe config: a custom provider with capability-declaring models ─────────
const PROBE_CONFIG = {
  provider: {
    // Deliberately NO `npm` key: ClaudeUI's config writer never emits one, and a
    // baseURL-only custom provider must materialize without it (verified on
    // 1.17.9 and 1.17.14). If capprobe stops appearing in /config/providers,
    // opencode started requiring an explicit npm package for custom providers —
    // that's a contract break for every ClaudeUI-written provider block.
    capprobe: {
      name: 'Capability Probe',
      options: { baseURL: 'http://127.0.0.1:9/v1', apiKey: 'dummy' },
      models: {
        bare: {},
        'attachment-true': { attachment: true },
        'modalities-image': { modalities: { input: ['text', 'image'], output: ['text'] } },
        'caps-v2': { capabilities: { tools: true, input: ['text', 'image'], output: ['text'] } },
        both: { attachment: true, modalities: { input: ['text', 'image'], output: ['text'] } }
      }
    }
  }
}

// ── Spawn server, wait for listening line ────────────────────────────────────
function startServer() {
  return new Promise((resolve, reject) => {
    const child = spawn(BINARY, ['serve', '--port', '0', '--hostname', '127.0.0.1'], {
      env: {
        ...process.env,
        OPENCODE_SERVER_PASSWORD: PASSWORD,
        OPENCODE_CONFIG_CONTENT: JSON.stringify(PROBE_CONFIG)
      },
      stdio: ['ignore', 'pipe', 'pipe']
    })

    let stdout = ''
    let stderr = ''
    let settled = false

    const timeout = setTimeout(() => {
      if (!settled) {
        settled = true
        reject(new Error(`server start timeout\nstdout:\n${stdout}\nstderr:\n${stderr}`))
      }
    }, 30_000)

    child.stdout.on('data', (c) => {
      stdout += c.toString()
      const m = /opencode server listening on http:\/\/127\.0\.0\.1:(\d+)/.exec(stdout)
      if (m && !settled) {
        settled = true
        clearTimeout(timeout)
        resolve({ child, baseUrl: `http://127.0.0.1:${m[1]}` })
      }
    })
    child.stderr.on('data', (c) => {
      stderr += c.toString()
    })
    child.on('error', (e) => {
      if (!settled) {
        settled = true
        clearTimeout(timeout)
        reject(e)
      }
    })
    child.on('exit', (code) => {
      if (!settled) {
        settled = true
        clearTimeout(timeout)
        reject(new Error(`server exited early (code ${code})\nstderr:\n${stderr}`))
      }
    })
  })
}

// ── Assertions ────────────────────────────────────────────────────────────────
function buildChecks(models) {
  const m = (id) => {
    const found = models.find((x) => x.id === id)
    if (!found) throw new Error(`model "${id}" not present in capprobe provider`)
    return found
  }
  const att = (id) => m(id).capabilities?.attachment === true
  const img = (id) => m(id).capabilities?.input?.image === true

  return [
    { name: 'bare → attachment=false', pass: att('bare') === false },
    { name: 'bare → input.image=false', pass: img('bare') === false },
    { name: 'attachment-true → attachment=true', pass: att('attachment-true') === true },
    { name: 'modalities-image → input.image=true', pass: img('modalities-image') === true },
    {
      name: 'caps-v2 → attachment=false (capabilities key ignored)',
      pass: att('caps-v2') === false
    },
    {
      name: 'caps-v2 → input.image=false (capabilities key ignored)',
      pass: img('caps-v2') === false
    },
    { name: 'both → attachment=true', pass: att('both') === true },
    { name: 'both → input.image=true', pass: img('both') === true }
  ]
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function main() {
  console.log(`[probe] binary: ${BINARY}`)
  let child
  try {
    const started = await startServer()
    child = started.child
    const { baseUrl } = started

    const res = await fetch(`${baseUrl}/config/providers`, {
      headers: { Authorization: AUTH, Accept: 'application/json' }
    })
    if (res.status !== 200) throw new Error(`GET /config/providers → HTTP ${res.status}`)
    const body = await res.json()
    const providers = body.providers ?? []
    const capprobe = providers.find((p) => p.id === 'capprobe')
    if (!capprobe) {
      throw new Error(
        `provider "capprobe" not found. Providers present: ${providers.map((p) => p.id).join(', ')}`
      )
    }

    const models = Object.entries(capprobe.models ?? {}).map(([id, v]) => ({ id, ...v }))
    const checks = buildChecks(models)

    let allPass = true
    const w = Math.max(...checks.map((c) => c.name.length))
    console.log('')
    for (const c of checks) {
      if (!c.pass) allPass = false
      console.log(`  ${c.pass ? 'PASS' : 'FAIL'}  ${c.name.padEnd(w)}`)
    }
    console.log('')
    console.log(allPass ? '[probe] ALL ASSERTIONS PASSED' : '[probe] ASSERTIONS FAILED')
    return allPass ? 0 : 1
  } finally {
    if (child) {
      child.kill('SIGKILL')
    }
  }
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    console.error(`\n[probe] ERROR: ${err.message}`)
    process.exit(1)
  })
