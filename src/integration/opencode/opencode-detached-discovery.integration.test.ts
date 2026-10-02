/**
 * OpencodeServerManager.acquireDetached() integration smoke.
 *
 * Model discovery asks a server of its OWN (`acquireDetached`) rather than the
 * pooled one, so a cold discovery runs a second `opencode serve` in the same
 * cwd as a pooled server someone holds — two processes on one opencode
 * database. This proves, against the REAL binary, that both come up, answer
 * concurrently while the pooled one writes (a session created mid-read), and
 * that releasing the detached server leaves the pooled one and its data alone.
 *
 * Isolated: opencode's data, cache, config and state (its database, auth and
 * sessions) live in a temp XDG tree for this run, so the user's are never read
 * or written; the bundled models snapshot answers (no models.dev fetch). The
 * pooled server is this test's own manager's — no live session is touched.
 *
 * Gated: only runs when OPENCODE_INTEGRATION_TESTS=1.
 * Uses the real opencode binary — NOT included in default test / test:ci.
 *
 * Run manually:
 *   OPENCODE_INTEGRATION_TESTS=1 vitest run --project integration \
 *     src/integration/opencode/opencode-detached-discovery.integration.test.ts
 */

// @vitest-environment node

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { OpencodeServerManager } from '../../core/opencode/OpencodeServerManager'
import { resolveHarness } from '../../core/harness/resolve'

const SKIP = !process.env.OPENCODE_INTEGRATION_TESTS

/** The binary the app itself would spawn (the harness resolver, ADR-082). */
function findBinary(): string | null {
  return resolveHarness('opencode').path
}

// Evaluated once at collection time: a checkout without opencode installed
// (`bun run ensure-opencode`, or a System selection) skips rather than fails.
const BINARY_MISSING = !findBinary()

const ISOLATED = ['XDG_DATA_HOME', 'XDG_CACHE_HOME', 'XDG_CONFIG_HOME', 'XDG_STATE_HOME'] as const

async function get(
  baseUrl: string,
  authHeader: string,
  route: string
): Promise<{ ok: boolean; body: unknown }> {
  try {
    const res = await fetch(`${baseUrl}${route}`, { headers: { Authorization: authHeader } })
    return { ok: res.ok, body: res.ok ? await res.json() : await res.text() }
  } catch (err) {
    return { ok: false, body: String(err) }
  }
}

describe.skipIf(SKIP || BINARY_MISSING)(
  'opencode detached discovery beside a pooled server',
  () => {
    const root = mkdtempSync(join(tmpdir(), 'oc-detached-'))
    const cwd = join(root, 'cwd')
    const saved: Record<string, string | undefined> = {}
    let mgr: OpencodeServerManager

    beforeAll(() => {
      // Spawns inherit process.env: point every opencode path at the temp tree.
      for (const name of [...ISOLATED, 'OPENCODE_DISABLE_MODELS_FETCH'])
        saved[name] = process.env[name]
      for (const name of ISOLATED) process.env[name] = join(root, name.toLowerCase())
      process.env.OPENCODE_DISABLE_MODELS_FETCH = '1'
      mkdirSync(cwd, { recursive: true })
    })

    afterAll(async () => {
      mgr?.dispose()
      for (const [name, value] of Object.entries(saved)) {
        if (value === undefined) delete process.env[name]
        else process.env[name] = value
      }
      // dispose() tree-kills asynchronously; on Windows a dying server still
      // holds the tree for a moment, so a first rmSync can EPERM. Retry briefly.
      for (let i = 0; i < 25; i++) {
        try {
          rmSync(root, { recursive: true, force: true })
          break
        } catch {
          await new Promise((r) => setTimeout(r, 200))
        }
      }
    })

    it('both answer on one database, and releasing the detached one leaves the pooled one whole', async () => {
      const binary = findBinary()
      if (!binary)
        throw new Error('opencode binary not found — run `bun run ensure-opencode` first')

      mgr = new OpencodeServerManager({
        locateBinaryFn: () => binary,
        // Bogus MCP host on purpose — opencode treats an MCP connect failure as
        // a non-fatal warning, and this smoke is about process lifecycle only.
        startMcpHostFn: async () => ({ port: 1, token: 'smoke', close: async () => {} })
      })

      // Started together, as a discovery racing a session's attach would be.
      const [pooled, detached] = await Promise.all([mgr.acquire(cwd), mgr.acquireDetached(cwd)])
      expect(detached.baseUrl).not.toBe(pooled.baseUrl)
      expect(mgr.activeCount).toBe(1)

      // The one database both opened is the isolated one.
      const dataDir = join(root, 'xdg_data_home', 'opencode')
      expect(existsSync(dataDir)).toBe(true)
      expect(readdirSync(dataDir).some((name) => name.startsWith('opencode.db'))).toBe(true)

      // Discovery's three reads on the detached server, while the pooled server
      // writes a session and reads the same catalog.
      const [created, ...reads] = await Promise.all([
        fetch(`${pooled.baseUrl}/session`, {
          method: 'POST',
          headers: { Authorization: pooled.authHeader, 'Content-Type': 'application/json' },
          body: JSON.stringify({ title: 'detached-smoke' })
        }).then(async (res) => ({ ok: res.ok, body: (await res.json()) as { id?: string } })),
        get(detached.baseUrl, detached.authHeader, '/provider'),
        get(detached.baseUrl, detached.authHeader, '/config/providers'),
        get(detached.baseUrl, detached.authHeader, '/provider/auth'),
        get(pooled.baseUrl, pooled.authHeader, '/config/providers')
      ])
      expect(created.ok, JSON.stringify(created.body)).toBe(true)
      expect(created.body.id).toBeTruthy()
      for (const read of reads) expect(read.ok, JSON.stringify(read.body)).toBe(true)
      const all = (reads[0].body as { all?: unknown[] }).all ?? []
      expect(all.length).toBeGreaterThan(0)

      // The detached server reads what the pooled one wrote: one database.
      const seen = await get(detached.baseUrl, detached.authHeader, '/session')
      expect(seen.ok).toBe(true)
      expect(JSON.stringify(seen.body)).toContain(created.body.id!)

      detached.release()
      // Give the kill a moment, then the detached server is gone…
      let gone = false
      for (let i = 0; i < 25 && !gone; i++) {
        gone = !(await get(detached.baseUrl, detached.authHeader, '/config/providers')).ok
        if (!gone) await new Promise((r) => setTimeout(r, 200))
      }
      expect(gone).toBe(true)

      // …and the pooled server, its refcount and its session are untouched.
      expect(mgr.activeCount).toBe(1)
      const after = await get(pooled.baseUrl, pooled.authHeader, '/session')
      expect(after.ok).toBe(true)
      expect(JSON.stringify(after.body)).toContain(created.body.id!)
      expect((await get(pooled.baseUrl, pooled.authHeader, '/config/providers')).ok).toBe(true)
    }, 120_000)
  }
)
