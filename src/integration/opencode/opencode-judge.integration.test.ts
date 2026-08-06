/**
 * Patched opencode judge-endpoint integration test (ADR-037 P1).
 *
 * Gated: only runs when OPENCODE_INTEGRATION_TESTS=1.
 * Uses the real vendored opencode binary — NOT in the default test / test:ci run.
 *
 * Run manually:
 *   OPENCODE_INTEGRATION_TESTS=1 vitest run --project integration
 *
 * What it pins down (all of it wire behaviour we cannot fake in a unit test):
 *  - the fork build actually carries POST /judge/completion,
 *  - it is behind the same server-password Basic auth as every other route,
 *  - it validates its payload and reports an unknown model as a JSON 404,
 *  - `probeJudgeEndpoint` agrees with the running binary,
 *  - the real transport's fallback path engages against a server that lacks
 *    the route (asserted via the unpatched-shaped 404/HTML contract).
 *
 * A model call is NOT exercised: that needs provider credentials and would
 * spend tokens. Everything up to the provider boundary is covered.
 */

// @vitest-environment node

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { spawn } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { ChildProcess } from 'node:child_process'
import {
  JUDGE_COMPLETION_PATH,
  makeJudgeTransportWithFallback,
  probeJudgeEndpoint
} from '../../main/opencode/judge-transport'

const SKIP = !process.env.OPENCODE_INTEGRATION_TESTS
const BINARY_NAME = process.platform === 'win32' ? 'opencode.exe' : 'opencode'
const ROOT = join(__dirname, '..', '..', '..')
const VENDOR_DIR = join(ROOT, 'vendor', 'opencode-cli')

function findBinary(): string | null {
  const candidate = join(VENDOR_DIR, BINARY_NAME)
  return existsSync(candidate) ? candidate : null
}

function vendorProvenance(): Record<string, unknown> | null {
  const file = join(VENDOR_DIR, 'version.json')
  if (!existsSync(file)) return null
  return JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>
}

describe.skipIf(SKIP)('opencode patched judge endpoint', () => {
  let proc: ChildProcess
  let baseUrl: string
  let authHeader: string

  beforeAll(async () => {
    const binary = findBinary()
    if (!binary) throw new Error('opencode binary not found — run `bun run ensure-opencode` first')

    const password = 'judge-integration-secret'
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

  it('the vendored binary was built from the fork branch', () => {
    const provenance = vendorProvenance()
    expect(provenance, 'vendor/opencode-cli/version.json must exist').not.toBeNull()
    expect(provenance!.source).toBe('fork')
    expect((provenance!.fork as Record<string, string>).branch).toBe('claudeui')
    expect((provenance!.fork as Record<string, string>).commit).toMatch(/^[0-9a-f]{40}$/)
  })

  it('POST /judge/completion is documented in /doc', async () => {
    const res = await fetch(`${baseUrl}/doc`, {
      headers: { Authorization: authHeader, Accept: 'application/json' }
    })
    expect(res.status).toBe(200)
    const doc = (await res.json()) as { paths: Record<string, Record<string, unknown>> }
    expect(Object.keys(doc.paths)).toContain(JUDGE_COMPLETION_PATH)
    expect(doc.paths[JUDGE_COMPLETION_PATH].post).toBeDefined()
  })

  it('probeJudgeEndpoint reports the route as available', async () => {
    await expect(probeJudgeEndpoint({ baseUrl, authHeader })).resolves.toBe(true)
  })

  it('rejects an unauthenticated call with 401', async () => {
    const res = await fetch(`${baseUrl}${JUDGE_COMPLETION_PATH}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: { providerID: 'anthropic', modelID: 'x' },
        system: 's',
        user: 'u'
      })
    })
    expect(res.status).toBe(401)
  })

  it('rejects a malformed payload with 400 (not 500)', async () => {
    const res = await fetch(`${baseUrl}${JUDGE_COMPLETION_PATH}`, {
      method: 'POST',
      headers: { Authorization: authHeader, 'Content-Type': 'application/json' },
      body: JSON.stringify({ system: 'no model field' })
    })
    expect(res.status).toBe(400)
    expect(res.headers.get('content-type')).toContain('application/json')
  })

  it('reports an unknown model as a JSON 404 ModelNotFoundError', async () => {
    const res = await fetch(`${baseUrl}${JUDGE_COMPLETION_PATH}`, {
      method: 'POST',
      headers: { Authorization: authHeader, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: { providerID: 'not-a-real-provider', modelID: 'not-a-real-model' },
        system: 's',
        user: 'u',
        maxTokens: 64,
        stopSequences: ['</block>']
      })
    })
    expect(res.status).toBe(404)
    expect(res.headers.get('content-type')).toContain('application/json')
    const body = (await res.json()) as { _tag?: string }
    expect(body._tag).toBe('ModelNotFoundError')
  })

  it('a model error propagates through the transport instead of silently falling back', async () => {
    const fallback = async () => 'FROM-SESSION'
    const probe = {}
    const transport = makeJudgeTransportWithFallback({
      target: { baseUrl, authHeader },
      model: { providerID: 'not-a-real-provider', modelID: 'not-a-real-model' },
      fallback,
      probe
    })
    // The endpoint exists, so a bad model must fail closed — NOT be mistaken
    // for version skew and rerouted through the session judge.
    await expect(transport({ system: 's', user: 'u' })).rejects.toThrow(/404/)
    expect((probe as { available?: boolean }).available).toBe(true)
  })

  it('an unknown sibling route still answers from the UI catch-all (fallback contract)', async () => {
    // This is WHY the transport probes /doc rather than POSTing speculatively:
    // an unpatched server answers unknown paths with HTML (or proxies them).
    const res = await fetch(`${baseUrl}/judge/definitely-not-a-route`, {
      method: 'POST',
      headers: { Authorization: authHeader, 'Content-Type': 'application/json' },
      body: '{}'
    })
    expect(res.headers.get('content-type') ?? '').not.toContain('application/json')
  })
})
