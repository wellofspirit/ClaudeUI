/**
 * pi RPC integration smoke test.
 *
 * Gated: only runs when PI_INTEGRATION_TESTS=1. Uses the REAL vendored pi
 * binary — NOT included in default test / test:ci. Skips gracefully (not a
 * hard failure) if vendor/pi-cli is missing even when the env var is set.
 *
 * Deliberately hand-rolls the raw JSONL send/receive protocol here rather than
 * reusing PiRpcClient — mirrors opencode-server.integration.test.ts's own
 * precedent (test the WIRE directly, independent of our own client code, so a
 * wrong assumption is caught even if a bug in PiRpcClient would compensate for it).
 *
 * NO credentials, NO model calls: only get_state / get_commands are sent — pi
 * reports its "unknown" placeholder model (verified doc drift, see
 * docs/protocol-pi/README.md) without ever touching ~/.pi/agent/auth.json.
 * `--no-session` additionally means NOTHING is written to ~/.pi/agent/sessions.
 *
 * Run manually:
 *   PI_INTEGRATION_TESTS=1 bunx vitest run --project integration -t pi
 */

// @vitest-environment node

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ChildProcess } from 'node:child_process'
import { PI_BRIDGE_EXTENSION_SOURCE } from '../../core/pi/pi-bridge-source'

const SKIP = !process.env.PI_INTEGRATION_TESTS
const BINARY_NAME = process.platform === 'win32' ? 'pi.exe' : 'pi'
const ROOT = join(__dirname, '..', '..', '..')

function findBinary(): string | null {
  const candidate = join(ROOT, 'vendor', 'pi-cli', BINARY_NAME)
  return existsSync(candidate) ? candidate : null
}

// Evaluated once at collection time (synchronous fs check) so every `it` in
// this file can gate on it via it.skipIf — "skip gracefully if vendor/pi-cli
// missing" even when PI_INTEGRATION_TESTS=1 is set.
const BINARY_MISSING = !findBinary()

/** Tiny extension fixture: registers a `/claudeui-probe` command with no
 *  external imports (type-only imports would need @earendil-works/pi-coding-agent
 *  resolvable, which isn't a ClaudeUI dependency — see the M1 kickoff spec's
 *  licence-hygiene note: re-derive shapes, don't paste from pi's source). */
const PROBE_EXTENSION_SOURCE = `
export default function claudeuiProbeExtension(pi) {
  pi.registerCommand('claudeui-probe', {
    description: 'ClaudeUI integration probe command',
    handler: async () => {}
  })
}
`

describe.skipIf(SKIP)('pi RPC smoke', () => {
  let proc: ChildProcess | null = null
  let tmpDir: string
  let stdoutBuffer = ''
  const allLines: string[] = []
  const pending = new Map<string, (resp: Record<string, unknown>) => void>()
  let nextId = 1

  function attachStdoutHandler(p: ChildProcess): void {
    p.stdout?.setEncoding('utf-8')
    p.stdout?.on('data', (chunk: string) => {
      stdoutBuffer += chunk
      const lines = stdoutBuffer.split('\n')
      stdoutBuffer = lines.pop() ?? ''
      for (const raw of lines) {
        const line = raw.endsWith('\r') ? raw.slice(0, -1) : raw
        if (!line) continue
        allLines.push(line)
        let obj: Record<string, unknown>
        try {
          obj = JSON.parse(line)
        } catch {
          continue // stdout-purity is asserted explicitly below; don't throw here
        }
        const id = obj.id as string | undefined
        if (obj.type === 'response' && id && pending.has(id)) {
          const resolve = pending.get(id)!
          pending.delete(id)
          resolve(obj)
        }
      }
    })
  }

  function sendCommand(cmd: Record<string, unknown>, timeoutMs = 20_000): Promise<Record<string, unknown>> {
    const id = `probe-${nextId++}`
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id)
        reject(new Error(`timeout waiting for response to ${String(cmd.type)}`))
      }, timeoutMs)
      pending.set(id, (resp) => {
        clearTimeout(timer)
        resolve(resp)
      })
      proc!.stdin!.write(JSON.stringify({ ...cmd, id }) + '\n')
    })
  }

  beforeAll(async () => {
    if (BINARY_MISSING) return
    const binary = findBinary()!

    tmpDir = mkdtempSync(join(tmpdir(), 'pi-rpc-integration-'))
    const extensionPath = join(tmpDir, 'claudeui-probe-extension.ts')
    writeFileSync(extensionPath, PROBE_EXTENSION_SOURCE, 'utf-8')

    proc = spawn(binary, ['--mode', 'rpc', '--no-session', '-e', extensionPath], {
      cwd: tmpDir,
      stdio: ['pipe', 'pipe', 'pipe']
    })
    attachStdoutHandler(proc)
    proc.stderr?.setEncoding('utf-8')

    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('pi process did not spawn within 15s')), 15_000)
      proc!.once('spawn', () => {
        clearTimeout(timer)
        resolve()
      })
      proc!.once('error', (err) => {
        clearTimeout(timer)
        reject(err)
      })
    })
  }, 20_000)

  afterAll(async () => {
    if (proc && proc.exitCode === null && proc.signalCode === null) {
      const exited = new Promise<void>((resolve) => proc!.once('exit', () => resolve()))
      proc.kill('SIGTERM')
      // Windows holds the cwd handle briefly after the parent process exits
      // (bash sub-children under the `bash` tool release it slightly later) —
      // wait, with a bounded fallback, before touching the tmp dir.
      await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 3_000))])
    }
    if (tmpDir) {
      // maxRetries/retryDelay absorb the transient EPERM Windows can still
      // raise for a moment after the process handle closes.
      rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
    }
  })

  it.skipIf(BINARY_MISSING)('get_state round-trips with the expected shape', async () => {
    const resp = await sendCommand({ type: 'get_state' })
    expect(resp.type).toBe('response')
    expect(resp.command).toBe('get_state')
    expect(resp.success).toBe(true)
    const data = resp.data as Record<string, unknown>
    expect(data).toBeTruthy()
    expect(typeof data.isStreaming).toBe('boolean')
    // No credentials configured for this probe — verified doc drift: pi
    // returns a placeholder Model object, never null.
    const model = data.model as Record<string, unknown>
    expect(model).toBeTruthy()
    expect(typeof model.id).toBe('string')
  })

  it.skipIf(BINARY_MISSING)('the -e probe extension registers a command visible in get_commands', async () => {
    const resp = await sendCommand({ type: 'get_commands' })
    expect(resp.success).toBe(true)
    const data = resp.data as { commands: Array<{ name: string; source: string }> }
    const found = data.commands.find((c) => c.name === 'claudeui-probe')
    expect(found).toBeDefined()
    expect(found?.source).toBe('extension')
  })

  it.skipIf(BINARY_MISSING)(
    'set_thinking_level responds with a well-formed envelope, no model configured (M2b)',
    async () => {
      // No credentials in this probe's isolated tmpDir — pi has no model to
      // apply a thinking level TO. We deliberately assert only shape here
      // (success is a boolean, no crash/hang) and document what's actually
      // observed rather than assume success or failure.
      const resp = await sendCommand({ type: 'set_thinking_level', level: 'low' })
      expect(resp.type).toBe('response')
      expect(resp.command).toBe('set_thinking_level')
      expect(typeof resp.success).toBe('boolean')
      if (!resp.success) {
        expect(typeof resp.error === 'string' || resp.error === undefined).toBe(true)
      }
    }
  )

  it.skipIf(BINARY_MISSING)('stdout purity: every line emitted across the whole exchange parses as JSON', () => {
    expect(allLines.length).toBeGreaterThan(0)
    for (const line of allLines) {
      expect(() => JSON.parse(line)).not.toThrow()
    }
  })
})

/**
 * Shared-skills discovery smoke test (M3). Spawns the REAL ClaudeUI bridge
 * extension (PI_BRIDGE_EXTENSION_SOURCE, not a probe fixture) with
 * CLAUDEUI_PI_SKILL_DIRS pointing at a tmp fixture skill dir — no
 * CLAUDEUI_PI_BRIDGE_URL/TOKEN set, proving the resources_discover handler
 * activates independently of the approval-bridge gate (see
 * pi-bridge-source.ts's env-var-independence design). NO credentials, NO
 * model call: get_commands works unauthenticated (verified by the sibling
 * 'pi RPC smoke' describe block above), so this belongs in the
 * non-credential-gated file per the M3 kickoff spec.
 */
describe.skipIf(SKIP)('pi RPC smoke — shared skills (M3)', () => {
  let proc: ChildProcess | null = null
  let tmpDir: string
  let stdoutBuffer = ''
  const pending = new Map<string, (resp: Record<string, unknown>) => void>()
  let nextId = 1

  function attachStdoutHandler(p: ChildProcess): void {
    p.stdout?.setEncoding('utf-8')
    p.stdout?.on('data', (chunk: string) => {
      stdoutBuffer += chunk
      const lines = stdoutBuffer.split('\n')
      stdoutBuffer = lines.pop() ?? ''
      for (const raw of lines) {
        const line = raw.endsWith('\r') ? raw.slice(0, -1) : raw
        if (!line) continue
        let obj: Record<string, unknown>
        try {
          obj = JSON.parse(line)
        } catch {
          continue
        }
        const id = obj.id as string | undefined
        if (obj.type === 'response' && id && pending.has(id)) {
          const resolve = pending.get(id)!
          pending.delete(id)
          resolve(obj)
        }
      }
    })
  }

  function sendCommand(cmd: Record<string, unknown>, timeoutMs = 20_000): Promise<Record<string, unknown>> {
    const id = `skills-probe-${nextId++}`
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id)
        reject(new Error(`timeout waiting for response to ${String(cmd.type)}`))
      }, timeoutMs)
      pending.set(id, (resp) => {
        clearTimeout(timer)
        resolve(resp)
      })
      proc!.stdin!.write(JSON.stringify({ ...cmd, id }) + '\n')
    })
  }

  beforeAll(async () => {
    if (BINARY_MISSING) return
    const binary = findBinary()!

    tmpDir = mkdtempSync(join(tmpdir(), 'pi-rpc-skills-integration-'))

    // Real bridge extension source, written verbatim — proves the SHIPPED
    // resources_discover handler works, not a hand-rolled stand-in.
    const extensionPath = join(tmpDir, 'claudeui-bridge.ts')
    writeFileSync(extensionPath, PI_BRIDGE_EXTENSION_SOURCE, 'utf-8')

    // Fixture skill: a SKILL.md dir under a fixture "skills" parent — mirrors
    // ~/.claude/skills/<name>/SKILL.md's shape (skills.md's discovery rule:
    // directories containing SKILL.md are discovered recursively).
    const skillsParent = join(tmpDir, 'fixture-claude-skills')
    const skillDir = join(skillsParent, 'claudeui-fixture-skill')
    mkdirSync(skillDir, { recursive: true })
    writeFileSync(
      join(skillDir, 'SKILL.md'),
      [
        '---',
        'name: claudeui-fixture-skill',
        'description: Fixture skill for the M3 shared-skills integration smoke test.',
        '---',
        '',
        '# Fixture skill',
        'Not meant to be invoked — existence alone proves discovery.'
      ].join('\n'),
      'utf-8'
    )

    proc = spawn(binary, ['--mode', 'rpc', '--no-session', '-e', extensionPath], {
      cwd: tmpDir,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: {
        ...process.env,
        // Deliberately NO CLAUDEUI_PI_BRIDGE_URL/TOKEN — proves independence.
        CLAUDEUI_PI_SKILL_DIRS: skillsParent
      }
    })
    attachStdoutHandler(proc)
    proc.stderr?.setEncoding('utf-8')

    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('pi process did not spawn within 15s')), 15_000)
      proc!.once('spawn', () => {
        clearTimeout(timer)
        resolve()
      })
      proc!.once('error', (err) => {
        clearTimeout(timer)
        reject(err)
      })
    })
  }, 20_000)

  afterAll(async () => {
    if (proc && proc.exitCode === null && proc.signalCode === null) {
      const exited = new Promise<void>((resolve) => proc!.once('exit', () => resolve()))
      proc.kill('SIGTERM')
      await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 3_000))])
    }
    if (tmpDir) {
      rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
    }
  })

  it.skipIf(BINARY_MISSING)(
    'get_commands lists skill:<fixture> when CLAUDEUI_PI_SKILL_DIRS points at it (no bridge URL/token needed)',
    async () => {
      const resp = await sendCommand({ type: 'get_commands' })
      expect(resp.success).toBe(true)
      const data = resp.data as { commands: Array<{ name: string; source: string }> }
      const found = data.commands.find((c) => c.name === 'skill:claudeui-fixture-skill')
      expect(found).toBeDefined()
      expect(found?.source).toBe('skill')
    }
  )
})
