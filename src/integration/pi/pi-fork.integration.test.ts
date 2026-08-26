/**
 * pi fork ("branch off") integration GUARD test (M5c).
 *
 * This is the proof for M5c: PiSession.doStart()'s fork/clone choreography —
 * spawn resuming the SOURCE, then EITHER `fork {entryId}` (drop a later user
 * turn + everything after) OR `clone` (duplicate the active branch as-is,
 * when forking the LATEST message) — against the REAL vendored pi binary,
 * asserting the one guarantee the whole feature depends on: the SOURCE
 * session file is left byte-for-byte UNCHANGED by either operation, while a
 * brand-new, correctly-truncated session file is produced.
 *
 * Deliberately drives the raw wire via PiRpcClient (real product code, same
 * class PiSession uses) rather than constructing a full PiSession — mirrors
 * pi-rpc/pi-subagent/pi-hosted-tools.integration.test.ts's identical
 * "test the WIRE directly" precedent, and sidesteps PiSession's own
 * `findPiSessionFile` (which only ever scans the REAL `~/.pi/agent/sessions`
 * tree, never a `--session-dir` override — a separate, already-unit-tested
 * concern this file doesn't need to re-prove). PiSession's OWN choreography
 * (the exact clone/fork/get_state/set_model call sequence) is covered against
 * a MOCKED client in PiSession.test.ts's "PiSession fork (M5c)" describe
 * block; this file is the one place proving the REAL binary honors the wire
 * contract those mocks assume.
 *
 * ONE real 2-turn session is built once in `beforeAll` (2 real model calls,
 * kept to trivial "reply with exactly X" prompts) and REUSED by both the
 * fork-branch and clone-branch tests below — clone/fork themselves are pure
 * session-management RPCs, no further model calls needed, so total cost is
 * bounded to those 2 calls regardless of how many assertions run against the
 * fixture.
 *
 * Gated: PI_INTEGRATION_TESTS=1 AND a real `openai-codex` credential in
 * ~/.pi/agent/auth.json (read-only — this file never writes to it). Session
 * files land under a tmp `--session-dir` — NEVER ~/.pi/agent/sessions.
 *
 * Run manually:
 *   PI_INTEGRATION_TESTS=1 bunx vitest run --project integration -t pi
 */

// @vitest-environment node

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { existsSync, mkdtempSync, rmSync, readFileSync, readdirSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { tmpdir, homedir } from 'node:os'
import { join } from 'node:path'
import { PiRpcClient } from '../../core/pi/PiRpcClient'

const SKIP = !process.env.PI_INTEGRATION_TESTS
const BINARY_NAME = process.platform === 'win32' ? 'pi.exe' : 'pi'
const ROOT = join(__dirname, '..', '..', '..')
const MODEL = { provider: 'openai-codex', modelId: 'gpt-5.6-luna' }

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

const BINARY_MISSING = !findBinary()
const CREDENTIALS_MISSING = !hasCodexCredentials()

function sha256(filePath: string): string {
  return createHash('sha256').update(readFileSync(filePath)).digest('hex')
}

function listSessionFiles(dir: string): string[] {
  return readdirSync(dir)
    .filter((f) => f.endsWith('.jsonl'))
    .sort()
}

/** Minimal request/response client over a PiRpcClient — mirrors the other pi integration files' identical helper. */
function makeSender(client: PiRpcClient) {
  return (cmd: Record<string, unknown>, timeoutMs = 30_000) =>
    client.request(cmd as never, timeoutMs) as Promise<{
      success: boolean
      error?: string
      data?: Record<string, unknown>
    }>
}

describe.skipIf(SKIP || BINARY_MISSING || CREDENTIALS_MISSING)(
  'pi fork/clone integration (M5c)',
  () => {
    let tmpDir: string
    let sourceClient: PiRpcClient
    let sourceFile: string
    let sourceSessionId: string
    let firstUserEntryId: string
    let secondUserEntryId: string
    let sourceHashBaseline: string

    beforeAll(async () => {
      const binary = findBinary()!
      tmpDir = mkdtempSync(join(tmpdir(), 'pi-fork-integration-'))

      sourceClient = new PiRpcClient(binary, {
        cwd: tmpDir,
        args: ['--mode', 'rpc', '--session-dir', tmpDir]
      })
      await sourceClient.start()
      const send = makeSender(sourceClient)

      const setModelResp = await send(
        { type: 'set_model', provider: MODEL.provider, modelId: MODEL.modelId },
        45_000
      )
      expect(setModelResp.success, `set_model failed: ${JSON.stringify(setModelResp)}`).toBe(true)

      // Two trivial, deterministic turns — kept minimal per the M5c kickoff spec.
      const turn1 = await send({ type: 'prompt', message: 'Reply with exactly: TURN ONE' }, 60_000)
      expect(turn1.success, `turn 1 prompt failed: ${JSON.stringify(turn1)}`).toBe(true)
      await waitForSettled(sourceClient)

      const turn2 = await send({ type: 'prompt', message: 'Reply with exactly: TURN TWO' }, 60_000)
      expect(turn2.success, `turn 2 prompt failed: ${JSON.stringify(turn2)}`).toBe(true)
      await waitForSettled(sourceClient)

      const state = await send({ type: 'get_state' })
      expect(state.success).toBe(true)
      sourceSessionId = state.data!.sessionId as string
      sourceFile = state.data!.sessionFile as string

      const forkMessages = await send({ type: 'get_fork_messages' })
      expect(forkMessages.success).toBe(true)
      const messages =
        (forkMessages.data!.messages as Array<{ entryId: string; text: string }>) ?? []
      expect(messages.length).toBe(2)
      firstUserEntryId = messages[0].entryId
      secondUserEntryId = messages[1].entryId

      // Fully dispose the source client and give Windows a moment to release
      // the file handle before hashing — mirrors the other pi integration
      // files' identical afterAll precedent, done here mid-test instead since
      // later `it`s need the file untouched from this exact point on.
      sourceClient.dispose()
      await new Promise((resolve) => setTimeout(resolve, 1_000))

      sourceHashBaseline = sha256(sourceFile)
    }, 180_000)

    afterAll(async () => {
      if (tmpDir) rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
    })

    /** Poll for `agent_settled` on a fresh listener — the real turn-complete signal. */
    async function waitForSettled(client: PiRpcClient, timeoutMs = 60_000): Promise<void> {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(
          () => reject(new Error('timed out waiting for agent_settled')),
          timeoutMs
        )
        const unsubscribe = client.onEvent((ev) => {
          if (ev.type === 'agent_settled') {
            clearTimeout(timer)
            unsubscribe()
            resolve()
          }
        })
      })
    }

    it.skipIf(BINARY_MISSING || CREDENTIALS_MISSING)(
      'fork {entryId} on a resumed source — drops the second turn, creates a new file, source stays byte-unchanged',
      async () => {
        const binary = findBinary()!
        const client = new PiRpcClient(binary, {
          cwd: tmpDir,
          args: ['--mode', 'rpc', '--session-dir', tmpDir, '--session', sourceFile]
        })
        await client.start()
        const send = makeSender(client)
        try {
          const resumedState = await send({ type: 'get_state' })
          expect(resumedState.success).toBe(true)
          expect(resumedState.data!.sessionId).toBe(sourceSessionId)

          const filesBefore = listSessionFiles(tmpDir)

          // Drop the SECOND turn — mirrors PiSession.doStart's fork block:
          // `fork {entryId}` directly, no preceding `clone`.
          const forkResp = await send({ type: 'fork', entryId: secondUserEntryId })
          expect(forkResp.success, `fork failed: ${JSON.stringify(forkResp)}`).toBe(true)
          expect((forkResp.data as { cancelled?: boolean } | undefined)?.cancelled).toBe(false)

          const forkedState = await send({ type: 'get_state' })
          expect(forkedState.success).toBe(true)
          expect(forkedState.data!.sessionId).not.toBe(sourceSessionId)
          // Only the first turn (1 user + 1 assistant message) survives.
          expect(forkedState.data!.messageCount).toBe(2)

          const filesAfter = listSessionFiles(tmpDir)
          const newFiles = filesAfter.filter((f) => !filesBefore.includes(f))
          expect(newFiles.length).toBe(1)

          // THE proof: the source file this test resumed from is untouched.
          expect(sha256(sourceFile)).toBe(sourceHashBaseline)
        } finally {
          client.dispose()
          await new Promise((resolve) => setTimeout(resolve, 500))
        }
      },
      90_000
    )

    it.skipIf(BINARY_MISSING || CREDENTIALS_MISSING)(
      'clone-latest sentinel path: `clone` alone on a resumed source — keeps everything, creates a new file, source stays byte-unchanged',
      async () => {
        const binary = findBinary()!
        const client = new PiRpcClient(binary, {
          cwd: tmpDir,
          args: ['--mode', 'rpc', '--session-dir', tmpDir, '--session', sourceFile]
        })
        await client.start()
        const send = makeSender(client)
        try {
          await send({ type: 'get_state' })
          const filesBefore = listSessionFiles(tmpDir)

          const cloneResp = await send({ type: 'clone' })
          expect(cloneResp.success, `clone failed: ${JSON.stringify(cloneResp)}`).toBe(true)
          expect((cloneResp.data as { cancelled?: boolean } | undefined)?.cancelled).toBe(false)

          const clonedState = await send({ type: 'get_state' })
          expect(clonedState.success).toBe(true)
          expect(clonedState.data!.sessionId).not.toBe(sourceSessionId)
          // Both turns survive — clone duplicates the FULL active branch.
          expect(clonedState.data!.messageCount).toBe(4)

          const filesAfter = listSessionFiles(tmpDir)
          const newFiles = filesAfter.filter((f) => !filesBefore.includes(f))
          expect(newFiles.length).toBe(1)

          expect(sha256(sourceFile)).toBe(sourceHashBaseline)
        } finally {
          client.dispose()
          await new Promise((resolve) => setTimeout(resolve, 500))
        }
      },
      90_000
    )

    it.skipIf(BINARY_MISSING || CREDENTIALS_MISSING)(
      'sanity: the two turns really did produce two distinct user entries to fork between',
      () => {
        expect(firstUserEntryId).not.toBe(secondUserEntryId)
      }
    )
  }
)
