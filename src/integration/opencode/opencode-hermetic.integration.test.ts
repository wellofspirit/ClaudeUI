/**
 * Hermetic-session wire contract (ADR-037 P2).
 *
 * Gated: only runs when OPENCODE_INTEGRATION_TESTS=1.
 * Uses the real vendored opencode binary — NOT in the default test / test:ci run.
 *
 * Run manually:
 *   OPENCODE_INTEGRATION_TESTS=1 vitest run --project integration
 *
 * ## The bug this guards (auto-mode rework plan §7 Q5)
 *
 * opencode keeps "always" approvals in INSTANCE-GLOBAL state, not keyed by
 * sessionID, and `evaluate()` appends that list AFTER the session's own ruleset
 * with last-match-wins. So the deny-all ClaudeUI patches onto every throwaway
 * session (auto-mode judge, `/btw`, agent-generate) is outranked by any pattern
 * the user ever always-approved anywhere on the server — a prompt-injected
 * judge could then execute it. `permissionHermetic` seals such a session.
 *
 * ## What is tested WHERE, and why
 *
 * The piercing itself can only be reproduced by driving a real
 * `Permission.ask`, and no HTTP route raises one without a model turn
 * (`/session/{id}/shell` runs "by the user" and skips the permission layer
 * entirely). So the end-to-end reproduction — a normal session IS pierced by a
 * global always-approval, a sealed session is not — lives in the fork's own
 * suite, against the same source this binary is built from:
 *
 *   packages/opencode/test/permission/hermetic.test.ts   (6 tests)
 *
 * What is tested HERE is the part that suite cannot see: that the binary we
 * actually vendored carries the patch, and that the flag ClaudeUI puts on the
 * wire is accepted the way ClaudeUI assumes. The realistic failure this
 * catches is not "the logic is wrong" but "we shipped a stale or unpatched
 * binary and every throwaway session went back to being pierceable, silently".
 */

// @vitest-environment node

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { spawn } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { ChildProcess } from 'node:child_process'

const SKIP = !process.env.OPENCODE_INTEGRATION_TESTS
const BINARY_NAME = process.platform === 'win32' ? 'opencode.exe' : 'opencode'
const ROOT = join(__dirname, '..', '..', '..')
const VENDOR_DIR = join(ROOT, 'vendor', 'opencode-cli')

const DENY_ALL = [{ permission: '*', pattern: '*', action: 'deny' }]

describe.skipIf(SKIP)('opencode hermetic sessions (ADR-037 P2)', () => {
  let proc: ChildProcess
  let baseUrl: string
  let authHeader: string

  async function api(
    method: string,
    path: string,
    body?: unknown
  ): Promise<{ status: number; json: unknown }> {
    const res = await fetch(`${baseUrl}${path}`, {
      method,
      headers: {
        Authorization: authHeader,
        'Content-Type': 'application/json',
        Accept: 'application/json'
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) })
    })
    const text = await res.text()
    let json: unknown
    try {
      json = JSON.parse(text)
    } catch {
      json = undefined
    }
    return { status: res.status, json }
  }

  async function newSession(title: string): Promise<string> {
    const { status, json } = await api('POST', '/session', { title })
    expect(status).toBe(200)
    return (json as { id: string }).id
  }

  beforeAll(async () => {
    const binary = join(VENDOR_DIR, BINARY_NAME)
    if (!existsSync(binary)) throw new Error('opencode binary not found — run `bun run ensure-opencode` first')

    const password = 'hermetic-integration-secret'
    authHeader = 'Basic ' + Buffer.from('opencode:' + password).toString('base64')

    await new Promise<void>((resolve, reject) => {
      proc = spawn(binary, ['serve', '--port', '0', '--hostname', '127.0.0.1'], {
        cwd: ROOT,
        env: { ...process.env, OPENCODE_SERVER_PASSWORD: password },
        stdio: ['ignore', 'pipe', 'pipe']
      })
      let stdout = ''
      const timeout = setTimeout(() => reject(new Error('server start timeout')), 30_000)
      proc.stdout?.on('data', (chunk: Buffer) => {
        stdout += chunk.toString()
        const m = /opencode server listening on http:\/\/127\.0\.0\.1:(\d+)/.exec(stdout)
        if (m) {
          clearTimeout(timeout)
          baseUrl = `http://127.0.0.1:${m[1]}`
          resolve()
        }
      })
      proc.on('error', (e) => {
        clearTimeout(timeout)
        reject(e)
      })
    })
  }, 40_000)

  afterAll(() => {
    proc?.kill('SIGTERM')
  })

  it('the vendored binary is a fork build (not an upstream release)', () => {
    const provenance = JSON.parse(readFileSync(join(VENDOR_DIR, 'version.json'), 'utf8')) as {
      source?: string
      fork?: { branch?: string; commit?: string }
    }
    expect(provenance.source).toBe('fork')
    expect(provenance.fork?.branch).toBe('claudeui')
    expect(provenance.fork?.commit).toMatch(/^[0-9a-f]{40}$/)
  })

  it('permissionHermetic is a DECLARED field of the PATCH payload, not a silently-dropped extra', async () => {
    // This is the assertion that actually catches a stale/unpatched vendored
    // binary. The stock server 200s on unknown keys (see the test below), so
    // "the PATCH succeeded" proves nothing on its own — only the published
    // schema distinguishes a sealed session from a hopeful one.
    const { status, json } = await api('GET', '/doc')
    expect(status).toBe(200)
    const spec = json as {
      paths: Record<string, Record<string, { requestBody?: { content?: Record<string, { schema?: unknown }> } }>>
      components?: { schemas?: Record<string, { properties?: Record<string, unknown> }> }
    }
    const patchOp = spec.paths['/session/{sessionID}']?.patch
    expect(patchOp, 'PATCH /session/{sessionID} must exist').toBeDefined()
    const schema = patchOp!.requestBody?.content?.['application/json']?.schema as
      | { $ref?: string; properties?: Record<string, unknown> }
      | undefined
    const resolved = schema?.$ref
      ? spec.components?.schemas?.[schema.$ref.replace('#/components/schemas/', '')]
      : schema
    expect(Object.keys(resolved?.properties ?? {})).toContain('permissionHermetic')
  })

  it('accepts the deny-all ruleset and the seal in ONE atomic patch', async () => {
    // ClaudeUI sends both in a single call on purpose: a session that is
    // deny-all but not yet sealed is still pierceable, so the two must never be
    // split across two round-trips.
    const id = await newSession('deny-all-sealed')
    const { status, json } = await api('PATCH', `/session/${id}`, {
      permission: DENY_ALL,
      permissionHermetic: true
    })
    expect(status).toBe(200)
    expect((json as { permission?: unknown[] }).permission).toEqual(DENY_ALL)
  })

  it('sealing changes nothing else about the session record', async () => {
    // Sealing is a permission-layer concern. If it ever started mutating the
    // session (a persisted column, a metadata key), an unpatched downgrade
    // would see a foreign field — this pins that it does not.
    const sealed = await newSession('sealed')
    const plain = await newSession('plain')
    const a = await api('PATCH', `/session/${sealed}`, { permission: DENY_ALL, permissionHermetic: true })
    const b = await api('PATCH', `/session/${plain}`, { permission: DENY_ALL })
    expect(a.status).toBe(200)
    expect(b.status).toBe(200)
    expect(Object.keys(a.json as object).sort()).toEqual(Object.keys(b.json as object).sort())
  })

  it('sealing is idempotent and reversible', async () => {
    const id = await newSession('seal-toggle')
    for (const permissionHermetic of [true, true, false, true]) {
      const { status } = await api('PATCH', `/session/${id}`, { permissionHermetic })
      expect(status).toBe(200)
    }
  })

  it('the payload schema ignores unknown keys — which is why the flag needs no fork detection', async () => {
    // ClaudeUI sends permissionHermetic unconditionally, with no capability
    // probe. That is only safe because the stock Effect Schema payload strips
    // excess properties rather than rejecting them, so an UNPATCHED opencode
    // drops the field instead of 400-ing the whole patch. Measured here on a
    // live server so the assumption cannot rot silently.
    const id = await newSession('unknown-keys')
    const { status, json } = await api('PATCH', `/session/${id}`, {
      permission: DENY_ALL,
      thisFieldDoesNotExistAnywhere: 'and never will'
    })
    expect(status).toBe(200)
    expect((json as { permission?: unknown[] }).permission).toEqual(DENY_ALL)
  })

  it('the field is optional — a client that omits it behaves exactly as before', async () => {
    const id = await newSession('no-flag')
    const { status, json } = await api('PATCH', `/session/${id}`, { permission: DENY_ALL })
    expect(status).toBe(200)
    expect((json as { permission?: unknown[] }).permission).toEqual(DENY_ALL)
  })
})
