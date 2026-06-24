/**
 * Opencode server integration smoke test.
 *
 * Gated: only runs when OPENCODE_INTEGRATION_TESTS=1.
 * Uses the real opencode binary — NOT included in default test / test:ci.
 *
 * Run manually:
 *   OPENCODE_INTEGRATION_TESTS=1 vitest run --project integration
 */

// @vitest-environment node

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import type { ChildProcess } from 'node:child_process'
import snapshot from '../../main/opencode/protocol/doc-snapshot.1.17.9.json'

const SKIP = !process.env.OPENCODE_INTEGRATION_TESTS
const BINARY_NAME = process.platform === 'win32' ? 'opencode.exe' : 'opencode'
const ROOT = join(__dirname, '..', '..', '..')

function findBinary(): string | null {
  const candidates = [
    join(ROOT, 'vendor', 'opencode-cli', BINARY_NAME),
    join(ROOT, '.cache', 'opencode-probe', 'package', 'bin', BINARY_NAME),
  ]
  return candidates.find(existsSync) ?? null
}

describe.skipIf(SKIP)('opencode server smoke', () => {
  let proc: ChildProcess
  let baseUrl: string
  let authHeader: string

  beforeAll(async () => {
    const binary = findBinary()
    if (!binary) throw new Error('opencode binary not found — run `bun run ensure-opencode` first')

    const password = 'smoke-test-secret'
    authHeader = 'Basic ' + Buffer.from('opencode:' + password).toString('base64')

    await new Promise<void>((resolve, reject) => {
      proc = spawn(binary, ['serve', '--port', '0', '--hostname', '127.0.0.1'], {
        cwd: ROOT,
        env: { ...process.env, OPENCODE_SERVER_PASSWORD: password },
        stdio: ['ignore', 'pipe', 'pipe'],
      })

      let stdout = ''
      const timeout = setTimeout(() => reject(new Error('server start timeout')), 15_000)

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
  }, 20_000)

  afterAll(() => {
    proc?.kill('SIGTERM')
  })

  it('GET /doc returns openapi 3.1 with expected version', async () => {
    const res = await fetch(`${baseUrl}/doc`, {
      headers: { Authorization: authHeader, Accept: 'application/json' },
    })
    expect(res.status).toBe(200)
    const doc = (await res.json()) as { openapi: string; info: { version: string } }
    expect(doc.openapi).toMatch(/^3\.1/)
    expect(doc.info.version).toBe(snapshot.info.version)
  })

  it('GET /config/providers returns providers array', async () => {
    const res = await fetch(`${baseUrl}/config/providers`, {
      headers: { Authorization: authHeader, Accept: 'application/json' },
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { providers: unknown[] }
    expect(Array.isArray(body.providers)).toBe(true)
  })

  it('GET /session returns array (empty on fresh start)', async () => {
    const res = await fetch(`${baseUrl}/session`, {
      headers: { Authorization: authHeader, Accept: 'application/json' },
    })
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(Array.isArray(body)).toBe(true)
  })

  it('GET /event returns SSE stream with server.connected as first event', async () => {
    const controller = new AbortController()
    const res = await fetch(`${baseUrl}/event`, {
      headers: { Authorization: authHeader, Accept: 'text/event-stream' },
      signal: controller.signal,
    })
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toContain('text/event-stream')

    // Read just the first event
    const reader = res.body!.getReader()
    const decoder = new TextDecoder()
    let buf = ''
    let firstEvent: { type: string } | null = null

    while (!firstEvent) {
      const { done, value } = await reader.read()
      if (done) break
      buf += decoder.decode(value, { stream: true })
      // Look for double-newline boundary
      const idx = buf.indexOf('\n\n')
      if (idx >= 0) {
        const block = buf.slice(0, idx)
        for (const line of block.split('\n')) {
          if (line.startsWith('data:')) {
            firstEvent = JSON.parse(line.slice(5).trim())
          }
        }
      }
    }

    controller.abort()
    reader.releaseLock()

    expect(firstEvent).not.toBeNull()
    expect(firstEvent!.type).toBe('server.connected')
  }, 10_000)

  it('event type strings match snapshot', () => {
    // The snapshot's knownEventTypes is our contract. Validate it's non-empty
    // and contains the types we depend on for 5b.
    expect(snapshot.knownEventTypes).toContain('server.connected')
    expect(snapshot.knownEventTypes).toContain('message.part.updated')
    expect(snapshot.knownEventTypes).toContain('permission.asked')
    expect(snapshot.knownEventTypes).toContain('session.created')
  })

  it('v1 operation IDs listed in snapshot exist in /doc', async () => {
    const res = await fetch(`${baseUrl}/doc`, {
      headers: { Authorization: authHeader, Accept: 'application/json' },
    })
    const doc = (await res.json()) as {
      paths: Record<string, Record<string, { operationId?: string }>>
    }

    const allOpIds = new Set<string>()
    for (const methods of Object.values(doc.paths)) {
      for (const op of Object.values(methods)) {
        if (op.operationId) allOpIds.add(op.operationId)
      }
    }

    for (const opId of snapshot.v1OperationIds) {
      expect(allOpIds, `operationId "${opId}" should exist in /doc`).toContain(opId)
    }
  })
})
