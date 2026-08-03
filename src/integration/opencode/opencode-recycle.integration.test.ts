/**
 * OpencodeServerManager.recycleAll() integration smoke.
 *
 * recycleAll is the auth-mutation reload signal: opencode builds its provider
 * map once per process and never watches auth.json, so a credential change is
 * only visible to a server started AFTER the write. This proves, against the
 * REAL binary, that a recycle kills the pooled server, fans out the exit
 * signal sessions rely on, and that the next acquire spawns a fresh working
 * server — the process a new credential becomes visible in.
 *
 * Gated: only runs when OPENCODE_INTEGRATION_TESTS=1.
 * Uses the real opencode binary — NOT included in default test / test:ci.
 *
 * Run manually:
 *   OPENCODE_INTEGRATION_TESTS=1 vitest run --project integration
 */

// @vitest-environment node

import { describe, it, expect, afterAll } from 'vitest'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { OpencodeServerManager } from '../../main/opencode/OpencodeServerManager'

const SKIP = !process.env.OPENCODE_INTEGRATION_TESTS
const BINARY_NAME = process.platform === 'win32' ? 'opencode.exe' : 'opencode'
const ROOT = join(__dirname, '..', '..', '..')

function findBinary(): string | null {
  const candidates = [
    join(ROOT, 'vendor', 'opencode-cli', BINARY_NAME),
    join(ROOT, '.cache', 'opencode-probe', 'package', 'bin', BINARY_NAME)
  ]
  return candidates.find(existsSync) ?? null
}

async function alive(baseUrl: string, authHeader: string): Promise<boolean> {
  try {
    const res = await fetch(`${baseUrl}/config/providers`, {
      headers: { Authorization: authHeader }
    })
    return res.ok
  } catch {
    return false
  }
}

describe.skipIf(SKIP)('opencode recycleAll smoke', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'oc-recycle-'))
  let mgr: OpencodeServerManager

  afterAll(() => {
    mgr?.dispose()
    rmSync(cwd, { recursive: true, force: true })
  })

  it('kills the pooled server, fans out exit, and a fresh acquire works', async () => {
    const binary = findBinary()
    if (!binary) throw new Error('opencode binary not found — run `bun run ensure-opencode` first')

    mgr = new OpencodeServerManager({
      locateBinaryFn: () => binary,
      // Bogus MCP host on purpose — opencode treats an MCP connect failure as
      // a non-fatal warning, and this smoke is about process lifecycle only.
      startMcpHostFn: async () => ({ port: 1, token: 'smoke', close: async () => {} })
    })

    const first = await mgr.acquire(cwd)
    expect(await alive(first.baseUrl, first.authHeader)).toBe(true)

    let fanoutFired = false
    mgr.subscribeExit(cwd, () => {
      fanoutFired = true
    })

    mgr.recycleAll()
    expect(mgr.activeCount).toBe(0)
    expect(fanoutFired).toBe(true)

    // The tree-kill is async (SIGTERM) — poll the old server until it stops
    // answering rather than asserting instantly.
    let oldDead = false
    for (let i = 0; i < 50 && !oldDead; i++) {
      await new Promise((r) => setTimeout(r, 200))
      oldDead = !(await alive(first.baseUrl, first.authHeader))
    }
    expect(oldDead).toBe(true)

    // The respawn is the process a changed auth.json becomes visible in.
    // Spawn identity is the per-spawn random password, NOT baseUrl — the real
    // binary happily reuses the same port after a respawn (which is exactly
    // why releaseIfCurrent compares baseUrl+password, not the URL alone).
    const second = await mgr.acquire(cwd)
    expect(second.password).not.toBe(first.password)
    expect(await alive(second.baseUrl, second.authHeader)).toBe(true)
    mgr.release(cwd)
  }, 60_000)
})
