/**
 * pi cross-engine dispatch TARGET integration smoke test (ADR-033 M4c).
 *
 * This is the proof that a REAL dispatch INTO pi round-trips end-to-end: the
 * REAL `CrossEngineDispatcher` class (not the module singleton, so the test
 * controls its deps precisely) is constructed with its REAL default
 * `spawnPiTarget` (i.e. NOT injected — `defaultSpawnPiTarget`'s actual
 * PiRpcClient + PiBridgeHost construction runs), dispatching `engine: 'pi'`
 * against the real vendored binary and a real model call. Unit-level coverage
 * for guards/model-resolution/gate/streaming/cost-cap/stop already lives in
 * cross-engine-dispatcher.component.test.ts (a FAKE spawnPiTarget) — this file
 * exists solely to prove the REAL wiring (bridge host transport, `--no-session`
 * spawn args, `get_state`/`set_model`/`prompt`/`get_last_assistant_text`/
 * `abort` RPC calls) actually works against the real binary, mirroring
 * pi-hosted-tools.integration.test.ts's identical "unit tests mock the seam,
 * this file proves the seam is real" rationale.
 *
 * The opencode-direction deps (serverManager/makeClient) are stubbed (never
 * touched dispatching engine:'pi') and `recordDispatchedUsage` is a no-op
 * (avoids depending on Electron's `app` for a userData path in this
 * non-Electron vitest context — the default `insertDispatchedUsage` would
 * only ever no-op-and-log there anyway, per `safeRecordUsage`'s contract, but
 * a no-op keeps this test's failure surface to exactly what it's testing).
 *
 * Gated: PI_INTEGRATION_TESTS=1 AND a real openai-codex credential in
 * ~/.pi/agent/auth.json (read-only — never written here). Same
 * shared-refresh-token caveat as pi-hosted-tools.integration.test.ts. Session
 * files land nowhere (`--no-session` — verified during the M4c kickoff
 * investigation: get_state/set_model/prompt/get_last_assistant_text/abort all
 * work normally under it, and no `~/.pi/agent/sessions` entry is created).
 * cwd is an isolated tmpdir, never the real project tree or homedir.
 *
 * Minimal by design (per the M4c kickoff spec): one dispatch, one short
 * prompt, generously timed. The bidirectional real-app drive (an actual
 * Claude/opencode SESSION dispatching into pi through the renderer) is the
 * orchestrator's job post-review, not this file's.
 *
 * Run manually:
 *   PI_INTEGRATION_TESTS=1 bunx vitest run --project integration -t pi
 */

// @vitest-environment node

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { existsSync, mkdtempSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir, homedir } from 'node:os'
import { join } from 'node:path'
import { CrossEngineDispatcher } from '../../main/services/cross-engine-dispatcher'
import type { DispatchContext } from '../../main/services/cross-engine-dispatcher'

const SKIP = !process.env.PI_INTEGRATION_TESTS
const BINARY_NAME = process.platform === 'win32' ? 'pi.exe' : 'pi'
const ROOT = join(__dirname, '..', '..', '..')
const ROUTING_ID = 'routing-pi-dispatch-target-integration'

function findBinary(): string | null {
  const candidate = join(ROOT, 'vendor', 'pi-cli', BINARY_NAME)
  return existsSync(candidate) ? candidate : null
}

/** Read-only check for a real openai-codex credential — never writes to auth.json. */
function hasCodexCredentials(): boolean {
  try {
    const raw = readFileSync(join(homedir(), '.pi', 'agent', 'auth.json'), 'utf-8')
    const parsed = JSON.parse(raw) as Record<string, unknown>
    return Boolean(parsed['openai-codex'])
  } catch {
    return false
  }
}

// Evaluated once at collection time so describe.skipIf can gate on it even
// when PI_INTEGRATION_TESTS=1 is set — "skip gracefully", not a hard failure.
const BINARY_MISSING = !findBinary()
const CREDENTIALS_MISSING = !hasCodexCredentials()

describe.skipIf(SKIP || BINARY_MISSING || CREDENTIALS_MISSING)('pi dispatch TARGET integration (ADR-033 M4c)', () => {
  let dispatcher: CrossEngineDispatcher
  let tmpDir: string

  beforeAll(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'pi-dispatch-target-integration-'))
    dispatcher = new CrossEngineDispatcher({
      // opencode-direction deps are structurally required by DispatcherDeps
      // but never invoked dispatching engine:'pi' — throwing stubs make that
      // guarantee loud if it's ever violated by a future change.
      serverManager: {
        acquire: async () => {
          throw new Error('serverManager.acquire should never be called dispatching engine: "pi"')
        },
        release: () => {
          throw new Error('serverManager.release should never be called dispatching engine: "pi"')
        }
      },
      makeClient: () => {
        throw new Error('makeClient should never be called dispatching engine: "pi"')
      },
      loadEngineConfig: () => ({ dispatch: { defaultModel: 'openai-codex/gpt-5.6-luna' } }),
      dispatchTimeoutMs: 60_000,
      recordDispatchedUsage: () => {}
      // spawnPiTarget intentionally OMITTED — exercises the REAL
      // defaultSpawnPiTarget (real PiRpcClient + PiBridgeHost).
    })
  })

  afterAll(async () => {
    dispatcher.disposeFor(ROUTING_ID)
    // Windows holds the cwd handle briefly after the child process exits —
    // wait, with a bounded fallback, before touching the tmp dir (mirrors
    // pi-hosted-tools.integration.test.ts's identical precedent).
    await new Promise((resolve) => setTimeout(resolve, 1_000))
    if (tmpDir) rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
  })

  it('a real dispatch into pi spawns the real binary and returns a real one-word answer', async () => {
    const ctx: DispatchContext = {
      fromEngine: 'claude',
      fromRoutingId: ROUTING_ID,
      cwd: tmpDir,
      autonomyMode: 'default',
      emit: () => {}
    }

    const result = await dispatcher.dispatch(
      { engine: 'pi', prompt: "Reply with exactly one word: 'hello'. No other text, no punctuation." },
      ctx
    )

    expect(result.isError, `dispatch failed: ${result.text}`).toBeFalsy()
    expect(result.text.trim().toLowerCase()).toContain('hello')
    expect(result.sessionId).toBeTruthy()
  }, 90_000)
})
