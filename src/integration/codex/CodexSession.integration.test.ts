/**
 * Integration test for CodexSession — spawns the real codex app-server binary.
 *
 * Gated behind CODEX_INTEGRATION_TESTS=1 (same pattern as CLAUDE_INTEGRATION_TESTS
 * used in sdk-contract/event-sequences.integration.test.ts).
 *
 * Run with:
 *   CODEX_INTEGRATION_TESTS=1 bun run test:integration
 *
 * The test runs a trivial read-only turn ("reply OK") and asserts that the
 * session emits at least one session:stream text event followed by a
 * session:result event.
 *
 * Excluded from default `bun run test` — only runs under the `integration`
 * vitest project, which requires explicit CODEX_INTEGRATION_TESTS=1.
 */

// @vitest-environment node

import { describe, it, expect } from 'vitest'

const SKIP = !process.env.CODEX_INTEGRATION_TESTS

describe('CodexSession integration', () => {
  describe.skipIf(SKIP)('real codex app-server', () => {
    it('runs a trivial read-only turn and emits stream + result', async () => {
      // Dynamic import to avoid loading electron/CodexSession when skipped
      const { CodexSession } = await import('../../main/codex/CodexSession')

      // Mock BrowserWindow — we capture sends via a spy
      const sentEvents: Array<{ channel: string; routingId: string; data: unknown }> = []

      const fakeWin = {
        isDestroyed: () => false,
        webContents: {
          send: (channel: string, routingId: string, data: unknown) => {
            sentEvents.push({ channel, routingId, data })
          },
        },
      } as unknown as import('electron').BrowserWindow

      const routingId = 'test-routing-id'
      const session = new CodexSession(
        routingId,
        fakeWin,
        process.cwd(),
        undefined, // effort
        undefined, // resumeSessionId
        'acceptEdits', // permissionMode — workspace-write, non-interactive
      )

      // Collect session:result
      let resultReceived = false
      let streamReceived = false

      // Override send to observe events (inject spy after construction)
      const originalEmitMapped = (session as unknown as Record<string, unknown>).emitMapped
      void originalEmitMapped

      // Run the prompt and wait for result
      const runPromise = session.run('Reply with only the word OK, nothing else.')

      // Wait up to 60s for result
      await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => {
          reject(new Error('Timed out waiting for session:result'))
        }, 60_000)

        const checkInterval = setInterval(() => {
          if (sentEvents.some((e) => e.channel === 'session:stream' && (e.data as Record<string, unknown>)?.type === 'text')) {
            streamReceived = true
          }
          if (sentEvents.some((e) => e.channel === 'session:result')) {
            resultReceived = true
            clearInterval(checkInterval)
            clearTimeout(timeout)
            resolve()
          }
        }, 100)

        runPromise.catch((err) => {
          clearInterval(checkInterval)
          clearTimeout(timeout)
          reject(err)
        })
      })

      session.cancel()

      expect(streamReceived).toBe(true)
      expect(resultReceived).toBe(true)

      // Verify result shape
      const resultEvent = sentEvents.find((e) => e.channel === 'session:result')
      expect(resultEvent).toBeDefined()
      const result = resultEvent?.data as Record<string, unknown>
      expect(typeof result.durationMs).toBe('number')
      expect(typeof result.totalCostUsd).toBe('number')
    }, 70_000)
  })
})
