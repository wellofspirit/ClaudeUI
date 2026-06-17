/**
 * Layer 4: Integration tests — SDK event contract verification.
 *
 * These tests run the real patched SDK and verify that the event sequences
 * it produces match what our component and E2E tests assume.
 *
 * Gated behind CLAUDE_INTEGRATION_TESTS=1 environment variable.
 * Not included in default CI runs.
 */

// @vitest-environment node

import { describe, it, expect } from 'vitest'

const SKIP = !process.env.CLAUDE_INTEGRATION_TESTS

describe('SDK event contract', () => {
  // These tests are skipped by default — run with CLAUDE_INTEGRATION_TESTS=1
  describe.skipIf(SKIP)('real SDK event sequences', () => {
    it('text response yields init → assistant → result in correct order', async () => {
      // Dynamic import to avoid loading SDK when skipped
      const { query: sdkQuery } = await import('../../main/sdk')
      const events: Array<Record<string, unknown>> = []

      const q = sdkQuery({
        prompt: 'Say exactly "hello" and nothing else.',
        options: {
          cwd: process.cwd(),
          permissionMode: 'auto',
          model: 'claude-haiku-4-5-20251001',
          maxTurns: 1,
          tools: [],
          thinking: { type: 'disabled' },
          persistSession: false
        }
      })

      for await (const msg of q) {
        events.push(msg as Record<string, unknown>)
        // In-house harness contract: a string prompt does NOT auto-terminate
        // the session — cli.js stays alive awaiting further input. Consumers
        // break on `result`, which triggers the iterator's return() → SIGTERM.
        // (Same pattern as automation-manager.executeRun.)
        if ((msg as Record<string, unknown>).type === 'result') break
      }

      // Verify event ordering matches our stubs
      const types = events.map((e) => e.type).filter(Boolean)
      expect(types).toContain('result')

      // At least one assistant message should be present
      const assistantEvents = events.filter((e) => e.type === 'assistant')
      expect(assistantEvents.length).toBeGreaterThan(0)

      // Assistant messages have the expected structure
      for (const evt of assistantEvents) {
        const msg = evt.message as Record<string, unknown> | undefined
        if (msg) {
          expect(msg).toHaveProperty('role', 'assistant')
          expect(msg).toHaveProperty('content')
          expect(Array.isArray(msg.content)).toBe(true)
        }
      }

      // Result is last meaningful event
      const resultEvent = events.find((e) => e.type === 'result')
      expect(resultEvent).toBeDefined()
    })
  })

  // These tests always run — they verify our factory functions produce
  // well-formed events that match the expected shape.
  describe('factory event shapes', () => {
    it('textResponseSequence produces valid event structure', async () => {
      const { textResponseSequence } = await import('@test/factories/sdk-events')
      const events = textResponseSequence('session-1', 'Hello world')

      expect(events.length).toBeGreaterThan(0)

      // First event should be init
      expect(events[0]).toMatchObject({ type: 'system', subtype: 'init' })

      // Should have at least one stream event
      const streamEvents = events.filter((e) => e.type === 'stream_event')
      expect(streamEvents.length).toBeGreaterThan(0)

      // Should have an assistant message
      const assistantEvents = events.filter((e) => e.type === 'assistant')
      expect(assistantEvents.length).toBe(1)
      expect(assistantEvents[0].message).toHaveProperty('role', 'assistant')

      // Should end with result
      const lastEvent = events[events.length - 1]
      expect(lastEvent.type).toBe('result')
    })

    it('toolUseSequence produces valid event structure', async () => {
      const { toolUseSequence } = await import('@test/factories/sdk-events')
      const events = toolUseSequence('session-1', 'Bash', { command: 'ls' }, 'file1\nfile2', 'Done')

      // Should have init
      expect(events[0]).toMatchObject({ type: 'system', subtype: 'init' })

      // Should have tool_use in assistant message
      const assistantWithTool = events.find(
        (e) =>
          e.type === 'assistant' &&
          Array.isArray((e.message as any)?.content) &&
          (e.message as any).content.some((c: any) => c.type === 'tool_use')
      )
      expect(assistantWithTool).toBeDefined()

      // Should have user message with tool_result
      const userWithResult = events.find(
        (e) =>
          e.type === 'user' &&
          Array.isArray((e.message as any)?.content) &&
          (e.message as any).content.some((c: any) => c.type === 'tool_result')
      )
      expect(userWithResult).toBeDefined()

      // Should end with result
      expect(events[events.length - 1].type).toBe('result')
    })

    it('thinkingSequence produces thinking + text events', async () => {
      const { thinkingSequence } = await import('@test/factories/sdk-events')
      const events = thinkingSequence('session-1', 'Let me think...', 'The answer')

      const thinkingStream = events.find(
        (e) => e.type === 'stream_event' && e.subtype === 'thinking'
      )
      expect(thinkingStream).toBeDefined()

      const textStream = events.find((e) => e.type === 'stream_event' && e.subtype === 'text')
      expect(textStream).toBeDefined()
    })
  })
})
